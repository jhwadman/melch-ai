/**
 * tests/fixtures/sessions/scenarios.ts — the conversations the session
 * fixtures freeze, shared by the generator (generate.ts, which writes them)
 * and tests/sessionFixtures.test.ts (which reads and resumes them).
 *
 * Each scenario is a syndicate, its scripted models and the messages that
 * drive it through runSyndicateTurn. A script answers from the REQUEST, not
 * from its call count, so the same models that wrote a paused session can
 * resume it from the stored events alone. Function calls carry no id, as
 * Gemini sends them; ADK assigns the `adk-<uuid>` id the stored row holds.
 */

import { FunctionTool } from '@google/adk';
import type { LlmRequest, LlmResponse } from '@google/adk';
import { z } from 'zod';

import type { SyndicateYamlConfig } from '../../../lib/loadSyndicate.ts';
import { validateSyndicateConfig } from '../../../lib/syndicateSchema.ts';
import { registerTool } from '../../../lib/toolRegistry.ts';
import { ScriptedLlm, text } from '../../helpers/scriptedLlm.ts';

export const APP = 'fixtures';
export const USER = 'user-1';

/** Notes the gated tool actually sent: empty until an approval runs it. */
export const sentNotes: string[] = [];

/** A tool behind an approval gate (fixture 03). */
export const SEND_NOTE = 'fixture_send_note';
/** An ungated lookup (fixture 06). */
export const LOOKUP = 'fixture_lookup';

registerTool(
  SEND_NOTE,
  new FunctionTool({
    name: SEND_NOTE,
    description: 'Send a note to an address.',
    parameters: z.object({ to: z.string() }),
    execute: async ({ to }) => {
      sentNotes.push(to);
      return `sent to ${to}`;
    },
  }),
  { override: true },
);

registerTool(
  LOOKUP,
  new FunctionTool({
    name: LOOKUP,
    description: 'Look up a ticker.',
    parameters: z.object({ ticker: z.string() }),
    execute: async ({ ticker }) => `${ticker}: 104.20 USD`,
  }),
  { override: true },
);

/** A model reply that calls one tool with no id, as Gemini sends it. */
export function geminiCall(name: string, args: Record<string, unknown>): LlmResponse {
  return { content: { role: 'model', parts: [{ functionCall: { name, args } }] } } as LlmResponse;
}

/** The function response the request ends with, when the model is being handed a tool result. */
export function lastFunctionResponse(req: LlmRequest): { name?: string; response?: Record<string, unknown> } | undefined {
  return (req.contents.at(-1)?.parts ?? []).find((p) => p.functionResponse)?.functionResponse;
}

/** The text of the request's last content: a node agent's input. */
export function lastText(req: LlmRequest): string {
  return (req.contents.at(-1)?.parts ?? []).map((p) => p.text ?? '').join('');
}

/**
 * Gemini's opaque thought-continuity blob. Real ones run to kilobytes of
 * base64; this one is deterministic and long enough to be unmistakable.
 */
export const THOUGHT_SIGNATURE = Buffer.from('melchizedek fixture thought signature / '.repeat(12)).toString('base64');

export interface Scenario {
  /** File name without extension, and the order fixtures are listed in. */
  name: string;
  description: string;
  sessionId: string;
  config: SyndicateYamlConfig;
  /** The scripted models, built fresh for every run. */
  models(): Record<string, ScriptedLlm>;
  /** The user messages, one per turn, as runSyndicateTurn parts. */
  turns: Array<Array<Record<string, unknown>>>;
  /** The status the last turn ends with. */
  endsWith: 'completed' | 'input-required';
  /** Also write the verbatim form a row-per-event store keeps (`<name>.verbatim.json`). */
  verbatimToo?: boolean;
}

const config = (raw: Record<string, unknown>): SyndicateYamlConfig => validateSyndicateConfig(raw, 'session-fixture') as SyndicateYamlConfig;

