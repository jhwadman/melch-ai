/**
 * tests/feedbackPostgres.test.ts — the 1.10 read and write models on the
 * real schema, offline on embedded Postgres (PGlite): postgresFeedbackStore
 * finds a turn by trace or task id and writes the adk_labels row the desktop
 * app's feedback queries read (ADR 0140), and the queue view
 * melchizedek_task_queue (migration 0018) with postgresStorage().retryTask.
 */
process.env.OTEL_CONSOLE_SPANS = 'false';

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';

import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite-pgvector';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';

import { inProcessTurnLock, postgresStorage } from '../lib/storage/postgres/index.ts';
import type { PostgresStorage } from '../lib/storage/postgres/index.ts';
import { feedbackRow, parseFeedback, postgresFeedbackStore } from '../lib/a2a/feedback.ts';
import { patternRedactor } from '../lib/observability/redact.ts';
import { MAX_ATTEMPTS } from '../lib/tools/taskTools.ts';
import type { TaskRecord } from '../lib/tools/taskTools.ts';
import { setLogLevel } from '../lib/runtime/logging.ts';

setLogLevel('error');

const INSTALL = [
  ...readdirSync('db/migrations').filter((f) => /^\d{4}_.+\.sql$/.test(f)).sort().map((f) => `db/migrations/${f}`),
  'db/hardening.sql',
  'db/telemetry.sql',
  'db/hardening.sql',
];

let db: PGlite;
let server: PGLiteSocketServer;
let storage: PostgresStorage;

before(async () => {
  db = await PGlite.create({ extensions: { vector } });
  for (const f of INSTALL) await db.exec(readFileSync(f, 'utf-8'));
  server = new PGLiteSocketServer({ db, port: 0, host: '127.0.0.1', maxConnections: 16 });
  await server.start();
  const { port } = (server as unknown as { server: { address(): { port: number } } }).server.address();
  storage = postgresStorage({
    connectionString: `postgres://postgres@127.0.0.1:${port}/postgres`,
    poolConfig: { max: 2 },
    turnLock: inProcessTurnLock(),
    ledger: { deadLetterFile: '' },
  });
});

after(async () => {
  await storage?.close();
  await server?.stop();
  await db?.close();
});

const FAKE_KEY = 'sk-ant-api03-' + 'q'.repeat(40); // gitleaks:allow (test fixture)

test('postgresStorage with a ledger supplies the feedback store; the row is the one the app reads', async () => {
  assert.ok(storage.feedback, 'present when ledger is on');
  await db.query(
    `INSERT INTO adk_turns (ts, trace_id, span_id, syndicate, task_id, user_id, stage, input, output) VALUES
       (now() - interval '2 seconds', 't-classify', 's1', 'Desk', 'task-9', 'alice', 'classify', 'q', 'route'),
       (now() - interval '1 second',  't-answer',   's2', 'Desk', 'task-9', 'alice', 'dispatch', 'q', 'a')`,
  );
  const fb = postgresFeedbackStore(db);
  assert.deepEqual(await fb.turn({ taskId: 'task-9' }), { traceId: 't-answer', userId: 'alice' }, 'a dispatch task rates its answer, not its classifier');
  assert.deepEqual(await fb.turn({ traceId: 't-classify' }), { traceId: 't-classify', userId: 'alice' });
  assert.equal(await fb.turn({ taskId: 'nope' }), null);

  const parsed = parseFeedback({ taskId: 'task-9', score: 'down', comment: `Wrong. ${FAKE_KEY}`, userId: 'u1' });
  assert.ok(parsed.ok);
  await storage.feedback!.add(feedbackRow('t-answer', parsed.value, patternRedactor(['secret'])));
  await storage.feedback!.add(feedbackRow('t-answer', { score: 5, comment: null, userId: 'u2' }, undefined));

  // The desktop app's reads (melch-app src/engine/ledger/feedback.ts, feedbackSql.ts).
  const r = await db.query<any>(
    `SELECT ref, trace_id, labeler, fields, note, judge, passed, ts IS NOT NULL AS has_ts,
            fields->>'score' AS score, fields->>'userId' AS user_id,
            CASE WHEN fields->>'score' = 'up' THEN 1 WHEN fields->>'score' = 'down' THEN -1
                 WHEN fields->>'score' ~ '^[1-5]$' THEN CASE WHEN (fields->>'score')::int >= 4 THEN 1 WHEN (fields->>'score')::int <= 2 THEN -1 ELSE 0 END END AS s
       FROM adk_labels WHERE ref = 't-answer' AND labeler = 'end-user' ORDER BY id`,
  );
  assert.equal(r.rows.length, 2, 'two users on one turn: two rows (judge NULL keeps them out of the unique key)');
  const [down, five] = r.rows;
  assert.deepEqual(down.fields, { score: 'down', userId: 'u1' });
  assert.equal(down.note, 'Wrong. [redacted:secret]');
  assert.equal(down.trace_id, 't-answer');
  assert.equal(down.judge, null);
  assert.equal(down.passed, null);
  assert.equal(down.has_ts, true);
  assert.equal(down.s, -1);
  assert.deepEqual(five.fields, { score: 5, userId: 'u2' });
  assert.equal(five.score, '5');
  assert.equal(five.note, null);
  assert.equal(five.s, 1);
});

