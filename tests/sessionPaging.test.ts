/**
 * tests/sessionPaging.test.ts — the list paging contract on the Supabase
 * session service, through both of its faces: ADK's `listSessions` and the
 * engine's `list` (lib/runtime/sessions.ts, ADR 0058).
 *
 * A request carries `limit` with either `page` (1-based, takes precedence)
 * or `offset` (0-based), plus an optional sort, and the response must report
 * page/limit/totalItems/totalPages. The window is pushed down to Postgres,
 * so what this guards is the arithmetic between the request and the
 * .range() call — the part that silently returns the wrong slice when it is
 * wrong — and the filters and order sent with it.
 *
 * No network: the Supabase client is a recording stub.
 */

import { test } from 'node:test';
import assert from 'node:assert';

import { SupabaseSessionService } from '../lib/session/supabaseSessionService.ts';
import { listPage } from '../lib/runtime/sessions.ts';

interface Recorded {
  range?: [number, number];
  /** Every .order() call, in order. */
  order: Array<{ column: string; ascending: boolean }>;
  /** Every .eq() filter, in order. */
  eq: Array<[string, unknown]>;
  countRequested: boolean;
}

/** Minimal thenable stand-in for the chainable query builder. */
function stubClient(rows: unknown[], total: number): { client: any; seen: Recorded } {
  const seen: Recorded = { countRequested: false, order: [], eq: [] };
  const builder: any = {
    select: (_cols: string, opts?: { count?: string }) => {
      seen.countRequested = opts?.count === 'exact';
      return builder;
    },
    eq: (column: string, value: unknown) => {
      seen.eq.push([column, value]);
      return builder;
    },
    order: (column: string, opts: { ascending: boolean }) => {
      seen.order.push({ column, ascending: opts.ascending });
      return builder;
    },
    range: (from: number, to: number) => {
      seen.range = [from, to];
      return builder;
    },
    then: (resolve: (v: unknown) => void) =>
      resolve({ data: rows, error: null, count: total }),
  };
  return { client: { from: () => builder }, seen };
}

const row = (id: string, user = 'user', app = 'app') => ({
  id: `${app}:${user}:${id}`,
  app_name: app,
  user_id: user,
  state: {},
  last_update_time: 1,
});

const figures = (res: { page: number; limit: number; totalItems: number; totalPages: number }) => ({
  page: res.page,
  limit: res.limit,
  totalItems: res.totalItems,
  totalPages: res.totalPages,
});

test('listSessions: no paging asked for means one page of everything, in the order rows were created', async () => {
  const { client, seen } = stubClient([row('a'), row('b')], 2);
  const service = new SupabaseSessionService(client);

  const res = await service.listSessions({ appName: 'app', userId: 'user' });

  assert.equal(res.sessions.length, 2);
  assert.equal(res.sessions[0].id, 'a', 'the composite key is unwrapped');
  assert.equal(res.sessions[0].lastUpdateTime, 1);
  assert.deepEqual(figures(res), { page: 1, limit: 2, totalItems: 2, totalPages: 1 }, 'limit equals totalItems when none was requested');
  assert.equal(seen.range, undefined, 'no window is pushed down');
  assert.ok(seen.countRequested);
  assert.deepEqual(seen.eq, [['app_name', 'app'], ['user_id', 'user']]);
  assert.deepEqual(
    seen.order,
    [{ column: 'created_at', ascending: true }, { column: 'id', ascending: true }],
    'a page never depends on how Postgres happens to scan',
  );
});

test('listSessions: page wins over offset, totals describe the whole set, and ties order by id', async () => {
  const { client, seen } = stubClient([row('c')], 25);
  const service = new SupabaseSessionService(client);

  const res = await service.listSessions({
    appName: 'app',
    userId: 'user',
    limit: 10,
    page: 3,
    offset: 99, // ignored: page takes precedence
    order: 'desc',
  });

  assert.deepEqual(seen.range, [20, 29], 'page 3 of 10 is rows 20–29');
  assert.deepEqual(seen.order, [
    { column: 'last_update_time', ascending: false },
    { column: 'id', ascending: true },
  ]);
  assert.deepEqual(figures(res), { page: 3, limit: 10, totalItems: 25, totalPages: 3 }, 'totals count every matching row, not the slice');
});

test('listSessions: offset alone is honoured, and a partial last page still counts', async () => {
  const { client, seen } = stubClient([row('d')], 7);
  const service = new SupabaseSessionService(client);

  const res = await service.listSessions({
    appName: 'app',
    userId: 'user',
    limit: 3,
    offset: 6,
  });

  assert.deepEqual(seen.range, [6, 8]);
  assert.equal(res.page, 3, 'offset 6 at size 3 is the third page');
  assert.equal(res.totalPages, 3, '7 rows at size 3 is three pages, not two');
});

test('list: the engine face sends the same request and reports listPage’s figures', async () => {
  const requests = [
    { appName: 'app', userId: 'user' },
    { appName: 'app', userId: 'user', limit: 10, page: 3, offset: 99, order: 'desc' as const },
    { appName: 'app', userId: 'user', limit: 3, offset: 6 },
    { appName: 'app', userId: 'user', limit: 5 },
    { appName: 'app', userId: 'user', limit: 2.9, offset: -4 },
  ];
  for (const request of requests) {
    const viaAdk = stubClient([row('a')], 7);
    const viaEngine = stubClient([row('a')], 7);
    const adk = await new SupabaseSessionService(viaAdk.client).listSessions(request);
    const engine = await new SupabaseSessionService(viaEngine.client).list(request);
    assert.deepEqual(viaEngine.seen, viaAdk.seen, `${JSON.stringify(request)}: one query`);
    assert.deepEqual(JSON.parse(JSON.stringify(engine)), JSON.parse(JSON.stringify(adk)), `${JSON.stringify(request)}: one answer`);
    assert.deepEqual(figures(engine), listPage(7, request));
  }
  // An empty listing is still one page.
  const empty = await new SupabaseSessionService(stubClient([], 0).client).list({ appName: 'app', userId: 'user', limit: 5 });
  assert.deepEqual(figures(empty), { page: 1, limit: 5, totalItems: 0, totalPages: 1 });
  // A fractional, negative window is whole and in range: size 2 from row 0.
  const odd = stubClient([], 7);
  await new SupabaseSessionService(odd.client).list({ appName: 'app', limit: 2.9, offset: -4 });
  assert.deepEqual(odd.seen.range, [0, 1]);
});

test('list without a user id lists every user’s sessions of the app, and only that app', async () => {
  const { client, seen } = stubClient([row('a', 'u1'), row('b', 'u:2')], 2);
  const res = await new SupabaseSessionService(client).list({ appName: 'app' });
  assert.deepEqual(seen.eq, [['app_name', 'app']], 'no user filter, and never `user_id=eq.undefined`');
  assert.deepEqual(
    res.sessions.map((s) => [s.userId, s.id]),
    [['u1', 'a'], ['u:2', 'b']],
    'the session id is unwrapped by length, so a colon in a user id does not shift it',
  );
});
