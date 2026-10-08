/**
 * tests/nativeDelegate.test.ts — delegation on the native loop
 * (lib/runtime/native/delegate.ts, WS2-6, ADR 0074).
 *
 * The parity cases read a DELEGATE syndicate's conversation as ADK 2.2 ran
 * it through runSyndicateTurn (a scripted adapter behind the pre-1.0 shim),
 * recorded in tests/fixtures/adk-reference/nativedelegate, then run the same
 * conversation through runAgentLoop with each subagent listed as a
 * subagentTool, the technique of tests/nativeLoop.test.ts. Every session
 * must hold the same events, ids and times aside: the caller's, and the one
 * each subagent's run keeps under its own name. Each model must be sent the
 * same requests. They cover the boundary suite's delegation cases
 * (tests/syndicateTurn.test.ts), a nested syndicate (yaml_reference), the
 * council example's two subagents, state in and out of a subagent, a
 * subagent's failure, and a pause inside a subagent (refused, as ADR 0028
 * refused it under ADK). Offline: scripted adapters only.
 */
process.env.OTEL_CONSOLE_SPANS = 'false';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { z } from 'zod';

import { compileNativeGraph } from '../lib/compileNative.ts';
import { loadSyndicate } from '../lib/loadSyndicate.ts';
import type { SubagentYamlConfig, SyndicateYamlConfig } from '../lib/loadSyndicate.ts';
import type { ModelAdapter, ModelRequest } from '../lib/models/contract.ts';
import { resetCircuits } from '../lib/models/circuitBreaker.ts';
import { drainAgentStream } from '../lib/runtime/syndicateTurn.ts';
import type { SyndicateTurnResult } from '../lib/runtime/syndicateTurn.ts';
import { createTurnControl, runWithTurnControl } from '../lib/runtime/turnControl.ts';
import type { TurnContent, TurnEvent } from '../lib/runtime/events.ts';
import { InProcessSessionService } from '../lib/runtime/sessions.ts';
import { SelfCorrection } from '../lib/runtime/native/selfCorrection.ts';
import { runAgentLoop } from '../lib/runtime/native/agentLoop.ts';
import type { AgentLoopEnd } from '../lib/runtime/native/agentLoop.ts';
import { SUBAGENT, subagentOf, subagentTool } from '../lib/runtime/native/delegate.ts';
import type { NativeAgent } from '../lib/runtime/native/request.ts';
import { registerTool, resolveTools } from '../lib/toolRegistry.ts';
import { toolOf } from '../lib/tools/tool.ts';
import { defineTool } from '../lib/tools/toolContract.ts';
import { ScriptedModel, answer, failure, lastToolResult, requestTexts, toolCall, untilAborted } from './helpers/scriptedModel.ts';
import type { ModelScript } from './helpers/scriptedModel.ts';
import { adkReferences } from './helpers/adkReference.ts';

// ADK's side of each parity case, as ADK 2.2 recorded it (tests/fixtures/adk-reference/nativedelegate).
const reference = adkReferences('nativeDelegate');

const APP = 'native-delegate';
const USER = 'u1';
const COUNCIL = join(import.meta.dirname, '..', 'config', 'agents', 'examples', 'council.yaml');

registerTool(
  'native_delegate_lookup',
  defineTool({
    name: 'native_delegate_lookup',
    description: 'Look a key up.',
    schema: z.object({ key: z.string() }),
    execute: async ({ key }, ctx) => {
      ctx?.state.set(`seen_${key}`, true);
      ctx?.state.set('temp:scratch', key);
      return `found ${key}`;
    },
  }),
  { override: true },
);
const sent: string[] = [];
registerTool(
  'native_delegate_send',
  defineTool({
    name: 'native_delegate_send',
    description: 'Send a note.',
    schema: z.object({ to: z.string() }),
    execute: async ({ to }) => {
      sent.push(to);
      return `sent to ${to}`;
    },
  }),
  { override: true },
);

// ── The native graph: the compile split's NativeAgent (lib/compileNative.ts) ─

type Nested = Record<string, SyndicateYamlConfig>;

/**
 * A DELEGATE syndicate's orchestrator as the native loop runs it: each
 * subagent a subagentTool first, then the orchestrator's own tools; a
 * yaml_reference subagent is the nested syndicate's orchestrator under the
 * entry's name and description.
 */
const nativeGraphOf = (config: SyndicateYamlConfig, nested: Nested): Promise<NativeAgent> =>
  compileNativeGraph(config, { log: () => {}, loadNested: (ref) => nested[ref] as SyndicateYamlConfig });

