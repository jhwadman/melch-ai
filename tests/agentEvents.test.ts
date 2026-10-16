/**
 * tests/agentEvents.test.ts — delegated runs report live through
 * `events.onAgentEvent` (ADR 0135, lib/runtime/native/delegate.ts).
 *
 * Without the observer a delegated run is visible only after the fact. With
 * it, each delegated run streams: its thinking and text arrive as partial
 * events while it runs, then each event it stores, each carrying the
 * delegation path and the id of the call that started it. Cases: nested
 * delegation (Boss → Researcher → Fetcher), two delegations in one step
 * running at once, the answering agent's callbacks unchanged, the stored
 * sessions unchanged, and an observer that throws. Through runSyndicateTurn,
 * scripted models, in-memory sessions, no network.
 */
process.env.OTEL_CONSOLE_SPANS = 'false';
delete process.env.SUPABASE_URL;
delete process.env.SUPABASE_SERVICE_ROLE_KEY;

import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { FinalModelResponse, ModelRequest, ModelResponse } from '../lib/models/contract.ts';
import { resetCircuits } from '../lib/models/circuitBreaker.ts';
import type { SyndicateYamlConfig } from '../lib/loadSyndicate.ts';
import { getFunctionCalls, getFunctionResponses } from '../lib/runtime/events.ts';
import type { TurnEvent } from '../lib/runtime/events.ts';
import { InProcessSessionService } from '../lib/runtime/sessions.ts';
import { runSyndicateTurn } from '../lib/runtime/syndicateTurn.ts';
import type { AgentBranch, TurnEvents } from '../lib/runtime/syndicateTurn.ts';
import { validateSyndicateConfig } from '../lib/syndicateSchema.ts';
import { ScriptedModel, answer, shimResolver } from './helpers/scriptedModel.ts';
import type { ModelScript } from './helpers/scriptedModel.ts';
import { virtualClock } from './helpers/virtualClock.ts';

/** A model answer calling every `[name, id, request]` in one step. */
const calling = (...calls: Array<[string, string, string]>): FinalModelResponse => ({
  partial: false,
  parts: calls.map(([name, id, request]) => ({ type: 'toolCall' as const, id, name, args: { request } })),
  finishReason: 'tool_call',
});

const toolResults = (req: ModelRequest): number => req.messages.filter((m) => m.role === 'tool').flatMap((m) => m.parts).length;

/** As a provider answers: thinking and text partials only when the request streams, then the final. */
function thinkingThenAnswer(thought: string, ...chunks: string[]): (req: ModelRequest) => ModelResponse[] {
  return (req) => [
    ...(req.stream
      ? [
          { partial: true, parts: [{ type: 'thinking', text: thought }] } as ModelResponse,
          ...chunks.map((text) => ({ partial: true, parts: [{ type: 'text', text }] }) as ModelResponse),
        ]
      : []),
    answer(chunks.join('')),
  ];
}

/** A delegate syndicate: Boss over the Researcher and the Writer. */
function team(): SyndicateYamlConfig {
  return validateSyndicateConfig(
    {
      syndicate_name: 'Team',
      orchestrator: { name: 'Boss', model: 'scripted/boss', instruction: 'Delegate.' },
      subagents: [
        { name: 'Researcher', model: 'scripted/researcher', instruction: 'Research.', description: 'Researches.' },
        { name: 'Writer', model: 'scripted/writer', instruction: 'Write.', description: 'Writes.' },
      ],
    },
    'agent-events',
  ) as SyndicateYamlConfig;
}

/** Researcher delegating to Fetcher: a nested syndicate referenced by the team's Researcher entry. */
function nestedTeam(): { config: SyndicateYamlConfig; loadNested: (ref: string) => SyndicateYamlConfig } {
  const inner = validateSyndicateConfig(
    {
      syndicate_name: 'ResearchDesk',
      orchestrator: { name: 'Researcher', model: 'scripted/researcher', instruction: 'Research.', description: 'Researches.' },
      subagents: [{ name: 'Fetcher', model: 'scripted/fetcher', instruction: 'Fetch.', description: 'Fetches.' }],
    },
    'agent-events-inner',
  ) as SyndicateYamlConfig;
  const config = validateSyndicateConfig(
    {
      syndicate_name: 'Team',
      orchestrator: { name: 'Boss', model: 'scripted/boss', instruction: 'Delegate.' },
      subagents: [{ name: 'Researcher', yaml_reference: 'research_desk.yaml', description: 'Researches.' }],
    },
    'agent-events-outer',
  ) as SyndicateYamlConfig;
  return { config, loadNested: () => inner };
}