const job = (id: string, over: Partial<TaskRecord> = {}): TaskRecord => ({
  id,
  kind: 'background',
  status: 'queued',
  title: `Job ${id}`,
  instruction: 'Do it.',
  created_at: '2026-10-01T00:00:00.000Z',
  updated_at: '2026-10-01T00:00:00.000Z',
  ...over,
});

test('melchizedek_task_queue: background jobs with attempts, retries, dead-lettered and last error; retryTask requeues', async () => {
  await storage.taskQueue.mutate('alice', (s) => {
    s.tasks.push(
      job('t1'),
      job('t2', { status: 'failed', attempts: 2, error: 'interrupted 2 times; not retried', finished_at: '2026-10-01T01:00:00.000Z' }),
      job('t3', { status: 'cancelled', attempts: 1 }),
      job('t4', { status: 'done', attempts: 1, result: 'ok' }),
      { id: 't5', kind: 'todo', status: 'open', title: 'Buy milk', created_at: '2026-10-01T00:00:00.000Z', updated_at: '2026-10-01T00:00:00.000Z' },
    );
    s.next_id = 6;
  });

  const cols = await db.query<{ column_name: string }>(
    `SELECT column_name FROM information_schema.columns WHERE table_name = 'melchizedek_task_queue' ORDER BY ordinal_position`,
  );
  assert.deepEqual(cols.rows.map((c) => c.column_name), [
    'owner', 'id', 'title', 'status', 'attempts', 'retries', 'max_attempts', 'dead_lettered', 'last_error',
    'lease_owner', 'lease_until', 'has_checkpoint', 'checkpoint_at', 'created_at', 'started_at', 'finished_at', 'updated_at',
  ]);
  const version = await db.query<{ v: number }>(`SELECT max(version) AS v FROM melchizedek_schema_version WHERE name = '0018_queue_view'`);
  assert.equal(Number(version.rows[0].v), 18);

  const rows = (await db.query<any>(`SELECT * FROM melchizedek_task_queue WHERE owner = 'alice' ORDER BY id`)).rows;
  assert.deepEqual(rows.map((r) => r.id), ['t1', 't2', 't3', 't4'], 'todo items are not jobs');
  const t2 = rows.find((r) => r.id === 't2');
  assert.equal(t2.status, 'failed');
  assert.equal(t2.dead_lettered, true);
  assert.equal(t2.attempts, 2);
  assert.equal(t2.retries, 1);
  assert.equal(t2.max_attempts, MAX_ATTEMPTS, 'the view states the engine’s rule');
  assert.equal(t2.last_error, 'interrupted 2 times; not retried');
  assert.ok(t2.finished_at instanceof Date);
  const t1 = rows.find((r) => r.id === 't1');
  assert.equal(t1.dead_lettered, false);
  assert.equal(t1.retries, 0);
  assert.equal(t1.has_checkpoint, false);

  // A claimed job carries its lease in the view.
  const claimed = await storage.taskQueue.claimNext({ workerId: 'w1', leaseMs: 60_000 });
  assert.equal(claimed?.id, 't1');
  const running = (await db.query<any>(`SELECT * FROM melchizedek_task_queue WHERE owner = 'alice' AND id = 't1'`)).rows[0];
  assert.equal(running.status, 'running');
  assert.equal(running.lease_owner, 'w1');
  assert.equal(running.attempts, 1);

  assert.equal(await storage.retryTask('alice', 't2'), 'queued');
  assert.equal(await storage.retryTask('alice', 't3'), 'queued', 'a cancelled job too');
  assert.equal(await storage.retryTask('alice', 't4'), 'not-retryable', 'a done job stays done');
  assert.equal(await storage.retryTask('alice', 't1'), 'not-retryable', 'a running job is not touched');
  assert.equal(await storage.retryTask('alice', 't5'), 'not-retryable', 'a todo is not a job');
  assert.equal(await storage.retryTask('alice', 't99'), 'not-found');
  assert.equal(await storage.retryTask('bob', 't2'), 'not-found', 'ids are per owner');
  const after = (await db.query<any>(`SELECT id, status, attempts, dead_lettered, last_error, finished_at FROM melchizedek_task_queue WHERE owner = 'alice' AND id IN ('t2', 't3') ORDER BY id`)).rows;
  assert.deepEqual(after.map((r) => [r.id, r.status, r.attempts, r.dead_lettered, r.last_error, r.finished_at]), [
    ['t2', 'queued', 0, false, null, null],
    ['t3', 'queued', 0, false, null, null],
  ]);
  const next = await storage.taskQueue.claimNext({ workerId: 'w2', leaseMs: 60_000 });
  assert.equal(next?.id, 't2', 'a retried job is claimed again');
});