/** Every agent name a subagent session may be kept under. */
function agentNames(config: SyndicateYamlConfig, nested: Nested): string[] {
  return (config.subagents ?? []).flatMap((s) => [s.name, ...(s.yaml_reference ? agentNames(nested[s.yaml_reference] as SyndicateYamlConfig, nested) : [])]);
}

// ── ADK's recorded side and the native run ───────────────────────────────────

type Models = Record<string, ModelScript>;
const build = (scripts: Models): Record<string, ScriptedModel> =>
  Object.fromEntries(Object.entries(scripts).map(([key, script]) => [key, new ScriptedModel(`scripted/${key}`, script)]));

interface Turn {
  parts?: any[];
  signal?: () => AbortSignal;
  deadlineMs?: number;
}

interface Run {
  /** Each session's events, by app name: the caller's under APP, each subagent's under its own name. */
  sessions: Record<string, TurnEvent[]>;
}

/** ADK's run as recorded: each turn's result (what the cases read of it), the sessions, and the requests each model was sent and its call count. */
interface AdkRun extends Run {
  results: Array<Pick<SyndicateTurnResult, 'status' | 'text' | 'relayFallback' | 'error'>>;
  requests: Record<string, unknown[]>;
  calls: Record<string, number>;
}

const plain = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

/**
 * The same conversation on the native loop: each turn's user event as ADK
 * stored it, then runAgentLoop under a turn control built as
 * runSyndicateTurn builds it, drained as the turn runner drains it.
 */