interface Seen {
  event: TurnEvent;
  branch: AgentBranch;
}

async function runTurn(
  config: SyndicateYamlConfig,
  scripts: Record<string, ModelScript>,
  events: TurnEvents,
  extra: { loadNested?: (ref: string) => SyndicateYamlConfig; streaming?: boolean } = {},
) {
  resetCircuits();
  const models = Object.fromEntries(Object.entries(scripts).map(([k, s]) => [k, new ScriptedModel(`scripted/${k}`, s)]));
  const sessionService = new InProcessSessionService();
  const result = await runSyndicateTurn({
    config,
    parts: [{ text: 'Go.' }],
    appName: 'app',
    userId: 'u',
    sessionId: 's',
    sessionService,
    compile: { resolveModel: shimResolver(models), log: () => {}, ...(extra.loadNested ? { loadNested: extra.loadNested as never } : {}) },
    trace: false,
    ...(extra.streaming ? { streaming: true } : {}),
    events,
  });
  const stored = async (appName: string): Promise<TurnEvent[]> => (await sessionService.get({ appName, userId: 'u', sessionId: 's' }))?.events ?? [];
  return { result, models, stored };
}

/** An event with ids and times dropped, for comparing stores across runs. */
const shape = (e: TurnEvent) => ({ author: e.author, content: e.content, actions: e.actions?.stateDelta });

const textOf = (e: TurnEvent, thought: boolean) =>
  (e.content?.parts ?? [])
    .filter((p) => typeof p.text === 'string' && (p.thought === true) === thought)
    .map((p) => p.text)
    .join('');

test('a delegated subagent streams its thinking, text, tool calls and answer live, with its path and call id', async () => {
  const { config, loadNested } = nestedTeam();
  const seen: Seen[] = [];
  const top: TurnEvent[] = [];
  const { result } = await runTurn(
    config,
    {
      boss: (req) => (toolResults(req) === 0 ? calling(['Researcher', 'call-r', 'find X']) : answer('X is 42.')),
      researcher: (req) =>
        toolResults(req) === 0
          ? [...(req.stream ? [{ partial: true, parts: [{ type: 'thinking', text: 'I should fetch.' }] } as ModelResponse] : []), calling(['Fetcher', 'call-f', 'fetch X'])]
          : thinkingThenAnswer('Fetched.', 'X ', 'is 42')(req),
      fetcher: thinkingThenAnswer('Reading the page.', 'Page ', 'says 42'),
    },
    { onAgentEvent: (event, branch) => seen.push({ event, branch }), onEvent: (e) => top.push(e) },
    { loadNested },
  );
  assert.equal(result.status, 'completed', result.error?.message);
  assert.equal(result.text, 'X is 42.');

  const researcher = seen.filter((s) => s.branch.agent === 'Researcher');
  const fetcher = seen.filter((s) => s.branch.agent === 'Fetcher');
  assert.deepEqual([...new Set(researcher.map((s) => s.branch.path.join('/')))], ['Boss/Researcher']);
  assert.deepEqual([...new Set(researcher.map((s) => s.branch.callId))], ['call-r']);
  assert.deepEqual([...new Set(fetcher.map((s) => s.branch.path.join('/')))], ['Boss/Researcher/Fetcher']);
  assert.deepEqual([...new Set(fetcher.map((s) => s.branch.callId))], ['call-f']);

  // The Researcher's thinking, its call to the Fetcher, the Fetcher's whole run, then the Researcher's answer: in that order.
  const order = seen.map((s) => {
    const e = s.event;
    if (getFunctionCalls(e).length) return `${s.branch.agent}:call:${getFunctionCalls(e)[0]!.name}`;
    if (getFunctionResponses(e).length) return `${s.branch.agent}:result:${getFunctionResponses(e)[0]!.name}`;
    if (e.partial && textOf(e, true)) return `${s.branch.agent}:thinking:${textOf(e, true)}`;
    if (e.partial) return `${s.branch.agent}:delta:${textOf(e, false)}`;
    if (e.author === 'user') return `${s.branch.agent}:user`;
    return `${s.branch.agent}:final:${textOf(e, false)}`;
  });
  assert.deepEqual(order, [
    'Researcher:thinking:I should fetch.',
    'Researcher:call:Fetcher',
    'Fetcher:thinking:Reading the page.',
    'Fetcher:delta:Page ',
    'Fetcher:delta:says 42',
    'Fetcher:final:Page says 42',
    'Researcher:result:Fetcher',
    'Researcher:thinking:Fetched.',
    'Researcher:delta:X ',
    'Researcher:delta:is 42',
    'Researcher:final:X is 42',
  ]);

  // onEvent keeps its meaning: the answering agent's events only.
  assert.ok(top.length > 0);
  assert.ok(top.every((e) => e.author === 'Boss' || e.author === 'user'), `onEvent saw ${[...new Set(top.map((e) => e.author))].join(', ')}`);
});

