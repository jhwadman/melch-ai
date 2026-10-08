/**
 * lib/runtime/native/interrupts.ts — approvals on the native loop: the
 * answer to an `adk_request_confirmation` call runs or refuses the pinned
 * call before the next model step (WS2-7a, ADR 0028, ADR 0077).
 *
 * WHY this file exists:
 *   A tool that requires approval does not run when called. The loop
 *   (agentLoop.ts) stores ADK's `adk_request_confirmation` call in place of
 *   the response, pinning the original call and its arguments, and the run
 *   ends paused. The person's answer arrives as the next user message: a
 *   function response to that call carrying `{ confirmed }`. Under ADK,
 *   LlmAgent's request-confirmation processor read it before every model
 *   step and ran the pinned call with the confirmation. This file is that
 *   processor, case for case, so an approval ADK opened before 1.0.0
 *   resumes here and the events stored are the ones ADK stored.
 *
 * BEFORE EACH STEP, AS ADK'S PROCESSOR RAN IT:
 *   1. The answers: the function responses named `adk_request_confirmation`
 *      in the latest user event (events on another branch left out), each
 *      read as `{ confirmed, hint, payload }`, or as JSON under `response`.
 *      None: nothing happens, and the step goes on as usual.
 *   2. The gates they answer: every `adk_request_confirmation` call whose id
 *      an answer names. A request authored by the user is refused
 *      (`untrusted_request`); one authored by another agent is skipped; one
 *      whose pinned call has no id or name is refused (`malformed_request`);
 *      one this agent has already answered the pinned call after is skipped,
 *      so a later step never runs the call again.
 *   3. The binding. The pinned call must be one this agent made, by id
 *      (`unknown_original_call`); its tool must be the agent's
 *      (`unregistered_tool`); the name and the arguments must equal the
 *      call's as the model made it (`tool_name_mismatch`,
 *      `arguments_mismatch`); and the tool must require approval, or have
 *      asked for it (`confirmation_not_required`). A refusal throws ADK's
 *      IntentMismatchError text and nothing runs.
 *   4. The bound calls run through the loop's own call path with the
 *      confirmation in their context: an approved call runs its tool, a
 *      refused one answers ADK's refusal. Their response is stored as its
 *      own event before the step builds its request, so the model reads it.
 *
 * Not here: a plain-text "yes" as an answer (ADK's plainTextToolConfirmation,
 * which no surface turns on), and answers delivered by a remote peer (ADK's
 * remoteDelivered, which no surface sets).
 *
 * QUESTIONS (ask_user, WS2-7b, ADR 0079) need no processor here. ADK runs its
 * request-input processor (REQUEST_INPUT_LLM_REQUEST_PROCESSOR) next, before
 * compaction, but it only re-runs a node tool (a workflow run as a tool) that
 * paused on an `adk_request_input` call; for an agent that lists no node tool
 * it returns before doing anything, and no native agent lists one (native
 * refuses workflows). An `ask_user` call is an ordinary long-running call:
 * the turn runner stores the person's next message as its function response
 * (lib/runtime/questions.ts questionAnswerPart), and the step reads the call
 * and the answer side by side from the history (history.ts), as ADK's
 * content processor does. When workflows run natively (WS4), the node-tool
 * resume is ported beside approvedCalls, in the same place in the order.
 *
 * CREDENTIALS (OAuth consent, WS6-3b, ADR 0085) run first, as ADK runs its
 * auth preprocessor (AUTH_PREPROCESSOR) before request-confirmation.
 * grantedCalls is that preprocessor, check for check, with one difference
 * in what the answer carries:
 *   1. The answers: the function responses named `adk_request_credential`
 *      in the last event with content, which must be the user's. None:
 *      nothing happens.
 *   2. The requests they answer: `adk_request_credential` calls this agent
 *      made, by id. An answer naming no such request is ignored, as ADK
 *      ignores it. So is an answer to a request an earlier grant already
 *      bound (step 3): a replayed grant runs nothing, where ADK would run
 *      the paused call again (WS5-5).
 *   3. The binding. ADK's answer carries the authorization response (a code
 *      or the redirect URL), which ADK exchanges in-process with the client
 *      secret its request event stored. Here the server's callback route has
 *      already exchanged the code and stored the grant
 *      (lib/tools/oauthConsent.ts), so the answer carries no credential:
 *      `{ credentialKey, granted: true }`, bound to the request by its
 *      credentialKey. An answer that does not bind is ignored.
 *   4. The paused calls the bound requests name (`function_call_id`, ADK's
 *      toolset requests aside) run again, from the latest event this agent
 *      authored that made them (ADK reads any author's; a call forged into
 *      a user event never runs), through the loop's own call path. The tool now reads its grant
 *      through ctx.accessToken. The response is stored before the step
 *      builds its request. A later step finds the agent's own events last,
 *      so the call runs once.
 *
 * ADK stays out of this file: an ADK tool an agent still lists is asked
 * whether it gates through its own checkRequireConfirmation, by shape.
 */