async function runNative(config: SyndicateYamlConfig, nested: Nested, scripts: Models, turns: Turn[], adk: Run): Promise<Run & { ends: AgentLoopEnd[]; models: Record<string, ScriptedModel> }> {
  const models = build(scripts);
  const agent = await nativeGraphOf(config, nested);
  const store = new InProcessSessionService();
  const session = await store.create({ appName: APP, userId: USER, sessionId: 's1' });
  const userEvents = (adk.sessions[APP] ?? []).filter((e) => e.author === 'user');
  const ends: AgentLoopEnd[] = [];
  for (const [i, turn] of turns.entries()) {
    const userEvent = userEvents[i] ?? { id: 'unstored', invocationId: `e-turn-${i + 1}`, author: 'user', content: { role: 'user', parts: turn.parts ?? [] }, actions: {}, timestamp: 1 };
    if (userEvents[i]) await store.append(session, structuredClone(userEvent));
    const control = createTurnControl({
      maxLlmCalls: config.max_steps ?? 50,
      ...(turn.signal ? { signal: turn.signal() } : {}),
      ...(turn.deadlineMs ? { deadlineMs: turn.deadlineMs } : {}),
    });
    try {
      await runWithTurnControl(control, async () => {
        const loop = runAgentLoop(agent, {
          session,
          sessions: store,
          selfCorrection: new SelfCorrection(config.retries ?? {}),
          invocationId: userEvent.invocationId,
          userContent: userEvent.content as TurnContent,
          adapterFor: (id) => {
            const m = models[id.replace(/^scripted\//, '')];
            if (!m) throw new Error(`no scripted model '${id}'`);
            return m as ModelAdapter;
          },
          log: () => {},
        });
        let end: AgentLoopEnd | undefined;
        const tap = (async function* () {
          for (;;) {
            const next = await loop.next();
            if (next.done) {
              end = next.value;
              return;
            }
            yield next.value;
          }
        })();
        await drainAgentStream(tap as any, {});
        while (!end) {
          const next = await loop.next();
          if (next.done) end = next.value;
        }
        ends.push(end);
      });
    } finally {
      control.dispose();
    }
  }
  const sessions: Record<string, TurnEvent[]> = {};
  for (const app of [APP, ...agentNames(config, nested)]) {
    const s = await store.get({ appName: app, userId: USER, sessionId: 's1' });
    if (s) sessions[app] = plain(s.events);
  }
  return { ends, sessions, models };
}

/**
 * Event ids and times, ADK's own `adk-` call ids, and the invocation ids a
 * subagent's run mints are made per run; everything else must match. An
 * invocation id becomes its order of first appearance in its session, so
 * which events share a run still counts.
 */
function comparable(sessions: Record<string, TurnEvent[]>): unknown {
  const out: Record<string, unknown> = {};
  for (const [app, events] of Object.entries(sessions)) {
    const runs = new Map<string, string>();
    const run = (id: string) => (runs.has(id) ? runs.get(id) : (runs.set(id, `<run-${runs.size + 1}>`), runs.get(id)));
    out[app] = JSON.parse(
      JSON.stringify(events.map((e) => ({ ...e, id: '<id>', timestamp: 0, invocationId: run(e.invocationId) }))),
      (_key, v) => (typeof v === 'string' && v.startsWith('adk-') ? '<adk-id>' : v),
    );
  }
  return out;
}

/** A request as compared: the signal is the run's own. */
const requestOf = ({ signal: _s, ...rest }: ModelRequest) => plain(rest);

const noRetries = { retries: { model_errors: 0, tool_errors: 0 } };

/** A compared request as its SHA-256 (JSON): what a long run's recording holds, its history growing with every call. */
const digestOf = (request: unknown): string => `sha256:${createHash('sha256').update(JSON.stringify(request)).digest('hex')}`;

/**
 * Takes ADK's recorded side of case `name`, runs it natively, and
 * asserts every session holds the same events, and every model was sent the
 * same requests. `digests` compares each request by its digest, for a case
 * whose recorded requests would otherwise run to hundreds of kilobytes.
 */
async function assertParity(name: string, given: SyndicateYamlConfig, scripts: Models, turns: Turn[] = [{}], nested: Nested = {}, digests = false) {
  // Retries at their defaults: the caller runs with self-correction and each subagent without it, as on ADK (ADR 0075).
  const config = given;
  resetCircuits();
  const adk = await reference<AdkRun>(name);
  resetCircuits();
  const native = await runNative(config, nested, scripts, turns, adk);
  resetCircuits();
  assert.deepEqual(Object.keys(native.sessions), Object.keys(adk.sessions), 'the sessions kept');
  assert.deepEqual(comparable(native.sessions), comparable(adk.sessions), 'the stored events');
  for (const key of Object.keys(scripts)) {
    assert.equal(native.models[key]?.calls, adk.calls[key], `calls to ${key}`);
    const sent = native.models[key]?.requests.map(requestOf);
    assert.deepEqual(digests ? sent?.map(digestOf) : sent, adk.requests[key], `requests to ${key}`);
  }
  return { adk, native };
}

function delegateConfig(extra: Partial<SyndicateYamlConfig> = {}, scout: Partial<SubagentYamlConfig> = {}): SyndicateYamlConfig {
  return {
    syndicate_name: 'Test',
    orchestrator: { name: 'Boss', model: 'scripted/boss', instruction: 'Delegate to Scout.' },
    subagents: [{ name: 'Scout', model: 'scripted/scout', instruction: 'Answer.', description: 'Finds things', ...scout }],
    ...extra,
  } as SyndicateYamlConfig;
}

const relay: ModelScript = (req, n) => (n === 1 ? toolCall('Scout', { request: 'look in the attic' }, 'call-scout-1') : answer(`Scout says: ${String(lastToolResult(req)?.result)}`));

// ── The boundary suite's delegation cases ────────────────────────────────────

test('boundary: the subagent receives the request argument, runs in its own session, and the relay ships', async () => {
  const { adk, native } = await assertParity('relay-ships', delegateConfig(), { boss: relay, scout: () => answer('it is in the attic') });
  assert.equal(adk.results[0]?.text, 'Scout says: it is in the attic');
  assert.deepEqual(native.ends.map((e) => e.reason), ['final']);
  assert.deepEqual(requestTexts(native.models.scout?.requests[0] as ModelRequest), ['look in the attic']);
  // The subagent's run is kept under its own name: the request as a user message, then its answer.
  const scout = native.sessions.Scout ?? [];
  assert.deepEqual(scout.map((e) => [e.author, e.content?.parts?.[0]?.text]), [['user', 'look in the attic'], ['Scout', 'it is in the attic']]);
  assert.match(scout[0]?.invocationId ?? '', /^e-[0-9a-f-]{36}$/);
  // The caller's session holds the call and its result, authored by the caller.
  const response = native.sessions[APP]?.[2];
  assert.equal(response?.author, 'Boss');
  assert.deepEqual(response?.content?.parts?.[0]?.functionResponse?.response, { result: 'it is in the attic' });
});

test('boundary: a relay that returns no text stores the same events (the fallback stays in the turn runner)', async () => {
  const { adk } = await assertParity('relay-fallback', delegateConfig(), {
    boss: (_r, n) => (n === 1 ? toolCall('Scout', { request: 'go' }, 'call-scout-1') : answer('')),
    scout: () => answer('the full specialist report'),
  });
  assert.equal(adk.results[0]?.relayFallback, true);
});

test('boundary: max_steps caps model calls across the whole turn, subagents included', async () => {
  const { adk, native } = await assertParity('max-steps-5', delegateConfig({ max_steps: 5 }), {
    boss: (_r, n) => toolCall('Scout', { request: 'again' }, `call-scout-${n}`),
    scout: () => answer('still nothing'),
  });
  assert.equal(adk.results[0]?.error?.code, 'STEP_LIMIT');
  assert.equal(native.ends[0]?.stop?.code, 'STEP_LIMIT');
  assert.equal((native.models.boss?.calls ?? 0) + (native.models.scout?.calls ?? 0), 5);
});

test('boundary: without max_steps, the turn stops at 50 model calls, as on ADK', async () => {
  const { native } = await assertParity('default-step-limit-50', delegateConfig(), {
    boss: (_r, n) => toolCall('Scout', { request: 'again' }, `call-scout-${n}`),
    scout: () => answer('still nothing'),
  }, [{}], {}, true);
  assert.equal((native.models.boss?.calls ?? 0) + (native.models.scout?.calls ?? 0), 50);
});

test('boundary: cancel stops the orchestrator’s call in flight', async () => {
  const signal = () => {
    const c = new AbortController();
    setTimeout(() => c.abort(), 30);
    return c.signal;
  };
  const { native } = await assertParity('cancel-orchestrator', delegateConfig(), { boss: (_r, _n, s) => untilAborted(s), scout: () => answer('x') }, [{ signal }]);
  assert.equal(native.ends[0]?.stop?.code, 'CANCELED');
});

test('boundary: cancel inside the subagent’s call stops the turn, with the same events in both sessions', async () => {
  const signal = () => {
    const c = new AbortController();
    setTimeout(() => c.abort(), 40);
    return c.signal;
  };
  const { adk, native } = await assertParity(
    'cancel-in-subagent',
    delegateConfig(),
    { boss: (_r, n) => (n === 1 ? toolCall('Scout', { request: 'wait' }, 'call-scout-1') : answer('never')), scout: (_r, _n, s) => untilAborted(s) },
    [{ signal }],
  );
  assert.equal(adk.results[0]?.status, 'canceled');
  assert.equal(native.models.boss?.calls, 1);
});

test('boundary: a deadline inside the subagent’s call fails the turn, as on ADK', async () => {
  const { adk } = await assertParity(
    'deadline-in-subagent',
    delegateConfig(),
    { boss: (_r, n) => (n === 1 ? toolCall('Scout', { request: 'wait' }, 'call-scout-1') : answer('never')), scout: (_r, _n, s) => untilAborted(s) },
    [{ deadlineMs: 40 }],
  );
  assert.equal(adk.results[0]?.error?.code, 'DEADLINE_EXCEEDED');
});

test('boundary: a model error in the orchestrator is stored as the failure', async () => {
  const { native } = await assertParity('orchestrator-model-error', delegateConfig(), { boss: () => failure({ code: '429', message: 'rate limited' }), scout: () => answer('x') });
  assert.equal(native.ends[0]?.reason, 'error');
});

// ── The subagent's run ───────────────────────────────────────────────────────

test('parity: a model error in the subagent answers the call with an empty text', async () => {
  const { native } = await assertParity('subagent-model-error', delegateConfig(noRetries), {
    boss: relay,
    scout: () => failure({ code: '500', message: 'upstream broke' }),
  });
  assert.deepEqual(native.sessions[APP]?.[2]?.content?.parts?.[0]?.functionResponse?.response, { result: '' });
  assert.equal(native.sessions.Scout?.at(-1)?.errorCode, '500');
});

test('parity: a second delegation, in a later turn, continues the subagent’s own session', async () => {
  const { native } = await assertParity(
    'second-delegation-later-turn',
    delegateConfig(),
    {
      boss: (req, n) => (n % 2 === 1 ? toolCall('Scout', { request: `question ${n}` }, `call-scout-${n}`) : answer(String(lastToolResult(req)?.result))),
      scout: (_r, n) => answer(`answer ${n}`),
    },
    [{ parts: [{ text: 'first' }] }, { parts: [{ text: 'second' }] }],
  );
  assert.deepEqual(requestTexts(native.models.scout?.requests[1] as ModelRequest), ['question 1', 'answer 1', 'question 3']);
  assert.equal(native.sessions.Scout?.length, 4);
});

test('parity: the subagent starts from the caller’s state, and its state writes land on the caller’s response event', async () => {
  const config = delegateConfig(
    { ...noRetries, orchestrator: { name: 'Boss', model: 'scripted/boss', instruction: 'Delegate to Scout.', tools: ['native_delegate_lookup'] } } as Partial<SyndicateYamlConfig>,
    { instruction: 'Answer. Seen alpha: {seen_alpha?}.', outputKey: 'scout_answer', tools: ['native_delegate_lookup'] },
  );
  const { native } = await assertParity('state-in-and-out', config, {
    boss: (req, n) =>
      n === 1
        ? toolCall('native_delegate_lookup', { key: 'alpha' }, 'call-lookup-1')
        : n === 2
          ? toolCall('Scout', { request: 'look up beta' }, 'call-scout-1')
          : answer(String(lastToolResult(req)?.result)),
    scout: (_r, n) => (n === 1 ? toolCall('native_delegate_lookup', { key: 'beta' }, 'call-lookup-2') : answer('beta is found')),
  });
  assert.match(native.models.scout?.requests[0]?.system ?? '', /Seen alpha: true\./);
  // The child's writes (its tool's, and its outputKey), temp: keys aside, on the caller's response to the call.
  assert.deepEqual(native.sessions[APP]?.[4]?.actions.stateDelta, { seen_beta: true, scout_answer: 'beta is found' });
});

test('parity: an output schema’s answer is parsed, and an answer that does not parse fails the call', async () => {
  const schema = { type: 'object', properties: { verdict: { type: 'string' } }, required: ['verdict'] };
  const parsed = await assertParity('output-schema-parsed', delegateConfig(noRetries, { outputSchema: schema }), { boss: relay, scout: () => answer('{"verdict":"pass"}') });
  assert.deepEqual(parsed.native.sessions[APP]?.[2]?.content?.parts?.[0]?.functionResponse?.response, { verdict: 'pass' });
  const broken = await assertParity('output-schema-not-json', delegateConfig(noRetries, { outputSchema: schema }), { boss: relay, scout: () => answer('not json') });
  assert.ok('error' in (broken.native.sessions[APP]?.[2]?.content?.parts?.[0]?.functionResponse?.response ?? {}));
});

test('parity: a pause inside a subagent stays refused: the gated tool never runs and the call answers an empty text', async () => {
  // Not a valid YAML (ADR 0028 refuses a gate on a delegated subagent at load): built here to show the loop swallows it as ADK did.
  sent.length = 0;
  const { native } = await assertParity('pause-approval-refused', delegateConfig(noRetries, { tools: ['native_delegate_send'], require_approval: ['native_delegate_send'] }), {
    boss: relay,
    scout: () => toolCall('native_delegate_send', { to: 'ops@acme.test' }, 'call-send-1'),
  });
  assert.deepEqual(sent, [], 'the gated tool never ran');
  assert.equal(native.sessions.Scout?.at(-1)?.content?.parts?.[0]?.functionCall?.name, 'adk_request_confirmation');
  assert.deepEqual(native.sessions[APP]?.[2]?.content?.parts?.[0]?.functionResponse?.response, { result: '' });
  assert.equal(native.ends[0]?.reason, 'final', 'the caller does not pause');

  const asked = await assertParity('pause-ask-user-refused', delegateConfig(noRetries, { tools: ['ask_user'] }), {
    boss: relay,
    scout: () => toolCall('ask_user', { question: 'Which attic?' }, 'call-ask-1'),
  });
  assert.deepEqual(asked.native.sessions[APP]?.[2]?.content?.parts?.[0]?.functionResponse?.response, { result: '' });
  assert.equal(asked.native.ends[0]?.reason, 'final');
});

// ── A nested syndicate, and the council example ──────────────────────────────

test('parity: a nested syndicate (yaml_reference) runs its own delegation, each agent in its own session', async () => {
  const team = {
    syndicate_name: 'Team',
    orchestrator: { name: 'Lead', model: 'scripted/lead', instruction: 'Ask Scout.' },
    subagents: [{ name: 'Scout', model: 'scripted/scout', instruction: 'Answer.', description: 'Finds things' }],
  } as SyndicateYamlConfig;
  const config = {
    syndicate_name: 'Top',
    orchestrator: { name: 'Boss', model: 'scripted/boss', instruction: 'Ask the team.' },
    subagents: [{ name: 'Team', description: 'A team that finds things', yaml_reference: 'team.yaml' }],
  } as SyndicateYamlConfig;
  const { native } = await assertParity(
    'nested-syndicate',
    config,
    {
      boss: (req, n) => (n === 1 ? toolCall('Team', { request: 'find the key' }, 'call-team-1') : answer(`Team: ${String(lastToolResult(req)?.result)}`)),
      lead: (req, n) => (n === 1 ? toolCall('Scout', { request: 'the key, please' }, 'call-scout-1') : answer(`Scout: ${String(lastToolResult(req)?.result)}`)),
      scout: () => answer('under the mat'),
    },
    [{}],
    { 'team.yaml': team },
  );
  assert.deepEqual(Object.keys(native.sessions), [APP, 'Team', 'Scout']);
  assert.equal(native.ends[0]?.lastEvent?.content?.parts?.[0]?.text, 'Team: Scout: under the mat');
  assert.match(native.models.lead?.requests[0]?.system ?? '', /Your internal name is "Team"/);
});

/** The council example with each model scripted by its agent's name. */
function council(): SyndicateYamlConfig {
  const config = loadSyndicate(COUNCIL);
  config.orchestrator.model = 'scripted/moderator';
  for (const s of config.subagents ?? []) s.model = `scripted/${s.name.toLowerCase()}`;
  return config;
}

test('council: the Moderator consults the Advocate, then the Skeptic, and the loop stores the events ADK stored', async () => {
  const claim = 'We should rewrite the billing service in Rust.';
  const { native } = await assertParity(
    'council-sequential-steps',
    council(),
    {
      moderator: (req, n) =>
        n === 1
          ? toolCall('Advocate', { request: claim }, 'call-advocate-1')
          : n === 2
            ? toolCall('Skeptic', { request: claim }, 'call-skeptic-1')
            : answer('THE CASE FOR: fast. THE CASE AGAINST: risky. THE VERDICT: wait.'),
      advocate: () => answer('1. It is fast.\n2. It is safe.\n3. It is modern.'),
      skeptic: () => answer('1. It is risky.\n2. It costs.\n3. It stalls.'),
    },
    [{ parts: [{ text: claim }] }],
  );
  assert.deepEqual(Object.keys(native.sessions), [APP, 'Advocate', 'Skeptic']);
  assert.ok(native.models.moderator?.requests[0]?.tools?.some((t) => t.name === 'Skeptic'));
});

test('council: two delegations in one step run one after another, in call order, as ADK runs them', async () => {
  const claim = 'Four-day weeks raise output.';
  const order: string[] = [];
  const { native } = await assertParity(
    'council-two-in-one-step',
    council(),
    {
      moderator: (_r, n) =>
        n === 1
          ? {
              partial: false,
              parts: [
                { type: 'toolCall', id: 'call-advocate-1', name: 'Advocate', args: { request: claim } },
                { type: 'toolCall', id: 'call-skeptic-1', name: 'Skeptic', args: { request: claim } },
              ],
              finishReason: 'tool_call',
            }
          : answer('THE VERDICT: unclear.'),
      advocate: async () => {
        order.push('advocate:start');
        await new Promise((r) => setTimeout(r, 10));
        order.push('advocate:end');
        return answer('1. Rested people.');
      },
      skeptic: () => {
        order.push('skeptic');
        return answer('1. Coverage gaps.');
      },
    },
    [{ parts: [{ text: claim }] }],
  );
  assert.deepEqual(order, ['advocate:start', 'advocate:end', 'skeptic'], 'the native run, sequential');
  const responses = native.sessions[APP]?.[2]?.content?.parts?.map((p) => [p.functionResponse?.name, p.functionResponse?.response]);
  assert.deepEqual(responses, [
    ['Advocate', { result: '1. Rested people.' }],
    ['Skeptic', { result: '1. Coverage gaps.' }],
  ]);
});

// ── The subagent tool on its own ─────────────────────────────────────────────

test('subagentTool declares the request argument ADK’s AgentTool declares, and refuses to run off the loop', async () => {
  const agent: NativeAgent = { name: 'Scout', description: 'Finds things', model: 'scripted/scout' };
  const tool = subagentTool(agent);
  assert.equal(subagentOf(tool), agent);
  assert.equal((tool as any)[SUBAGENT], agent);
  assert.deepEqual(tool.declaration().parameters, { type: 'object', properties: { request: { type: 'string' } }, required: ['request'] });
  await assert.rejects(() => tool.execute({ request: 'x' }, {} as any), /runs only on the native loop/);
  assert.equal(subagentOf(toolOf(resolveTools(['native_delegate_lookup'])[0])), undefined);
});
