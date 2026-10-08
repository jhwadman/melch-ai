/**
 * tests/nativeLoop.test.ts — the native loop for one agent
 * (lib/runtime/native/agentLoop.ts, WS2-5b, ADR 0066).
 *
 * The parity cases run a syndicate on the ADK runtime (runSyndicateTurn,
 * a scripted adapter behind the shim), then the same conversation through
 * runAgentLoop with the same script: the store must hold the same events,
 * ids and times aside. They cover every single-agent case of the boundary
 * suite (tests/syndicateTurn.test.ts) and the loop's own cases: tool calls
 * and their results, parallel calls, a throwing tool, an unknown tool,
 * ask_user, an approval request, outputKey, set_model_response, a skill's
 * ADK tool. Then the loop on its own: streaming, the end it reports.
 * Offline: scripted adapters only.
 */
process.env.OTEL_CONSOLE_SPANS = 'false';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { FunctionTool, InMemorySessionService, LogLevel, setLogLevel } from '@google/adk';
import { z } from 'zod';

import { compileNativeGraph } from '../lib/compileNative.ts';
import type { SyndicateYamlConfig } from '../lib/loadSyndicate.ts';
import type { ModelAdapter, ModelRequest, ModelResponse } from '../lib/models/contract.ts';
import { resetCircuits } from '../lib/models/fallback.ts';
import { validateSyndicateConfig } from '../lib/syndicateSchema.ts';
import { drainAgentStream, runSyndicateTurn } from '../lib/runtime/syndicateTurn.ts';
import type { SyndicateTurnResult } from '../lib/runtime/syndicateTurn.ts';
import { createTurnControl, runWithTurnControl } from '../lib/runtime/turnControl.ts';
import type { TurnContent, TurnEvent } from '../lib/runtime/events.ts';
import { InProcessSessionService } from '../lib/runtime/sessions.ts';
import { runAgentLoop, saveOutput } from '../lib/runtime/native/agentLoop.ts';
import type { AgentLoopEnd } from '../lib/runtime/native/agentLoop.ts';
import { SelfCorrection } from '../lib/runtime/native/selfCorrection.ts';
import type { NativeAgent } from '../lib/runtime/native/request.ts';
import { registerTool } from '../lib/toolRegistry.ts';
import { defineTool } from '../lib/tools/toolContract.ts';
import { ScriptedModel, answer, failure, lastToolResult, shimResolver, streamedAnswer, toolCall, untilAborted } from './helpers/scriptedModel.ts';
import type { ModelScript } from './helpers/scriptedModel.ts';

setLogLevel(LogLevel.ERROR);

const APP = 'native-loop';
const USER = 'u1';
const SKILLS = join(import.meta.dirname, 'fixtures', 'skills');

registerTool(
  'native_loop_lookup',
  defineTool({
    name: 'native_loop_lookup',
    description: 'Look a key up.',
    schema: z.object({ key: z.string() }),
    execute: async ({ key }, ctx) => {
      ctx?.state.set(`seen_${key}`, true);
      return `found ${key}`;
    },
  }),
  { override: true },
);
registerTool(
  'native_loop_list',
  defineTool({ name: 'native_loop_list', description: 'List keys.', schema: z.object({}), execute: async () => ['a', 'b'] }),
  { override: true },
);
registerTool(
  'native_loop_broken',
  defineTool({
    name: 'native_loop_broken',
    description: 'Always fails.',
    schema: z.object({}),
    execute: async () => {
      throw new Error('the disk is full');
    },
  }),
  { override: true },
);
registerTool(
  'harness_test_lookup',
  defineTool({ name: 'harness_test_lookup', description: 'Look something up.', schema: z.object({ key: z.string() }), execute: async ({ key }) => `looked up ${key}` }),
  { override: true },
);
// Fails when asked to; answers late otherwise, so a parallel step's calls finish out of call order.
registerTool(
  'native_loop_maybe',
  defineTool({
    name: 'native_loop_maybe',
    description: 'Fails when asked to.',
    schema: z.object({ fail: z.boolean() }),
    execute: async ({ fail }) => {
      if (fail) throw new Error('asked to fail');
      await new Promise((resolve) => setTimeout(resolve, 15));
      return 'fine';
    },
  }),
  { override: true },
);
// The boundary suite's gated tool: an ADK FunctionTool from the registry, gated by compile's requireApprovalOn.
const sent: string[] = [];
registerTool(
  'native_loop_send',
  new FunctionTool({
    name: 'native_loop_send',
    description: 'Send a note.',
    parameters: z.object({ to: z.string() }),
    execute: async ({ to }) => {
      sent.push(to);
      return `sent to ${to}`;
    },
  }),
  { override: true },
);