import { isDeepStrictEqual } from 'node:util';

import { nativeToolOf } from '../../models/schemaNormalize.ts';
import { instructionToolOf, isTool, toolOf } from '../../tools/tool.ts';
import type { ToolConfirmation } from '../../tools/tool.ts';
import { getFunctionCalls, getFunctionResponses } from '../events.ts';
import type { TurnEvent, TurnFunctionCall } from '../events.ts';
import type { Session } from '../sessions.ts';
import { REQUEST_CONFIRMATION_CALL, REQUEST_CREDENTIAL_CALL, isSegmentPrefix } from './history.ts';
import { isToolset } from './request.ts';
import type { NativeAgent } from './request.ts';

/** Why a confirmation does not bind to the call it pins: ADK's IntentMismatchError reasons. */
export type IntentMismatchReason =
  | 'untrusted_request'
  | 'malformed_request'
  | 'unknown_original_call'
  | 'unregistered_tool'
  | 'tool_name_mismatch'
  | 'arguments_mismatch'
  | 'confirmation_not_required';

/** A confirmation that does not bind to its pinned call: ADK's IntentMismatchError, by name and text. */
export class IntentMismatchError extends Error {
  readonly reason: IntentMismatchReason;
  readonly functionCallId?: string;
  constructor(reason: IntentMismatchReason, functionCallId?: string) {
    super(`Tool confirmation rejected${functionCallId ? ` for function call '${functionCallId}'` : ''}: ${reason}.`);
    this.name = 'IntentMismatchError';
    this.reason = reason;
    if (functionCallId !== undefined) this.functionCallId = functionCallId;
  }
}

/** The pinned calls an answer lets run, each with its confirmation, in the order the gates were stored. */
export interface ApprovedCalls {
  calls: TurnFunctionCall[];
  confirmations: Map<string, ToolConfirmation>;
  /** The agent's tools by name, as the loop runs calls against them. */
  tools: Map<string, unknown>;
}