export const scenarios: Scenario[] = [
  {
    name: '01-delegate',
    description:
      'DELEGATE: the orchestrator calls a subagent (an AgentTool) with a request argument and relays its answer. The subagent runs in its own session row, keyed by its own name as appName and the conversation id.',
    sessionId: 'conv-01',
    config: config({
      syndicate_name: 'Delegate Fixture',
      memory_system: 'internal-only',
      orchestrator: { name: 'Boss', model: 'scripted/boss', instruction: 'Delegate to Scout, then relay its answer.' },
      subagents: [{ name: 'Scout', model: 'scripted/scout', instruction: 'Answer the request.', description: 'Finds things' }],
    }),
    models: () => ({
      boss: new ScriptedLlm('scripted/boss', (req) => {
        const r = lastFunctionResponse(req);
        return r ? text(`Scout says: ${String(r.response?.result ?? '')}`) : geminiCall('Scout', { request: 'look in the attic' });
      }),
      scout: new ScriptedLlm('scripted/scout', () => text('it is in the attic')),
    }),
    turns: [[{ text: 'find the thing' }]],
    endsWith: 'completed',
  },
  {
    name: '02-plan-dispatch',
    description:
      'PLAN-DISPATCH: the classifier picks a route and the route answers directly in the shared session. The classifier runs in a throwaway in-memory lane, so none of its events are stored.',
    sessionId: 'conv-02',
    config: config({
      syndicate_name: 'Dispatch Fixture',
      memory_system: 'internal-only',
      orchestrator: { name: 'Router', model: 'scripted/router', instruction: 'Classify.' },
      subagents: [
        { name: 'Chat', model: 'scripted/chat', instruction: 'Chat.', description: 'small talk' },
        { name: 'Research', model: 'scripted/research', instruction: 'Research.', description: 'research' },
      ],
      dispatch: { default_route: 'Chat' },
    }),
    models: () => ({
      router: new ScriptedLlm('scripted/router', () => text('{"route":"Research","reason":"needs sources"}')),
      chat: new ScriptedLlm('scripted/chat', () => text('chat answer')),
      research: new ScriptedLlm('scripted/research', () => text('research answer: three sources agree')),
    }),
    turns: [[{ text: 'what do the sources say?' }]],
    endsWith: 'completed',
  },
  {
    name: '03-open-approval',
    description:
      'An open approval (ADR 0028): the orchestrator called a tool in its require_approval list, ADK recorded an adk_request_confirmation call pinning the original call, and the turn ended input-required.',
    sessionId: 'conv-03',
    config: config({
      syndicate_name: 'Approval Fixture',
      memory_system: 'internal-only',
      orchestrator: {
        name: 'Boss',
        model: 'scripted/boss',
        instruction: 'Send notes.',
        tools: [SEND_NOTE],
        require_approval: [SEND_NOTE],
      },
      subagents: [],
    }),
    models: () => ({
      boss: new ScriptedLlm('scripted/boss', (req) => {
        const r = lastFunctionResponse(req);
        return r ? text(`done ${JSON.stringify(r.response ?? null)}`) : geminiCall(SEND_NOTE, { to: 'ops@acme.test' });
      }),
    }),
    turns: [[{ text: 'tell ops the build is green' }]],
    endsWith: 'input-required',
  },
  {
    name: '04-open-question',
    description:
      'An open ask_user question: the orchestrator called ask_user (a long-running tool), the run ended with no response to the call, and the turn ended input-required.',
    sessionId: 'conv-04',
    config: config({
      syndicate_name: 'Question Fixture',
      memory_system: 'internal-only',
      orchestrator: { name: 'Boss', model: 'scripted/boss', instruction: 'Help.', tools: ['ask_user'] },
      subagents: [],
    }),
    models: () => ({
      boss: new ScriptedLlm('scripted/boss', (req) => {
        const r = lastFunctionResponse(req);
        return r ? text(`using ${JSON.stringify(r.response ?? null)}`) : geminiCall('ask_user', { question: 'Which account?', options: ['personal', 'work'] });
      }),
    }),
    turns: [[{ text: 'pay the invoice' }]],
    endsWith: 'input-required',
  },
  {
    name: '05-workflow-ask-user',
    description:
      'A workflow paused at an ask_user node: Triage ran, the Confirm node raised adk_request_input with the draft as its payload, and the turn ended input-required before Publisher.',
    sessionId: 'conv-05',
    config: config({
      syndicate_name: 'Workflow Fixture',
      memory_system: 'internal-only',
      orchestrator: { name: 'Triage', description: 'Triage', model: 'scripted/triage', instruction: 'Draft.' },
      subagents: [{ name: 'Publisher', description: 'Publisher', model: 'scripted/publisher', instruction: 'Publish.' }],
      workflow: { edges: [['START', 'Triage', 'Confirm', 'Publisher']], nodes: { Confirm: { ask_user: 'Publish?' } } },
    }),
    models: () => ({
      triage: new ScriptedLlm('scripted/triage', () => text('the draft')),
      publisher: new ScriptedLlm('scripted/publisher', (req) => text(`published ${lastText(req)}`)),
    }),
    turns: [[{ text: 'write the release note' }]],
    endsWith: 'input-required',
  },
  {
    name: '06-thought-signature',
    description:
      'A model turn as Gemini writes it: a thought part, then a functionCall part carrying a thoughtSignature, then the tool result and a final answer whose text part carries a signature too.',
    sessionId: 'conv-06',
    config: config({
      syndicate_name: 'Signature Fixture',
      memory_system: 'internal-only',
      orchestrator: { name: 'Analyst', model: 'scripted/analyst', instruction: 'Look prices up.', tools: [LOOKUP] },
      subagents: [],
    }),
    models: () => ({
      analyst: new ScriptedLlm('scripted/analyst', (req) => {
        const r = lastFunctionResponse(req);
        if (r) {
          return {
            content: { role: 'model', parts: [{ text: `Latest quote: ${String(r.response?.result ?? '')}.`, thoughtSignature: THOUGHT_SIGNATURE }] },
            finishReason: 'STOP',
            usageMetadata: { promptTokenCount: 212, candidatesTokenCount: 12, thoughtsTokenCount: 0, totalTokenCount: 224 },
            turnComplete: true,
          } as LlmResponse;
        }
        return {
          content: {
            role: 'model',
            parts: [
              { text: '**Checking the quote**\nThe user wants the latest MU price, so I will look it up.', thought: true },
              { functionCall: { name: LOOKUP, args: { ticker: 'MU' } }, thoughtSignature: THOUGHT_SIGNATURE },
            ],
          },
          finishReason: 'STOP',
          usageMetadata: { promptTokenCount: 180, candidatesTokenCount: 9, thoughtsTokenCount: 41, totalTokenCount: 230 },
        } as LlmResponse;
      }),
    }),
    turns: [[{ text: 'where is MU trading?' }]],
    endsWith: 'completed',
    // Trimming rewrites exactly this case, so both stored forms are frozen.
    verbatimToo: true,
  },
  {
    name: '07-two-turns',
    description: 'A two-turn conversation with one agent: the second turn reads the first from the stored session.',
    sessionId: 'conv-07',
    config: config({
      syndicate_name: 'Conversation Fixture',
      memory_system: 'internal-only',
      orchestrator: { name: 'Solo', model: 'scripted/solo', instruction: 'Converse.' },
      subagents: [],
    }),
    models: () => ({
      solo: new ScriptedLlm('scripted/solo', (req) => text(lastText(req) === 'hello' ? 'first answer' : 'second answer')),
    }),
    turns: [[{ text: 'hello' }], [{ text: 'again' }]],
    endsWith: 'completed',
  },
];

export function scenario(name: string): Scenario {
  const s = scenarios.find((x) => x.name === name);
  if (!s) throw new Error(`no session fixture scenario '${name}'`);
  return s;
}
