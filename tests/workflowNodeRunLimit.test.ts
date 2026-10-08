/**
 * tests/workflowNodeRunLimit.test.ts — the native walk's node-run ceiling
 * (ADR 0105, lib/workflow/scheduler.ts).
 *
 * `max_steps` counts model calls, so a routed cycle through nodes that make
 * none (a tool node and its route step looping on each other) was bounded
 * only by the turn's deadline (native-loop-security R4). The scheduler now
 * starts at most `nodeRunCeiling(max_steps)` node runs per walk: the run
 * that would pass it fails its node with NodeRunLimitError, reported as any
 * node that gave up, and the turn fails NODE_RUN_LIMIT. A bounded loop under
 * the ceiling stores the events ADK 2.2 recorded for it. No models but
 * scripted ones, no network.
 */
process.env.OTEL_CONSOLE_SPANS = 'false';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';

import { DEFAULT_MAX_STEPS } from '../lib/config.ts';
import { createTurnControl, runWithTurnControl } from '../lib/runtime/turnControl.ts';
import { registerTool } from '../lib/toolRegistry.ts';
import { defineTool } from '../lib/tools/toolContract.ts';
import { buildWorkflowGraph } from '../lib/workflow/graph.ts';
import { MIN_NODE_RUNS, NODE_RUNS_PER_STEP, NODE_RUN_LIMIT, NodeRunLimitError, nodeErrorEvent, nodeRunCeiling, runWorkflowGraph } from '../lib/workflow/scheduler.ts';
import type { SchedulerEvent } from '../lib/workflow/scheduler.ts';
import type { SyndicateYamlConfig } from '../lib/loadSyndicate.ts';
import { answer } from './helpers/scriptedModel.ts';
import { agent, adkSide, comparable, onNativeTurn, workflowConfig } from './helpers/workflowParity.ts';
import { adkReferences } from './helpers/adkReference.ts';

// ADK's side of the parity case is recorded (tests/fixtures/adk-reference/workflownoderunlimit).
const reference = adkReferences('workflowNodeRunLimit');

// ── The ceiling on the scheduler ─────────────────────────────────────────────

/** A route step that sends Spin back to itself while its output says `again`. */
const SPIN = buildWorkflowGraph(workflowConfig({ edges: [['START', 'Spin', { again: 'Spin', default: 'Done' }]] }, [agent('Spin'), agent('Done')]));

/** A model-free runner: Spin counts up and loops until `stopAt` (never, by default); Done echoes. */
const spinner = (stopAt = Infinity) => {
  let runs = 0;
  return {
    get runs() {
      return runs;
    },
    runNode: async (r: { target: { kind: string; name?: string }; input: unknown }) => {
      if (r.target.name !== 'Spin') return { output: `done after ${runs}` };
      runs += 1;
      return { output: { route: runs < stopAt ? 'again' : 'stop', n: runs } };
    },
  };
};

test('nodeRunCeiling: 20 runs per max_steps, at least 100, the default max_steps when unset', () => {
  assert.equal(NODE_RUNS_PER_STEP, 20);
  assert.equal(MIN_NODE_RUNS, 100);
  assert.equal(nodeRunCeiling(50), 1000);
  assert.equal(nodeRunCeiling(2), 100);
  assert.equal(nodeRunCeiling(undefined), NODE_RUNS_PER_STEP * DEFAULT_MAX_STEPS);
  assert.equal(nodeRunCeiling(0), NODE_RUNS_PER_STEP * DEFAULT_MAX_STEPS);
});

test('a model-free routed cycle trips the ceiling: the node fails with NodeRunLimitError, reported once, and nothing more starts', async () => {
  const spin = spinner();
  const events: SchedulerEvent[] = [];
  const started = performance.now();
  await assert.rejects(
    runWorkflowGraph(SPIN, { input: 'go', runNode: spin.runNode as never, maxNodeRuns: 30, onEvent: (e) => events.push(e) }),
    (error: unknown) => error instanceof NodeRunLimitError && error.code === NODE_RUN_LIMIT && error.limit === 30 && /limit of 30 node runs/.test(error.message),
  );
  assert.ok(performance.now() - started < 2000, 'ends at once, not at a deadline');
  // Spin and its route step alternate: 30 runs are 15 of each.
  assert.equal(events.filter((e) => e.type === 'node_start').length, 30);
  assert.equal(spin.runs, 15);
  const errors = events.filter((e) => e.type === 'node_error');
  assert.equal(errors.length, 1);
  const [reported] = errors as Array<Extract<SchedulerEvent, { type: 'node_error' }>>;
  assert.deepEqual([reported.source, reported.node, reported.code, reported.errorType, reported.attempt], ['workflow', 'Spin', NODE_RUN_LIMIT, 'NodeRunLimitError', 0]);
  // The event the native turn stores for it is the workflow's node-error event, as for any node that gave up.
  const stored = nodeErrorEvent(reported, 'e-1');
  assert.deepEqual([stored.isNodeError, stored.author, stored.errorType, stored.errorCode, stored.attemptCount, stored.nodeInfo?.path], [true, 'Spin', 'NodeRunLimitError', NODE_RUN_LIMIT, 0, 'Graph.Spin']);
});