// ── The two runtimes ─────────────────────────────────────────────────────────

function syndicate(orchestrator: Record<string, unknown>, extra: Record<string, unknown> = {}): SyndicateYamlConfig {
  return validateSyndicateConfig(
    { syndicate_name: APP, orchestrator: { model: 'scripted/boss', ...orchestrator }, subagents: [], ...extra },
    'test',
  ) as SyndicateYamlConfig;
}

/** The orchestrator as the native loop runs it: the compile split's NativeAgent (lib/compileNative.ts). */
const nativeAgentOf = (config: SyndicateYamlConfig): Promise<NativeAgent> => compileNativeGraph(config, { log: () => {} });

/** Each scripted model by its key (`scripted/<key>`), built fresh for each runtime. */
type Models = Record<string, ModelScript>;
const build = (scripts: Models): Record<string, ScriptedModel> =>
  Object.fromEntries(Object.entries(scripts).map(([key, script]) => [key, new ScriptedModel(`scripted/${key}`, script)]));

interface Turn {
  parts?: any[];
  signal?: () => AbortSignal;
  streaming?: boolean;
}

interface AdkRun {
  results: SyndicateTurnResult[];
  events: TurnEvent[];
  models: Record<string, ScriptedModel>;
  deltas: string[][];
}

async function runOnAdk(config: SyndicateYamlConfig, scripts: Models, turns: Turn[]): Promise<AdkRun> {
  const models = build(scripts);
  const sessionService = new InMemorySessionService();
  const results: SyndicateTurnResult[] = [];
  const deltas: string[][] = [];
  for (const turn of turns) {
    const d: string[] = [];
    deltas.push(d);
    results.push(
      await runSyndicateTurn({
        config,
        parts: turn.parts ?? [{ text: 'find the thing' }],
        appName: APP,
        userId: USER,
        sessionId: 's1',
        sessionService,
        compile: { resolveModel: shimResolver(models), log: () => {} },
        trace: false,
        ...(turn.signal ? { signal: turn.signal() } : {}),
        ...(turn.streaming ? { streaming: true, events: { onTextDelta: (t: string) => d.push(t) } } : {}),
      }),
    );
  }
  const session = await sessionService.getSession({ appName: APP, userId: USER, sessionId: 's1' });
  return { results, events: JSON.parse(JSON.stringify(session?.events ?? [])) as TurnEvent[], models, deltas };
}

interface NativeRun {
  ends: AgentLoopEnd[];
  events: TurnEvent[];
  yielded: TurnEvent[][];
  models: Record<string, ScriptedModel>;
  deltas: string[][];
}

/**
 * The same conversation on the native loop: each turn's user event as ADK
 * stored it (its invocation id included), then runAgentLoop under a turn
 * control built as runSyndicateTurn builds it, its events drained as the
 * turn runner drains them.
 */
