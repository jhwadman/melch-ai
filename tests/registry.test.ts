/**
 * tests/registry.test.ts — lib/registry.ts and the melchizedek-registry CLI,
 * offline, against a fake client. The SQL itself (versions, rollback,
 * append-only history) is exercised against Postgres in
 * tests/postgresStorage.test.ts.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  activateVersion,
  listVersions,
  parseRegistryRef,
  publishAgent,
  retireAgent,
  type RegistryClient,
} from '../lib/registry.ts';
import { lineDiff, main } from '../scripts/registry.ts';

const VALID = {
  syndicate_name: 'Alpha',
  orchestrator: { name: 'Lead', model: 'gemini-3.8-flash', instruction: 'Answer.' },
};

interface Call {
  fn: string;
  args: Record<string, unknown>;
}

/** A client that records rpc calls and serves `from()` reads from fixtures. */
function fakeClient(opts: {
  rpc?: (fn: string, args: Record<string, unknown>) => { data: unknown; error: { message: string; code?: string } | null };
  tables?: Record<string, any[]>;
} = {}): RegistryClient & { calls: Call[]; deleted: string[] } {
  const calls: Call[] = [];
  const deleted: string[] = [];
  const tables = opts.tables ?? {};
  const query = (table: string) => {
    let rows = [...(tables[table] ?? [])];
    let del = false;
    const q: any = {
      select: () => q,
      delete: () => ((del = true), q),
      eq: (col: string, val: unknown) => ((rows = rows.filter((r) => r[col] === val)), q),
      order: (col: string, o: { ascending: boolean }) => ((rows = rows.sort((a, b) => (o.ascending ? 1 : -1) * (a[col] > b[col] ? 1 : -1))), q),
      maybeSingle: async () => ({ data: rows[0] ?? null, error: null }),
      then: (resolve: (v: unknown) => void) => {
        if (del) for (const r of rows) deleted.push(r.id);
        resolve({ data: rows, error: null });
      },
    };
    return q;
  };
  return {
    calls,
    deleted,
    rpc: async (fn, args) => {
      calls.push({ fn, args });
      return opts.rpc ? opts.rpc(fn, args) : { data: 7, error: null };
    },
    from: query,
  };
}

test('parseRegistryRef: <id>@<version> pins a version, a bare id does not', () => {
  assert.deepEqual(parseRegistryRef('alpha@3'), { id: 'alpha', version: 3 });
  assert.deepEqual(parseRegistryRef('alpha'), { id: 'alpha' });
  assert.deepEqual(parseRegistryRef('a.b-c_d@12'), { id: 'a.b-c_d', version: 12 });
});

test('publishAgent validates before writing and passes author and note', async () => {
  const c = fakeClient();
  assert.equal(await publishAgent(c, 'alpha', VALID, { author: 'alice', note: 'tighter' }), 7);
  assert.equal(c.calls.length, 1);
  assert.equal(c.calls[0]!.fn, 'melchizedek_registry_publish');
  assert.deepEqual(c.calls[0]!.args, { p_id: 'alpha', p_config: VALID, p_author: 'alice', p_note: 'tighter' });
});

test('publishAgent refuses an invalid definition without touching the database', async () => {
  const c = fakeClient();
  await assert.rejects(publishAgent(c, 'alpha', { syndicate_name: 'No orchestrator' }), /registry:alpha/);
  assert.equal(c.calls.length, 0);
});

test('publishAgent refuses an unsafe id', async () => {
  const c = fakeClient();
  await assert.rejects(publishAgent(c, '../etc', VALID), /Invalid registry id/);
  await assert.rejects(publishAgent(c, 'has space', VALID), /Invalid registry id/);
  assert.equal(c.calls.length, 0);
});

test('a database without migration 0005 gets the remedy, not a raw error', async () => {
  const c = fakeClient({ rpc: () => ({ data: null, error: { message: 'Could not find the function public.melchizedek_registry_publish', code: 'PGRST202' } }) });
  await assert.rejects(publishAgent(c, 'alpha', VALID), /npm run db -- apply.*0005_agent_registry/);
});

test('activateVersion re-validates the stored definition, then activates it', async () => {
  const c = fakeClient({
    rpc: () => ({ data: 2, error: null }),
    tables: { adk_agent_registry_versions: [{ id: 'alpha', version: 2, yaml_content: VALID }] },
  });
  assert.equal(await activateVersion(c, 'alpha', 2, { author: 'bob' }), 2);
  assert.equal(c.calls[0]!.fn, 'melchizedek_registry_activate');
  assert.deepEqual(c.calls[0]!.args, { p_id: 'alpha', p_version: 2, p_author: 'bob', p_note: null });

  const stale = fakeClient({ tables: { adk_agent_registry_versions: [{ id: 'alpha', version: 1, yaml_content: { syndicate_name: 'old' } }] } });
  await assert.rejects(activateVersion(stale, 'alpha', 1), /registry:alpha@1/);
  assert.equal(stale.calls.length, 0, 'an invalid stored version is never activated');
  await assert.rejects(activateVersion(c, 'alpha', 0), /Invalid version/);
});

test('listVersions marks the active version', async () => {
  const c = fakeClient({
    tables: {
      adk_agent_registry_versions: [
        { id: 'alpha', version: 1, config_hash: 'aa', published_by: 'm', published_at: '2026-10-01T00:00:00Z', note: null },
        { id: 'alpha', version: 2, config_hash: 'bb', published_by: 'a', published_at: '2026-10-01T01:00:00Z', note: 'n' },
      ],
      adk_agent_registry: [{ id: 'alpha', version: 1 }],
    },
  });
  const rows = await listVersions(c, 'alpha');
  assert.deepEqual(rows.map((r) => [r.version, r.active]), [[2, false], [1, true]]);
});

test('retireAgent removes only the active row', async () => {
  const c = fakeClient({ tables: { adk_agent_registry: [{ id: 'alpha' }, { id: 'beta' }] } });
  assert.equal(await retireAgent(c, 'alpha'), true);
  assert.deepEqual(c.deleted, ['alpha']);
});

test('lineDiff shows removed and added lines only', () => {
  assert.deepEqual(lineDiff('a\nb\nc', 'a\nB\nc'), ['- b', '+ B']);
  assert.deepEqual(lineDiff('same', 'same'), []);
});

test('the CLI refuses retire without --yes and publishes a file with a note', async () => {
  const c = fakeClient();
  const log = console.log;
  const err = console.error;
  const out: string[] = [];
  console.log = (s: string) => out.push(String(s));
  console.error = (s: string) => out.push(String(s));
  try {
    assert.equal(await main(['retire', 'alpha'], c), 1);
    assert.ok(out.some((l) => /--yes/.test(l)));
    assert.equal(await main(['publish', 'config/agents/examples/assistant.yaml', 'assistant', '--note', 'from the pack'], c), 0);
    const call = c.calls.find((x) => x.fn === 'melchizedek_registry_publish')!;
    assert.equal(call.args.p_id, 'assistant');
    assert.equal(call.args.p_note, 'from the pack');
    assert.ok(out.some((l) => /assistant is at v7/.test(l)));
    assert.equal(await main([], c), 1);
  } finally {
    console.log = log;
    console.error = err;
  }
});