interface Scope {
  session: Session;
  invocationId: string;
  branch?: string;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** ADK's parseToolConfirmation: `{ confirmed, hint, payload }`, or the same as JSON under `response`. */
function parseConfirmation(response: Record<string, unknown>): ToolConfirmation {
  const keys = Object.keys(response);
  const fields = (keys.length === 1 && keys[0] === 'response' ? JSON.parse(String(response.response)) : response) as Record<string, unknown>;
  return { hint: typeof fields.hint === 'string' ? fields.hint : '', confirmed: fields.confirmed === true, payload: fields.payload };
}

/** Step 1: the answers in the latest user event, by the request id each names. */
function answersIn(events: readonly TurnEvent[]): Map<string, ToolConfirmation> {
  const answers = new Map<string, ToolConfirmation>();
  let latest: TurnEvent | undefined;
  for (let i = events.length - 1; i >= 0 && !latest; i--) if (events[i]?.author === 'user') latest = events[i];
  if (!latest) return answers;
  for (const r of getFunctionResponses(latest)) {
    if (r.name !== REQUEST_CONFIRMATION_CALL || !r.id || !r.response) continue;
    answers.set(r.id, parseConfirmation(r.response as Record<string, unknown>));
  }
  return answers;
}

/** The agent's callable tools by name, toolsets expanded, as ADK's canonicalTools lists them. */
async function toolsOf(agent: NativeAgent, scope: Scope): Promise<Map<string, unknown>> {
  const state = scope.session.state;
  const toolsetContext = {
    agentName: agent.name,
    invocationId: scope.invocationId,
    state: { get: (key: string) => state[key], has: (key: string) => Object.hasOwn(state, key) },
  };
  const tools = new Map<string, unknown>();
  for (const union of agent.tools ?? []) {
    const expanded = isToolset(union) ? await union.getTools(toolsetContext) : [union];
    for (const listed of expanded) {
      if (nativeToolOf(listed) || instructionToolOf(listed)) continue;
      const name = (listed as { name?: unknown })?.name;
      if (typeof name === 'string') tools.set(name, toolOf(listed) ?? listed);
    }
  }
  return tools;
}

/** Whether `tool` gates the call: an own Tool's requiresApproval, an ADK tool's checkRequireConfirmation. */
async function gates(tool: unknown, args: Record<string, unknown>, context: unknown): Promise<boolean> {
  if (isTool(tool)) return tool.requiresApproval === true;
  const check = (tool as { checkRequireConfirmation?: (a: unknown, c: unknown) => unknown }).checkRequireConfirmation;
  return typeof check === 'function' ? (await check.call(tool, args, context)) === true : false;
}

/**
 * The pinned calls the latest user message approves or refuses, bound to
 * the calls this agent made; undefined when it answers no open request.
 * Throws IntentMismatchError when an answer does not bind (nothing runs).
 * `contextFor` makes the context a tool's gate check reads.
 */
export async function approvedCalls(agent: NativeAgent, scope: Scope, contextFor: (callId: string) => unknown): Promise<ApprovedCalls | undefined> {
  const all = scope.session.events;
  const events = scope.branch ? all.filter((e) => !e.branch || isSegmentPrefix(scope.branch, e.branch)) : all;
  if (events.length === 0) return undefined;
  const answers = answersIn(events);
  if (answers.size === 0) return undefined;

  // Step 2: the gates the answers name.
  const candidates: Array<{ pinned: TurnFunctionCall; confirmation: ToolConfirmation }> = [];
  for (const [index, event] of events.entries()) {
    for (const call of getFunctionCalls(event)) {
      const confirmation = call.id ? answers.get(call.id) : undefined;
      if (!confirmation || call.name !== REQUEST_CONFIRMATION_CALL) continue;
      if (event.author !== agent.name) {
        if (event.author === 'user') throw new IntentMismatchError('untrusted_request', call.id);
        continue;
      }
      const pinned = isRecord(call.args) ? call.args.originalFunctionCall : undefined;
      if (!isRecord(pinned)) continue;
      if (!pinned.id || !pinned.name) throw new IntentMismatchError('malformed_request', call.id);
      const pinnedCall = pinned as TurnFunctionCall;
      const answeredAfter = events
        .slice(index + 1)
        .some((e) => e.author === agent.name && getFunctionResponses(e).some((r) => r.id === pinnedCall.id));
      if (!answeredAfter) candidates.push({ pinned: pinnedCall, confirmation });
    }
  }
  if (candidates.length === 0) return undefined;

  // Step 3: each pinned call bound to the call the agent made, by id, name and arguments.
  const tools = await toolsOf(agent, scope);
  const made = new Map<string, TurnFunctionCall>();
  const requested = new Set<string>();
  for (const event of events) {
    if (event.author !== agent.name) continue;
    for (const call of getFunctionCalls(event)) if (call.id && call.name !== REQUEST_CONFIRMATION_CALL) made.set(call.id, call);
    for (const id of Object.keys(event.actions?.requestedToolConfirmations ?? {})) requested.add(id);
  }
  const bound = new Map<string, { call: TurnFunctionCall; confirmation: ToolConfirmation }>();
  for (const { pinned, confirmation } of candidates) {
    const id = pinned.id as string;
    const original = made.get(id);
    if (!original) throw new IntentMismatchError('unknown_original_call', id);
    const tool = tools.get(pinned.name as string);
    if (!tool) throw new IntentMismatchError('unregistered_tool', id);
    if (original.name !== pinned.name) throw new IntentMismatchError('tool_name_mismatch', id);
    if (!isDeepStrictEqual(original.args ?? {}, pinned.args ?? {})) throw new IntentMismatchError('arguments_mismatch', id);
    if (!(await gates(tool, original.args ?? {}, contextFor(id))) && !requested.has(id)) throw new IntentMismatchError('confirmation_not_required', id);
    bound.set(id, { call: pinned, confirmation });
  }
  return {
    calls: [...bound.values()].map((b) => b.call),
    confirmations: new Map([...bound].map(([id, b]) => [id, b.confirmation])),
    tools,
  };
}

// ── Credentials (ADK's auth preprocessor) ────────────────────────────────────

/** ADK's prefix for a toolset's own credential request, which resumes no call. */
const TOOLSET_AUTH_CREDENTIAL_ID_PREFIX = '_adk_toolset_auth_';

/** The paused calls a granted consent lets run again, from the event that made them. */
export interface GrantedCalls {
  calls: TurnFunctionCall[];
  /** The agent's tools by name, as the loop runs calls against them. */
  tools: Map<string, unknown>;
}

/** Whether an answer binds to the request it names: granted, for the provider the request named. */
function bindsGrant(config: Record<string, unknown>, response: unknown): boolean {
  if (!isRecord(response) || response.granted !== true) return false;
  return typeof config.credentialKey === 'string' && config.credentialKey !== '' && response.credentialKey === config.credentialKey;
}

/**
 * The paused calls the latest user message resumes by answering this
 * agent's credential requests; undefined when it answers none (ADK's
 * AuthPreprocessor, the exchange left to the callback route).
 */
export async function grantedCalls(agent: NativeAgent, scope: Scope): Promise<GrantedCalls | undefined> {
  const events = scope.session.events;
  if (events.length === 0) return undefined;
  let last: TurnEvent | undefined;
  for (let i = events.length - 1; i >= 0 && !last; i--) if (events[i]?.content !== undefined) last = events[i];
  if (!last || last.author !== 'user') return undefined;
  const answers = new Map<string, unknown>();
  for (const r of getFunctionResponses(last)) if (r.name === REQUEST_CREDENTIAL_CALL && r.id) answers.set(r.id, r.response);
  if (answers.size === 0) return undefined;
  // The answers earlier events gave the same requests: one that bound closed its request (below).
  const earlier = new Map<string, unknown[]>();
  for (const event of events) {
    if (event === last) break;
    for (const r of getFunctionResponses(event)) {
      if (r.name === REQUEST_CREDENTIAL_CALL && r.id && answers.has(r.id)) earlier.set(r.id, [...(earlier.get(r.id) ?? []), r.response]);
    }
  }

  // The requests this agent made, by id.
  const requests = new Map<string, { config: Record<string, unknown>; args: Record<string, unknown> }>();
  for (const event of events) {
    if (event.author !== agent.name) continue;
    for (const call of getFunctionCalls(event)) {
      if (!call.id || !answers.has(call.id) || call.name !== REQUEST_CREDENTIAL_CALL || !isRecord(call.args)) continue;
      const config = call.args.auth_config ?? call.args.authConfig;
      if (isRecord(config)) requests.set(call.id, { config, args: call.args });
    }
  }
  const resume = new Set<string>();
  for (const [id, response] of answers) {
    const request = requests.get(id);
    if (!request || !bindsGrant(request.config, response)) continue;
    // A request a grant already bound is closed (WS5-5): a replayed grant runs nothing, as a replayed approval runs nothing. ADK resumes it again.
    if ((earlier.get(id) ?? []).some((before) => bindsGrant(request.config, before))) continue;
    const callId = request.args.function_call_id ?? request.args.functionCallId;
    if (typeof callId === 'string' && callId && !callId.startsWith(TOOLSET_AUTH_CREDENTIAL_ID_PREFIX)) resume.add(callId);
  }
  if (resume.size === 0) return undefined;

  // As ADK: the latest event before the answer that made any of the calls, those calls only. Only one this agent authored (WS5-5):
  // ADK takes any author's, so a call forged into a user event with the paused call's id would run with the forged arguments.
  for (let i = events.length - 2; i >= 0; i--) {
    if (events[i]?.author !== agent.name) continue;
    const calls = getFunctionCalls(events[i] as TurnEvent);
    if (!calls.some((c) => c.id && resume.has(c.id))) continue;
    return { calls: calls.filter((c) => c.id && resume.has(c.id)), tools: await toolsOf(agent, scope) };
  }
  return undefined;
}