async function runNative(config: SyndicateYamlConfig, scripts: Models, turns: Turn[], adk: AdkRun): Promise<NativeRun> {
  const models = build(scripts);
  const agent = await nativeAgentOf(config);
  const sessions = new InProcessSessionService();
  const session = await sessions.create({ appName: APP, userId: USER, sessionId: 's1' });
  const userEvents = adk.events.filter((e) => e.author === 'user');
  const ends: AgentLoopEnd[] = [];
  const yielded: TurnEvent[][] = [];
  const deltas: string[][] = [];
  for (const [i, turn] of turns.entries()) {
    // A turn canceled before it started stored nothing on ADK, not even the message: the loop then runs on the session as it is.
    const userEvent = userEvents[i] ?? { id: 'unstored', invocationId: `e-turn-${i + 1}`, author: 'user', content: { role: 'user', parts: turn.parts ?? [] }, actions: {}, timestamp: 1 };
    if (userEvents[i]) await sessions.append(session, structuredClone(userEvent));
    const control = createTurnControl({ maxLlmCalls: config.max_steps ?? 50, ...(turn.signal ? { signal: turn.signal() } : {}) });
    const seen: TurnEvent[] = [];
    const d: string[] = [];
    try {
      await runWithTurnControl(control, async () => {
        const loop = runAgentLoop(agent, {
          session,
          sessions,
          invocationId: userEvent.invocationId,
          userContent: userEvent.content as TurnContent,
          stream: turn.streaming === true,
          // One per turn, from the syndicate's retries:, as runSyndicateTurn builds ADK's plugins per Runner.
          selfCorrection: new SelfCorrection(config.retries),
          adapterFor: (id) => {
            const m = models[id.replace(/^scripted\//, '')];
            if (!m) throw new Error(`no scripted model '${id}'`);
            return m as ModelAdapter;
          },
          log: () => {},
        });
        // Drain as the turn runner drains: the same onTextDelta path.
        let end: AgentLoopEnd | undefined;
        const tap = (async function* () {
          for (;;) {
            const next = await loop.next();
            if (next.done) {
              end = next.value;
              return;
            }
            seen.push(next.value);
            yield next.value;
          }
        })();
        await drainAgentStream(tap as any, { streamText: true, events: { onTextDelta: (t: string) => d.push(t) } });
        // The turn runner stops reading at an error event; the loop has nothing after it but its end.
        while (!end) {
          const next = await loop.next();
          if (next.done) end = next.value;
          else seen.push(next.value);
        }
        ends.push(end);
      });
    } finally {
      control.dispose();
    }
    yielded.push(seen);
    deltas.push(d);
  }
  const stored = await sessions.get({ appName: APP, userId: USER, sessionId: 's1' });
  return { ends, events: JSON.parse(JSON.stringify(stored?.events ?? [])) as TurnEvent[], yielded, models, deltas };
}

/** Event ids and times, ADK's own `adk-` call ids and the reflection call's ids are minted per run; everything else must match. */
function comparable(events: TurnEvent[]): unknown {
  return JSON.parse(
    JSON.stringify(events.map((e) => ({ ...e, id: '<id>', timestamp: 0 }))),
    (_key, v) => (typeof v === 'string' && (v.startsWith('adk-') || v.startsWith('adk_handle_model_error_')) ? '<adk-id>' : v),
  );
}

/** Runs both ways and asserts the stores hold the same events. */
async function assertParity(config: SyndicateYamlConfig, scripts: Models, turns: Turn[] = [{}]): Promise<{ adk: AdkRun; native: NativeRun }> {
  resetCircuits();
  const adk = await runOnAdk(config, scripts, turns);
  resetCircuits();
  const native = await runNative(config, scripts, turns, adk);
  resetCircuits();
  assert.deepEqual(comparable(native.events), comparable(adk.events), 'the stored events');
  for (const key of Object.keys(scripts)) {
    assert.equal(native.models[key]?.calls, adk.models[key]?.calls, `calls to ${key}`);
  }
  assert.deepEqual(native.deltas, adk.deltas, 'the text deltas onTextDelta received');
  // Every stored event was yielded, in order, between the partials.
  for (const [i, seen] of native.yielded.entries()) {
    const stored = seen.filter((e) => !e.partial).map((e) => e.id);
    const invocation = adk.events.filter((e) => e.author === 'user')[i]?.invocationId;
    const inTurn = native.events.filter((e) => e.author !== 'user' && e.invocationId === invocation).map((e) => e.id);
    assert.deepEqual(stored, inTurn, `turn ${i + 1}: yielded what was stored, in order`);
  }
  return { adk, native };
}

const solo = (extra: Record<string, unknown> = {}, syndicateExtra: Record<string, unknown> = {}) =>
  syndicate({ name: 'Solo', instruction: 'Answer briefly.', ...extra }, syndicateExtra);

// ── The boundary suite's single-agent cases ──────────────────────────────────

test('boundary: a plain answer stores the same events', async () => {
  const { native } = await assertParity(solo(), { boss: () => answer('the answer', { inputTokens: 10, outputTokens: 3 }) });
  assert.deepEqual(native.ends.map((e) => e.reason), ['final']);
});

test('boundary: the second turn sees the first, and both store the same events', async () => {
  const { native } = await assertParity(
    solo(),
    { boss: (_r, n) => answer(n === 1 ? 'first answer' : 'second answer') },
    [{ parts: [{ text: 'hello' }] }, { parts: [{ text: 'again' }] }],
  );
  assert.deepEqual(native.models.boss?.requests[1]?.messages.map((m) => m.role), ['user', 'assistant', 'user']);
});

test('boundary: includeContents none stores the same events over two turns', async () => {
  await assertParity(
    solo({ includeContents: 'none' }),
    { boss: (_r, n) => answer(`answer ${n}`) },
    [{ parts: [{ text: 'first document: SECRET-A' }] }, { parts: [{ text: 'second document' }] }],
  );
});

test('boundary: streamed partials reach onTextDelta as the same deltas, and the whole text is stored once', async () => {
  const { native } = await assertParity(solo(), { boss: () => streamedAnswer('Hello', ', ', 'world.') }, [{ streaming: true }]);
  assert.deepEqual(native.deltas, [['Hello', ', ', 'world.']]);
  assert.equal(native.yielded[0]?.filter((e) => e.partial).length, 3);
  assert.equal(native.models.boss?.requests[0]?.stream, true);
});

test('boundary: fallback_model answers a retryable failure, and a 400 is stored as the failure', async () => {
  const config = syndicate({ name: 'Main', model: 'scripted/primary', fallback_model: 'scripted/backup', instruction: 'Answer.' });
  for (const status of [503, 400]) {
    const { native } = await assertParity(config, {
      primary: () => failure({ code: 'SCRIPTED_ERROR', message: `HTTP ${status}`, retryable: status === 503, status }),
      backup: () => answer('from the backup'),
    });
    if (status === 503) {
      assert.equal(native.ends[0]?.reason, 'final');
      assert.equal(native.models.backup?.requests[0]?.model, 'scripted/backup', 'the fallback gets its own model id');
      const { model: _p, signal: _s1, ...primary } = native.models.primary?.requests[0] as ModelRequest;
      const { model: _b, signal: _s2, ...backup } = native.models.backup?.requests[0] as ModelRequest;
      assert.deepEqual(backup, primary, 'the same request, under the fallback’s id');
    } else {
      assert.equal(native.ends[0]?.reason, 'error');
      assert.equal(native.models.backup?.calls, 0, 'a 400 is never redirected');
    }
  }
});

test('boundary: a model error with no fallback is stored as the failure, and ends the run', async () => {
  const { native } = await assertParity(solo(), { boss: () => failure({ code: '429', message: 'rate limited' }) });
  assert.equal(native.ends[0]?.reason, 'error');
  assert.equal(native.ends[0]?.lastEvent?.errorCode, '429');
});

test('boundary: cancel aborts the call in flight, and nothing is stored for it', async () => {
  const signal = () => {
    const c = new AbortController();
    setTimeout(() => c.abort(), 30);
    return c.signal;
  };
  const { native } = await assertParity(solo(), { boss: (_req, _n, s) => untilAborted(s) }, [{ signal }]);
  assert.deepEqual(native.ends[0]?.stop, { code: 'CANCELED', message: 'The task was canceled.' });
  assert.deepEqual(native.events.map((e) => e.author), ['user']);
});

test('boundary: max_steps stops a tool loop at the same call, with the same events', async () => {
  const { adk, native } = await assertParity(solo({ tools: ['native_loop_list'] }, { max_steps: 3 }), {
    boss: (_r, n) => toolCall('native_loop_list', {}, `call-list-${n}`),
  });
  assert.equal(adk.results[0]?.error?.code, 'STEP_LIMIT');
  assert.equal(native.ends[0]?.stop?.code, 'STEP_LIMIT');
  assert.equal(native.models.boss?.calls, 3);
});

test('boundary: an approval request pauses the run with the event ADK stores', async () => {
  sent.length = 0;
  const { adk, native } = await assertParity(
    syndicate({ name: 'Boss', instruction: 'Send notes.', tools: ['native_loop_send'], require_approval: ['native_loop_send'] }),
    { boss: () => toolCall('native_loop_send', { to: 'ops@acme.test' }, 'call-send-1') },
    [{ parts: [{ text: 'tell ops' }] }],
  );
  assert.equal(adk.results[0]?.status, 'input-required');
  assert.deepEqual(sent, [], 'nothing ran before the approval');
  const end = native.ends[0] as AgentLoopEnd;
  assert.equal(end.reason, 'paused');
  const confirmation = end.lastEvent?.content?.parts?.[0]?.functionCall;
  assert.equal(confirmation?.name, 'adk_request_confirmation');
  assert.deepEqual(end.pending, [confirmation?.id]);
  assert.deepEqual((confirmation?.args as any)?.originalFunctionCall, { id: 'call-send-1', name: 'native_loop_send', args: { to: 'ops@acme.test' } });
});

test('boundary: a turn canceled before it starts makes no call and stores nothing', async () => {
  const aborted = () => {
    const c = new AbortController();
    c.abort();
    return c.signal;
  };
  const { native } = await assertParity(solo(), { boss: () => answer('never') }, [{ signal: aborted }]);
  assert.equal(native.models.boss?.calls, 0);
  assert.equal(native.ends[0]?.reason, 'stopped');
});

// ── The loop's own cases, both ways ──────────────────────────────────────────

test('parity: a tool call, its result fed back, then the answer; the tool’s state write lands with its response', async () => {
  const { native } = await assertParity(solo({ tools: ['native_loop_lookup'] }), {
    boss: (req, n) => (n === 1 ? toolCall('native_loop_lookup', { key: 'alpha' }, 'call-1') : answer(`got ${String(lastToolResult(req)?.result)}`)),
  });
  assert.deepEqual(lastToolResult(native.models.boss?.requests[1] as ModelRequest)?.result, 'found alpha');
  assert.deepEqual(native.events[2]?.actions.stateDelta, { seen_alpha: true });
  assert.equal(native.ends[0]?.reason, 'final');
});

test('parity: parallel calls are merged into one response event, in call order, a list wrapped as results', async () => {
  const { native } = await assertParity(solo({ tools: ['native_loop_lookup', 'native_loop_list'] }), {
    boss: (_r, n) =>
      n === 1
        ? {
            partial: false,
            parts: [
              { type: 'toolCall', id: 'c-1', name: 'native_loop_lookup', args: { key: 'a' } },
              { type: 'toolCall', id: 'c-2', name: 'native_loop_list', args: {} },
              { type: 'toolCall', id: 'c-3', name: 'native_loop_lookup', args: { key: 'b' } },
            ],
            finishReason: 'tool_call',
          }
        : answer('done'),
  });
  const responses = native.events[2]?.content?.parts?.map((p) => [p.functionResponse?.id, p.functionResponse?.response]);
  assert.deepEqual(responses, [
    ['c-1', { result: 'found a' }],
    ['c-2', { results: ['a', 'b'] }],
    ['c-3', { result: 'found b' }],
  ]);
  assert.deepEqual(native.events[2]?.actions.stateDelta, { seen_a: true, seen_b: true });
});

test('parity: with tool_errors: 0, a throwing tool answers ADK’s error text, and an unknown tool answers not found', async () => {
  const { native } = await assertParity(solo({ tools: ['native_loop_broken'] }, { retries: { tool_errors: 0 } }), {
    boss: (_r, n) =>
      n === 1
        ? {
            partial: false,
            parts: [
              { type: 'toolCall', id: 'c-1', name: 'native_loop_broken', args: {} },
              { type: 'toolCall', id: 'c-2', name: 'no_such_tool', args: {} },
            ],
            finishReason: 'tool_call',
          }
        : answer('sorry'),
  });
  const [broken, unknown] = native.events[2]?.content?.parts?.map((p) => p.functionResponse?.response) ?? [];
  assert.deepEqual(broken, { error: "Error in tool 'native_loop_broken': the disk is full" });
  // ADK's own wording, word for word (the parity assert above holds it to ADK's).
  assert.match(String(unknown?.error), /^Function no_such_tool is not found in the /);
});

test('parity: ask_user ends the run with the call pending and no response to it', async () => {
  const { adk, native } = await assertParity(solo({ tools: ['ask_user'] }), {
    boss: () => toolCall('ask_user', { question: 'Which year?' }, 'call-ask-1'),
  });
  assert.equal(adk.results[0]?.status, 'input-required');
  assert.deepEqual(native.ends[0]?.pending, ['call-ask-1']);
  assert.equal(native.ends[0]?.reason, 'paused');
  const last = native.events.at(-1) as TurnEvent;
  assert.equal(last.content, undefined, 'only the call’s actions: skipSummarization');
  assert.equal(last.actions.skipSummarization, true);
});

test('parity: outputKey saves the final answer into state, and an output schema saves it parsed', async () => {
  const { native } = await assertParity(solo({ outputKey: 'last_answer' }), { boss: () => answer('plain words') });
  assert.equal(native.events.at(-1)?.actions.stateDelta?.last_answer, 'plain words');

  const schema = { type: 'object', properties: { verdict: { type: 'string' }, score: { type: 'integer' } }, required: ['verdict'] };
  const parsed = await assertParity(solo({ outputKey: 'grade', outputSchema: schema }), {
    boss: () => answer('{"verdict":"pass","score":3,"extra":true}'),
  });
  assert.deepEqual(parsed.native.events.at(-1)?.actions.stateDelta?.grade, parsed.adk.events.at(-1)?.actions.stateDelta?.grade);
  assert.equal(typeof parsed.native.events.at(-1)?.actions.stateDelta?.grade, 'object');
});

test('parity: an output schema beside tools ends on set_model_response, saved under outputKey', async () => {
  const { native } = await assertParity(
    solo(
      {
        tools: ['native_loop_lookup'],
        outputKey: 'grade',
        outputSchema: { type: 'object', properties: { verdict: { type: 'string' } }, required: ['verdict'] },
      },
    ),
    {
      boss: (_r, n) => (n === 1 ? toolCall('native_loop_lookup', { key: 'alpha' }, 'call-1') : toolCall('set_model_response', { verdict: 'pass' }, 'call-smr')),
    },
  );
  assert.equal(native.events.at(-1)?.content?.parts?.[0]?.text, '{"verdict":"pass"}');
  assert.deepEqual(native.events.at(-1)?.actions.stateDelta, { grade: { verdict: 'pass' } });
  assert.equal(native.ends[0]?.reason, 'final');
});

test('parity: a skill’s ADK tool runs through its own runAsync, and unlocks the skill’s tool', async () => {
  const { native } = await assertParity(
    solo({ instruction: 'Follow skills.', skills: { dir: SKILLS, tools: ['harness_test_lookup'] } }),
    {
      boss: (_r, n) =>
        n === 1
          ? toolCall('load_skill', { name: 'release-notes' }, 'call-skill-1')
          : n === 2
            ? toolCall('harness_test_lookup', { key: 'v2' }, 'call-h-1')
            : answer('Release 2.0: smaller.'),
    },
  );
  assert.deepEqual(native.models.boss?.requests[1]?.tools?.map((t) => t.name), ['load_skill', 'load_skill_resource', 'harness_test_lookup', 'adk_handle_model_error']);
  assert.deepEqual(lastToolResult(native.models.boss?.requests[2] as ModelRequest)?.result, 'looked up v2');
});

test('parity: a model that thinks but never answers ends on the adapter’s named error (ADR 0027)', async () => {
  const { native } = await assertParity(solo(), {
    boss: () => [
      { partial: true, parts: [{ type: 'thinking', text: 'counting words' }] },
      failure({ code: 'OLLAMA_EMPTY_RESPONSE', message: 'scripted/boss finished thinking but returned no reply.' }),
    ],
  }, [{ streaming: true }]);
  assert.equal(native.ends[0]?.reason, 'error');
  assert.equal(native.ends[0]?.lastEvent?.errorCode, 'OLLAMA_EMPTY_RESPONSE');
  assert.equal(native.ends[0]?.lastEvent?.errorMessage, 'scripted/boss finished thinking but returned no reply.');
});

test('parity: narration streamed before a tool call is reset, then the answer streams', async () => {
  await assertParity(
    solo({ tools: ['native_loop_lookup'] }),
    {
      boss: (_r, n): ModelResponse[] =>
        n === 1
          ? [{ partial: true, parts: [{ type: 'text', text: 'Let me check. ' }] }, toolCall('native_loop_lookup', { key: 'x' }, 'call-1')]
          : streamedAnswer('Final ', 'answer.'),
    },
    [{ streaming: true }],
  );
});

// ── Self-correction, both ways (ADR 0034, ADR 0075) ──────────────────────────

const responses = (event: TurnEvent | undefined) => (event?.content?.parts ?? []).map((p) => p.functionResponse?.response as Record<string, any>);
const call = (id: string, name: string, args: Record<string, unknown> = {}) => ({ type: 'toolCall' as const, id, name, args });
const calls = (...parts: ReturnType<typeof call>[]): ModelResponse => ({ partial: false, parts, finishReason: 'tool_call' });

test('self-correction: a throwing tool and an unknown tool answer with reflection guidance, counted per tool in call order', async () => {
  const { native } = await assertParity(solo({ tools: ['native_loop_broken'] }), {
    boss: (_r, n) =>
      n === 1
        ? calls(call('c-1', 'native_loop_broken'), call('c-2', 'no_such_tool'), call('c-3', 'native_loop_broken'))
        : n === 2
          ? calls(call('c-4', 'native_loop_broken'))
          : answer('sorry'),
  });
  const first = responses(native.events[2]);
  assert.deepEqual(first.map((r) => [r.response_type, r.error_type, r.retry_count]), [
    ['ERROR_HANDLED_BY_REFLECT_AND_RETRY_PLUGIN', 'Error', 1],
    ['ERROR_HANDLED_BY_REFLECT_AND_RETRY_PLUGIN', 'Error', 1],
    ['ERROR_HANDLED_BY_REFLECT_AND_RETRY_PLUGIN', 'Error', 2],
  ]);
  assert.equal(first[0]?.error_details, "Error in tool 'native_loop_broken': the disk is full");
  assert.match(String(first[1]?.error_details), /^Function no_such_tool is not found in the /);
  assert.match(String(first[2]?.reflection_guidance), /retry attempt \*\*2 of 3\*\*/);
  assert.equal(responses(native.events[4])[0]?.retry_count, 3);
  assert.equal(native.ends[0]?.reason, 'final');
});

test('self-correction: past tool_errors the tool answers that its retry limit is exceeded', async () => {
  const { native } = await assertParity(solo({ tools: ['native_loop_broken'] }, { retries: { tool_errors: 1 } }), {
    boss: (_r, n) => (n <= 2 ? toolCall('native_loop_broken', {}, `c-${n}`) : answer('giving up')),
  });
  assert.equal(responses(native.events[2])[0]?.retry_count, 1);
  const exceeded = responses(native.events[4])[0];
  assert.match(String(exceeded?.reflection_guidance), /has failed consecutively 1 times and the retry limit has been exceeded/);
  assert.match(String(exceeded?.reflection_guidance), /Do not attempt to use the `native_loop_broken` tool again/);
});

test('self-correction: a call that answers resets its tool’s count, in call order though the calls run in parallel', async () => {
  const { native } = await assertParity(solo({ tools: ['native_loop_maybe'] }), {
    boss: (_r, n) =>
      n === 1
        ? calls(call('c-1', 'native_loop_maybe', { fail: true }), call('c-2', 'native_loop_maybe', { fail: false }), call('c-3', 'native_loop_maybe', { fail: true }))
        : answer('done'),
  });
  // The slow success (c-2) finishes after c-3 failed; counted in call order, c-3 is a first failure again.
  assert.deepEqual(responses(native.events[2]).map((r) => r.retry_count ?? r.result), [1, 'fine', 1]);
});

test('self-correction: every request declares the reflection tool, and a model calling it is retried with ADK’s reflection call', async () => {
  const { native } = await assertParity(
    solo(),
    {
      boss: (_r, n): ModelResponse[] =>
        n <= 2 ? [{ partial: true, parts: [{ type: 'text', text: 'Hm. ' }] }, toolCall('adk_handle_model_error', { a: 1 }, `c-${n}`)] : streamedAnswer('Recovered.'),
    },
    [{ streaming: true }],
  );
  const requests = native.models.boss?.requests ?? [];
  assert.deepEqual(requests[0]?.tools, [
    {
      name: 'adk_handle_model_error',
      description: 'A tool that triggers reflection. Reserved for internal framework use only. Do not call directly.',
      parameters: { type: 'object', properties: {} },
    },
  ]);
  const retry = native.events[1]?.content?.parts?.[0]?.functionCall;
  assert.match(String(retry?.id), /^adk_handle_model_error_[0-9a-f-]{36}$/);
  assert.deepEqual(retry?.args, {
    response_type: 'ERROR_HANDLED_BY_REFLECT_AND_RETRY_PLUGIN',
    error_type: 'RESERVED_TOOL_CALL',
    error_details: 'Model attempted to call reserved tool adk_handle_model_error directly. This tool is reserved for framework use only. Do not call it.',
    finish_reason: 'OTHER',
    retry_count: 1,
  });
  // ADK's reflection tool says attempt 1 whatever the count (it reads retryCount, the call carries retry_count).
  assert.match(String(responses(native.events[4])[0]?.reflection_guidance), /retry attempt \*\*1\*\* of \*\*2\*\*/);
  // A streamed partial passes through the plugin too, and resets the agent's count: the second retry is a first again.
  assert.equal((native.events[3]?.content?.parts?.[0]?.functionCall?.args as any)?.retry_count, 1);
  assert.equal(native.ends[0]?.reason, 'final');
  assert.equal(native.events.at(-1)?.content?.parts?.[0]?.text, 'Recovered.');
});

test('self-correction: past model_errors the run ends on ADK’s UNKNOWN_ERROR event', async () => {
  const { adk, native } = await assertParity(solo(), { boss: (_r, n) => toolCall('adk_handle_model_error', {}, `c-${n}`) });
  assert.equal(native.models.boss?.calls, 3);
  const end = native.ends[0] as AgentLoopEnd;
  assert.equal(end.reason, 'error');
  assert.equal(end.lastEvent?.errorCode, 'UNKNOWN_ERROR');
  assert.equal(
    end.lastEvent?.errorMessage,
    "Error in plugin 'reflect_retry_model_plugin' during 'afterModelCallback' callback: Error: The model has failed consecutively 2 times and the retry limit has been exceeded.",
  );
  assert.equal(adk.results[0]?.status, 'failed');
});

test('self-correction: model_errors: 0 declares no reflection tool, and a call to it is an unknown tool', async () => {
  const { native } = await assertParity(solo({}, { retries: { model_errors: 0 } }), {
    boss: (_r, n) => (n === 1 ? toolCall('adk_handle_model_error', {}, 'c-1') : answer('ok')),
  });
  assert.equal(native.models.boss?.requests[0]?.tools, undefined);
  assert.match(String(responses(native.events[2])[0]?.error_details), /^Function adk_handle_model_error is not found in the /);
});

test('self-correction: a MALFORMED_FUNCTION_CALL failure from an adapter is stored as the failure on both runtimes', async () => {
  // The contract carries Gemini's MALFORMED_FUNCTION_CALL as an error code, not a finish reason, so the model plugin never sees it (PR open question).
  const { native } = await assertParity(solo(), { boss: () => failure({ code: 'MALFORMED_FUNCTION_CALL', message: 'bad call' }) });
  assert.equal(native.ends[0]?.lastEvent?.errorCode, 'MALFORMED_FUNCTION_CALL');
  assert.equal(native.models.boss?.calls, 1);
});

// ── The loop on its own ──────────────────────────────────────────────────────

test('saveOutput: only a final event of the agent itself, and a schema answer that does not parse is kept as text', () => {
  const agent = { name: 'A', outputKey: 'k', outputSchema: { type: 'object', properties: {} } };
  const event = (extra: Partial<TurnEvent>): TurnEvent => ({ id: 'x', invocationId: 'e', author: 'A', actions: { stateDelta: {} }, timestamp: 1, ...extra });
  const notJson = event({ content: { role: 'model', parts: [{ text: 'not json' }] } });
  saveOutput(agent, notJson);
  assert.deepEqual(notJson.actions.stateDelta, { k: 'not json' });
  const other = event({ author: 'B', content: { role: 'model', parts: [{ text: '{}' }] } });
  saveOutput(agent, other);
  assert.deepEqual(other.actions.stateDelta, {});
  const partial = event({ partial: true, content: { role: 'model', parts: [{ text: '{}' }] } });
  saveOutput(agent, partial);
  assert.deepEqual(partial.actions.stateDelta, {});
  const blank = event({ content: { role: 'model', parts: [{ text: '  ' }] } });
  saveOutput(agent, blank);
  assert.deepEqual(blank.actions.stateDelta, {}, 'a blank answer is not saved under a schema');
});

test('the loop yields partials before the event they make, and reports an empty answer', async () => {
  const sessions = new InProcessSessionService();
  const session = await sessions.create({ appName: APP, userId: USER, sessionId: 'own' });
  await sessions.append(session, { id: 'u0000001', invocationId: 'e-1', author: 'user', content: { role: 'user', parts: [{ text: 'hi' }] }, actions: {}, timestamp: 1 });
  const adapter = new ScriptedModel('scripted/solo', () => [{ partial: true, parts: [{ type: 'thinking', text: 'hm' }] }, { partial: false, parts: [], finishReason: 'stop' }]);
  const agent: NativeAgent = { name: 'Solo', model: 'scripted/solo', instruction: 'Answer.' };
  const control = createTurnControl();
  const out: TurnEvent[] = [];
  const end = await runWithTurnControl(control, async () => {
    const loop = runAgentLoop(agent, { session, sessions, invocationId: 'e-1', stream: true, adapterFor: () => adapter });
    for (;;) {
      const next = await loop.next();
      if (next.done) return next.value;
      out.push(next.value);
    }
  });
  control.dispose();
  assert.deepEqual(out.map((e) => e.partial), [true]);
  assert.deepEqual(end, { reason: 'empty', steps: 1, lastEvent: undefined });
  assert.equal(session.events.length, 1, 'nothing stored but the user event');
});
