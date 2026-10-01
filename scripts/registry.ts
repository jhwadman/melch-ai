#!/usr/bin/env node
/**
 * scripts/registry.ts — the `melchizedek-registry` bin and `npm run registry -- <command>`.
 * Publish, roll back and inspect agents in the versioned registry
 * (lib/registry.ts, migration 0005_agent_registry.sql, ADR 0018).
 *
 *   list                              every published id and its active version
 *   versions <id>                     the history of one id, newest first
 *   show <id>[@<version>]             a definition as YAML (default: the active one)
 *   diff <id> <a> [<b>]               line diff between two versions (b: the active one)
 *   publish <file> <id> [--note ""]   validate a YAML file and make it the active version
 *   rollback <id> <version> [--note ""]  make a stored version active again
 *   retire <id> --yes                 stop serving an id; its history stays
 *
 * Needs SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (the service role: the
 * registry is locked to it). The author recorded on a version is
 * MELCHIZEDEK_REGISTRY_AUTHOR, else the local user name. A running server
 * caches each agent for its lifetime: restart it after publish or rollback.
 * Never prints a credential.
 */

import { readFileSync, realpathSync } from 'node:fs';
import { userInfo } from 'node:os';
import { fileURLToPath } from 'node:url';

import { createClient } from '@supabase/supabase-js';
import { parse, stringify } from 'yaml';

import { loadEnv } from '../lib/loadEnv.ts';
import {
  activateVersion,
  getVersion,
  listAgents,
  listVersions,
  parseRegistryRef,
  publishAgent,
  retireAgent,
  type RegistryClient,
} from '../lib/registry.ts';

const USAGE = `usage: melchizedek-registry <command>
  list
  versions <id>
  show <id>[@<version>]
  diff <id> <a> [<b>]
  publish <file> <id> [--note "why"]
  rollback <id> <version> [--note "why"]
  retire <id> --yes`;

/** A minimal line diff (longest common subsequence), for two YAML texts. */
export function lineDiff(a: string, b: string): string[] {
  const x = a.split('\n');
  const y = b.split('\n');
  const n = x.length;
  const m = y.length;
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i]![j] = x[i] === y[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
    }
  }
  const out: string[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (x[i] === y[j]) {
      i++;
      j++;
    } else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) out.push(`- ${x[i++]}`);
    else out.push(`+ ${y[j++]}`);
  }
  while (i < n) out.push(`- ${x[i++]}`);
  while (j < m) out.push(`+ ${y[j++]}`);
  return out;
}

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
}

export async function main(argv: string[], client?: RegistryClient): Promise<number> {
  const args = argv.filter((a) => a !== '--');
  const [cmd, ...rest] = args;
  const positional = rest.filter((a, i) => !a.startsWith('--') && rest[i - 1] !== '--note');
  if (!cmd || cmd === 'help' || cmd === '--help') {
    console.log(USAGE);
    return cmd ? 0 : 1;
  }

  if (!client) {
    loadEnv(import.meta.url);
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !key) {
      console.error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required (the registry is locked to the service role).');
      return 1;
    }
    client = createClient(url, key) as unknown as RegistryClient;
  }
  const author = process.env.MELCHIZEDEK_REGISTRY_AUTHOR?.trim() || userInfo().username;
  const note = flag(rest, '--note');

  switch (cmd) {
    case 'list': {
      const rows = await listAgents(client);
      for (const r of rows) {
        console.log(`${r.id.padEnd(28)} v${String(r.version ?? '?').padEnd(4)} ${(r.publishedAt ?? '').slice(0, 19)}  ${r.publishedBy ?? ''}`);
      }
      console.log(`${rows.length} active id(s)`);
      return 0;
    }
    case 'versions': {
      const [id] = positional;
      if (!id) break;
      const rows = await listVersions(client, id);
      if (!rows.length) {
        console.error(`No versions of ${id}.`);
        return 1;
      }
      for (const r of rows) {
        console.log(`${r.active ? '*' : ' '} v${String(r.version).padEnd(4)} ${r.publishedAt.slice(0, 19)}  ${r.configHash.slice(0, 12)}  ${r.publishedBy}${r.note ? ` — ${r.note}` : ''}`);
      }
      if (!rows.some((r) => r.active)) console.log('  (retired: no version is active)');
      return 0;
    }
    case 'show': {
      const [ref] = positional;
      if (!ref) break;
      const { id, version } = parseRegistryRef(ref);
      const v = version ?? (await listVersions(client, id)).find((r) => r.active)?.version;
      if (!v) {
        console.error(`${id} has no active version.`);
        return 1;
      }
      process.stdout.write(stringify(await getVersion(client, id, v)));
      return 0;
    }
    case 'diff': {
      const [id, a, b] = positional;
      if (!id || !a) break;
      const to = b ? Number(b) : (await listVersions(client, id)).find((r) => r.active)?.version;
      if (!to) {
        console.error(`${id} has no active version to compare with.`);
        return 1;
      }
      const lines = lineDiff(stringify(await getVersion(client, id, Number(a))), stringify(await getVersion(client, id, to)));
      console.log(`--- ${id}@${a}\n+++ ${id}@${to}`);
      console.log(lines.length ? lines.join('\n') : '(identical)');
      return 0;
    }
    case 'publish': {
      const [file, id] = positional;
      if (!file || !id) break;
      const config = parse(readFileSync(file, 'utf-8'));
      const v = await publishAgent(client, id, config, { author, note });
      console.log(`${id} is at v${v}. Restart the server to serve it.`);
      return 0;
    }
    case 'rollback': {
      const [id, version] = positional;
      if (!id || !version) break;
      const v = await activateVersion(client, id, Number(version), { author, note });
      console.log(`${id} is at v${v}. Restart the server to serve it.`);
      return 0;
    }
    case 'retire': {
      const [id] = positional;
      if (!id) break;
      if (!rest.includes('--yes')) {
        console.error(`This stops serving ${id} (its history stays). Re-run with --yes.`);
        return 1;
      }
      console.log((await retireAgent(client, id)) ? `${id} retired. Restart the server.` : `${id} was not active.`);
      return 0;
    }
  }
  console.error(USAGE);
  return 1;
}

const invoked = process.argv[1] ? realpathSync(process.argv[1]) : '';
if (invoked === realpathSync(fileURLToPath(import.meta.url))) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err: unknown) => {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    },
  );
}