test('two delegations in one step run at once and their events interleave, told apart by call id', async () => {
  const clock = virtualClock();
  const seen: Seen[] = [];
  const slow = (name: string, ms: number): ModelScript => async (req) => {
    const out: ModelResponse[] = [];
    if (req.stream) out.push({ partial: true, parts: [{ type: 'thinking', text: `${name} thinks` }] } as ModelResponse);
    await clock.sleep(ms);
    out.push(answer(`${name} done`));
    return out;
  };
  const { result } = await runTurn(
    team(),
    {
      boss: (req) => (toolResults(req) === 0 ? calling(['Researcher', 'call-a', 'a'], ['Writer', 'call-b', 'b']) : answer('Both done.')),
      researcher: slow('Researcher', 300),
      writer: slow('Writer', 100),
    },
    { onAgentEvent: (event, branch) => seen.push({ event, branch }) },
  );
  assert.equal(result.status, 'completed', result.error?.message);

  const finals = seen.filter((s) => !s.event.partial && s.event.author !== 'user').map((s) => `${s.branch.callId}:${textOf(s.event, false)}`);
  assert.deepEqual(finals, ['call-b:Writer done', 'call-a:Researcher done'], 'the faster child finishes first: the stream is live, not replayed in call order');
  const byCall = new Map<string, Set<string>>();
  for (const s of seen) byCall.set(s.branch.callId ?? '', (byCall.get(s.branch.callId ?? '') ?? new Set()).add(s.branch.path.join('/')));
  assert.deepEqual(Object.fromEntries([...byCall].map(([k, v]) => [k, [...v]])), { 'call-a': ['Boss/Researcher'], 'call-b': ['Boss/Writer'] });
  assert.deepEqual(
    seen.filter((s) => s.event.partial).map((s) => textOf(s.event, true)).sort(),
    ['Researcher thinks', 'Writer thinks'],
  );
});

test('the observer changes nothing the sessions store, and nothing onTextDelta receives', async () => {
  const scripts = (): Record<string, ModelScript> => ({
    boss: (req) => (toolResults(req) === 0 ? calling(['Researcher', 'call-r', 'find X']) : (req.stream ? [{ partial: true, parts: [{ type: 'text', text: 'X is ' }] } as ModelResponse, answer('X is 42.')] : answer('X is 42.'))),
    researcher: thinkingThenAnswer('Hmm.', 'Forty', '-two'),
    writer: () => answer('unused'),
  });
  const deltasWith: string[] = [];
  const deltasWithout: string[] = [];
  const withObserver = await runTurn(team(), scripts(), { onAgentEvent: () => {}, onTextDelta: (d) => deltasWith.push(d) }, { streaming: true });
  const without = await runTurn(team(), scripts(), { onTextDelta: (d) => deltasWithout.push(d) }, { streaming: true });
  assert.equal(withObserver.result.text, without.result.text);
  assert.deepEqual(deltasWith, deltasWithout);
  for (const app of ['app', 'app/Boss/Researcher']) {
    assert.deepEqual((await withObserver.stored(app)).map(shape), (await without.stored(app)).map(shape), `${app} stores the same events`);
  }
  // Only with the observer does the subagent's request stream.
  assert.equal(withObserver.models.researcher!.requests[0]!.stream, true);
  assert.notEqual(without.models.researcher!.requests[0]!.stream, true);
});

test('an observer that throws is ignored and the turn completes', async () => {
  const { result } = await runTurn(
    team(),
    {
      boss: (req) => (toolResults(req) === 0 ? calling(['Writer', 'call-w', 'w']) : answer('ok')),
      researcher: () => answer('unused'),
      writer: thinkingThenAnswer('t', 'written'),
    },
    {
      onAgentEvent: () => {
        throw new Error('observer bug');
      },
    },
  );
  assert.equal(result.status, 'completed', result.error?.message);
  assert.equal(result.text, 'ok');
});