test('a bounded loop under the ceiling completes', async () => {
  const spin = spinner(10);
  const run = await runWorkflowGraph(SPIN, { input: 'go', runNode: spin.runNode as never, maxNodeRuns: 30 });
  assert.equal(run.output, 'done after 10');
  assert.equal(run.nodeErrors.length, 0);
});

test("inside a turn the ceiling defaults to nodeRunCeiling of the turn's max_steps; outside one there is none", async () => {
  const control = createTurnControl({ maxLlmCalls: 2 });
  try {
    const spin = spinner();
    await assert.rejects(
      runWithTurnControl(control, () => runWorkflowGraph(SPIN, { input: 'go', runNode: spin.runNode as never })),
      (error: unknown) => error instanceof NodeRunLimitError && error.limit === 100,
    );
    assert.equal(spin.runs, 50);
    assert.equal(control.stopReason, undefined, 'the ceiling fails the walk; it does not stop the turn');
  } finally {
    control.dispose();
  }
  // Outside a turn a library caller sets its own (or none): 300 iterations run.
  const long = spinner(300);
  assert.equal((await runWorkflowGraph(SPIN, { input: 'go', runNode: long.runNode as never })).output, 'done after 300');
});

// ── Through the turn: a tool node looping on its route step ──────────────────

let polls = 0;
registerTool(
  'limit_poll',
  defineTool({
    name: 'limit_poll',
    description: 'Polls; routes back to itself until n reaches until.',
    schema: z.object({ n: z.number(), until: z.number(), route: z.string().optional() }),
    execute: async ({ n, until }) => {
      polls += 1;
      return { n: n + 1, until, route: n + 1 < until ? 'again' : 'done' } as unknown as string;
    },
  }),
  { override: true },
);

/** Triage hands Poll its start; Poll loops on its route step until `until`, then Done answers. max_steps 2: a ceiling of 100. */
const POLLING = {
  ...workflowConfig({ edges: [['START', 'Triage', 'Poll', { again: 'Poll', default: 'Done' }]], nodes: { Poll: { tool: 'limit_poll' } } }, [agent('Done')]),
  max_steps: 2,
} as SyndicateYamlConfig;

const scriptsUntil = (until: number) => ({ triage: () => answer(JSON.stringify({ n: 0, until })), done: () => answer('finished') });

test('native: a tool node looping on its route step fails the turn NODE_RUN_LIMIT, with the node-error event and the progress line', async () => {
  polls = 0;
  const started = performance.now();
  const turn = await onNativeTurn(POLLING, scriptsUntil(Number.MAX_SAFE_INTEGER), 'go');
  assert.ok(performance.now() - started < 5000, 'ends at once, not at a deadline');
  assert.equal(turn.status, 'failed');
  assert.match(turn.error ?? '', /Workflow Graph reached its limit of 100 node runs in one turn before node 'Poll__route' could run again/);
  // Triage is one run; Poll and its route step alternate in the other 99, so the 101st is the route step's.
  assert.equal(polls, 50);
  const reported = turn.events.at(-1) as { isNodeError?: boolean; errorType?: string; errorCode?: string; author?: string; attemptCount?: number };
  assert.deepEqual([reported.isNodeError, reported.errorType, reported.errorCode, reported.author, reported.attemptCount], [true, 'NodeRunLimitError', NODE_RUN_LIMIT, 'Poll__route', 0]);
  assert.equal(turn.progress.at(-1), 'Stopped: the workflow reached its limit of 100 node runs');
  assert.equal(turn.models.done!.calls, 0);
});

test('a bounded tool-node loop under the ceiling completes, and stores the events ADK recorded', async () => {
  const adk = await adkSide(reference, 'bounded-tool-node-loop');
  const native = await onNativeTurn(POLLING, scriptsUntil(10), 'go');
  assert.equal(native.status, 'completed');
  assert.equal(adk.status, 'completed');
  assert.equal(native.output, 'finished');
  assert.deepEqual(comparable(native.events), comparable(adk.events));
  assert.deepEqual(native.progress, adk.progress);
});
