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
 * PAUSES INSIDE DELEGATED SUBAGENTS (WS6-2a, ADR 0110). A subagent runs in
 * its own child session (delegate.ts); an approval request or question it
 * leaves open ends its run paused, and its caller leaves the delegated
 * call open (no response stored) and ends paused too, up to the turn.
 * delegatedPauses finds such a pause from any session by walking down:
 * each call its agent left open (openCalls) leads to the child session
 * under the call's name, whose own open request or question is the pause,
 * or whose own open call leads one level further. The answer travels back
 * down the same way: before each step, the loop resumes the open call
 * whose pause the latest user message answers (agentLoop.ts), and the
 * child reads the same answer from its own session, as it would at the top.
 *
 * NESTED SYNDICATES (WS6-2b, ADR 0111). The child session of a call is the
 * one runSubagent files it under: the agent path (delegate.ts childAppName),
 * else, for a conversation stored before ADR 0111, the subagent's name
 * alone (legacyChild). A nested delegate syndicate is its orchestrator
 * there, so the walk goes on through its open calls. A nested workflow
 * syndicate holds a paused walk there instead: its own pause record (the
 * workflow's event naming every interrupt it left open, authored by the
 * workflow under the call's name) makes an approval request an agent node
 * raised, or an ask_user node's question, the pause, with the node that
 * asked at the end of the path. The walk stops there: a pause inside a
 * workflow node's own delegation does not run (lib/workflow/agentNode.ts).
 *
 * NESTED WORKFLOWS AS A ROUTE OR A NODE (ADR 0119). A workflow node that is
 * a nested workflow raises its walk's open requests again on its caller's
 * walk, on one event of its own (lib/workflow/turn.ts), so the caller's
 * walk pauses on the same ids; deepestPause follows such a request down,
 * by id, through each child session filed under entryAppName (else the
 * entry's name alone) to the node that asked. A dispatch route that is one
 * leaves its pause record as the conversation's last event (routePause).
 * A delegated nested workflow's node that is one is followed the same way.
 *
 * CONSENT AND SKILL SCRIPTS INSIDE DELEGATED SUBAGENTS (ADR 0118). A skill
 * script run asks for approval through the same `adk_request_confirmation`
 * call a gated tool stores, so the walk and the resume above carry it with
 * nothing of its own. An OAuth consent request (`adk_request_credential`)
 * the subagent left open in its child session is a pause too: the walk
 * reports it with the path (pendingConsent), the turn runner stores the
 * grant's answer once the callback has stored the grant, and the open
 * call carries that answer down as it carries an approval decision; the
 * child's own grantedCalls binds it and runs its paused call again.
 *
 * ADK stays out of this file: an ADK tool an agent still lists is asked
 * whether it gates through its own checkRequireConfirmation, by shape.
 */

import { isDeepStrictEqual } from 'node:util';

import { nativeToolOf } from '../../models/schemaNormalize.ts';
import { instructionToolOf, isTool, toolOf } from '../../tools/tool.ts';
import type { ToolConfirmation } from '../../tools/tool.ts';
import { inputRequestFrom } from '../../workflowConfig.ts';
import type { PendingInput } from '../../workflowConfig.ts';
import { approvalRequestOf, pendingApproval } from '../approvals.ts';
import type { PendingApproval } from '../approvals.ts';
import { pendingConsent } from '../credentials.ts';
import type { PendingConsent } from '../credentials.ts';
import { getFunctionCalls, getFunctionResponses } from '../events.ts';
import type { TurnEvent, TurnFunctionCall, TurnPart } from '../events.ts';
import { ASK_USER, pendingQuestion } from '../questions.ts';
import type { Session, SessionService } from '../sessions.ts';
import { childAppName, entryAppName, legacyChild } from './delegate.ts';
import { REQUEST_CONFIRMATION_CALL, REQUEST_CREDENTIAL_CALL, REQUEST_INPUT_CALL, isSegmentPrefix } from './history.ts';
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
  /** The session is a delegated subagent's, filed under its agent path (delegate.ts childAppName). */
  delegated?: boolean;
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

// ── Pauses inside delegated subagents (WS6-2a, ADR 0110) ─────────────────────

/**
 * An approval request or a question waiting inside a delegated call: the
 * open call that leads to it from the session it was found from, and on
 * down, to the agent that asked.
 */
export interface DelegatedPause {
  /** The agents from the one that made the open call down to the one that asked: `[caller, subagent, …, asker]`. */
  path: string[];
  /** The open subagent calls on that path, by id, the outermost first. */
  callIds: string[];
  /** The approval request, when the asker waits on one; its `path` is set. */
  approval?: PendingApproval;
  /** The question, when the asker waits on one; its `path` is set. */
  question?: PendingInput;
  /** The OAuth consent request, when the asker waits for a grant (ADR 0118); its `path` is set. */
  consent?: PendingConsent;
}

/** Where a session's delegated calls opened their child sessions: the store, and the caller's user and session ids. */
export interface DelegationKey {
  sessions: Pick<SessionService, 'get'>;
  userId: string;
  sessionId: string;
  /**
   * The app name of the session whose events are walked: its children are
   * filed below it (delegate.ts childAppName, ADR 0111). Absent, only the
   * children a conversation stored before ADR 0111 holds are found.
   */
  appName?: string;
  /** The session walked is a delegated subagent's, already filed under its agent path. */
  delegated?: boolean;
}

/** The deepest a chain of delegated pauses is followed: nested syndicates stop at 16 levels (lib/compile.ts). */
const MAX_DELEGATION_DEPTH = 16;

/** The engine's own long-running calls: never a delegation. */
const FRAMEWORK_CALLS = new Set([REQUEST_CONFIRMATION_CALL, REQUEST_CREDENTIAL_CALL, ASK_USER]);

const hasUserText = (e: TurnEvent): boolean =>
  e.author === 'user' && (e.content?.parts ?? []).some((p) => typeof p.text === 'string' && p.text.trim() !== '' && !p.thought);

/**
 * The calls an agent made that are still open: no later event answers it,
 * and the person has not written since. Only an agent's calls count (a
 * call in a user-authored event is never one), and the engine's own
 * framework calls are left out. `author`, when given, keeps one agent's
 * calls. Latest event first, calls in call order.
 */
export function openCalls(events: readonly TurnEvent[], author?: string): Array<{ author: string; call: TurnFunctionCall }> {
  const answered = new Set<string>();
  const open: Array<{ author: string; call: TurnFunctionCall }> = [];
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i] as TurnEvent;
    if (hasUserText(event)) break;
    for (const r of getFunctionResponses(event)) if (r.id) answered.add(r.id);
    if (!event.author || event.author === 'user' || (author !== undefined && event.author !== author)) continue;
    for (const call of getFunctionCalls(event)) {
      if (!call.id || !call.name || FRAMEWORK_CALLS.has(call.name) || answered.has(call.id)) continue;
      open.push({ author: event.author, call });
    }
  }
  return open;
}

/**
 * What waits inside the delegated call `call` that `caller` left open: the
 * child session under the call's name (where runSubagent runs it), and its
 * own open approval request or question, else a pause inside a call it left
 * open, one level down. Only the subagent's own requests count: a request
 * or question authored by anyone else is none.
 */
async function pauseBelow(key: DelegationKey, caller: string, call: TurnFunctionCall, depth: number, seen: ReadonlySet<string>): Promise<DelegatedPause | undefined> {
  const name = call.name as string;
  const id = call.id as string;
  if (depth >= MAX_DELEGATION_DEPTH || seen.has(name)) return undefined;
  // Where runSubagent filed the call (ADR 0111), else where it filed it before.
  const own = key.appName === undefined ? undefined : await key.sessions.get({ appName: childAppName({ appName: key.appName, delegated: key.delegated === true }, caller, name), userId: key.userId, sessionId: key.sessionId });
  const child = own ?? (await legacyChild(key.sessions, key, name, true));
  if (!child) return undefined;
  const here = [caller, name];
  const walked = await workflowPauseIn(key, child, name);
  if (walked) {
    const path = [caller, ...walked.path];
    return {
      path,
      callIds: [id],
      ...(walked.approval ? { approval: { ...walked.approval, path } } : {}),
      ...(walked.question ? { question: { ...walked.question, path } } : {}),
    };
  }
  const approval = pendingApproval(child.events);
  if (approval && approval.agent === name) return { path: here, callIds: [id], approval: { ...approval, path: here } };
  const question = pendingQuestion(child.events);
  if (question && question.node === name) return { path: here, callIds: [id], question: { ...question, path: here } };
  // Only the subagent's own request counts (pendingConsent already skips a user-authored one).
  const consent = pendingConsent(child.events);
  if (consent && consent.agent === name) return { path: here, callIds: [id], consent: { ...consent, path: here } };
  const [first] = await delegatedPauses({ ...key, appName: child.appName, delegated: true }, child.events, name, depth + 1, new Set([...seen, name]));
  if (!first) return undefined;
  const path = [caller, ...first.path];
  return {
    path,
    callIds: [id, ...first.callIds],
    ...(first.approval ? { approval: { ...first.approval, path } } : {}),
    ...(first.question ? { question: { ...first.question, path } } : {}),
    ...(first.consent ? { consent: { ...first.consent, path } } : {}),
  };
}

/**
 * The pause a nested workflow's walk holds in its child session (ADR 0111):
 * the workflow's own pause record, the last event, authored by the
 * workflow (`name`) at its own path with no content, names the open
 * interrupts; the approval request or ask_user question among them is the
 * pause, and the node that raised it the asker. With `id`, only that
 * interrupt counts. Undefined when the session holds no paused walk of
 * `name`'s. A node that is itself a nested workflow raised its walk's
 * requests again on its own event (lib/workflow/turn.ts, ADR 0119), so it
 * is the asker here, and workflowPauseIn goes on down.
 */
function workflowPause(events: readonly TurnEvent[], name: string, id?: string): { asker: string; approval?: PendingApproval; question?: PendingInput } | undefined {
  const record = events[events.length - 1];
  if (!record || record.author !== name || (record.content?.parts ?? []).length > 0 || record.nodeInfo?.path !== name) return undefined;
  const open = new Set((record.longRunningToolIds ?? []).filter((x) => id === undefined || x === id));
  if (open.size === 0) return undefined;
  // The latest open request the record names, an approval first: the walk stores node inputs as user turns, so a later one may follow it.
  for (const kind of [REQUEST_CONFIRMATION_CALL, REQUEST_INPUT_CALL]) {
    for (let i = events.length - 2; i >= 0; i--) {
      const event = events[i] as TurnEvent;
      if (!event.author || event.author === 'user') continue;
      for (const call of getFunctionCalls(event)) {
        if (call.name !== kind || !call.id || !open.has(call.id)) continue;
        if (kind === REQUEST_CONFIRMATION_CALL) return { asker: event.author, approval: approvalRequestOf(event, call) };
        const question = inputRequestFrom(event.author, call);
        if (question && question.id === call.id) return { asker: event.author, question };
      }
    }
  }
  return undefined;
}

/** A pause a nested workflow's walk holds: the path from the workflow down to the node that asked, and what it asks. */
export interface NestedWorkflowPause {
  /** From the workflow (the route, the node, the subagent) down to the node that asked: `[workflow, …, node]`. */
  path: string[];
  /** The approval request, its `agent` the node that asked and its `path` set. */
  approval?: PendingApproval;
  /** The question, its `node` the node that asked and its `path` set. */
  question?: PendingInput;
}

/**
 * The pause the walk of `name` holds in `child` (its child session), with
 * `id` the only interrupt that counts when given: the node that asked, or,
 * when that node is itself a nested workflow (ADR 0119), the pause its own
 * child session holds under the same id, one level further down.
 */
async function workflowPauseIn(key: DelegationKey, child: Session, name: string, id?: string, depth = 0): Promise<NestedWorkflowPause | undefined> {
  const walked = workflowPause(child.events, name, id);
  if (!walked) return undefined;
  const found = (walked.approval?.id ?? walked.question?.id) as string;
  const deeper = await nestedWorkflowPause({ ...key, appName: child.appName }, walked.asker, found, depth + 1);
  const path = deeper ? [name, ...deeper.path] : [name, walked.asker];
  const approval = deeper ? deeper.approval : walked.approval;
  const question = deeper ? deeper.question : walked.question;
  return { path, ...(approval ? { approval: { ...approval, path } } : {}), ...(question ? { question: { ...question, path } } : {}) };
}

/**
 * The pause a nested workflow run as a dispatch route or a workflow node
 * holds (ADR 0119): `name`'s child session below the session filed under
 * `key.appName` (delegate.ts entryAppName), else the one filed under its
 * name alone (legacyChild), and the paused walk there, followed down to the
 * node that asked. With `id`, only that interrupt counts: a request a node
 * raised again on its caller's walk names the one its own walk waits on.
 */
export async function nestedWorkflowPause(key: DelegationKey & { appName: string }, name: string, id?: string, depth = 0): Promise<NestedWorkflowPause | undefined> {
  if (depth >= MAX_DELEGATION_DEPTH) return undefined;
  const own = await key.sessions.get({ appName: entryAppName(key.appName, name), userId: key.userId, sessionId: key.sessionId });
  const child = own ?? (await legacyChild(key.sessions, key, name, true));
  if (!child) return undefined;
  return workflowPauseIn(key, child, name, id, depth);
}

/**
 * A dispatch route that is a nested workflow, paused (ADR 0119): the
 * conversation's last event is the route's pause record (authored by the
 * route at its own path, no content, the walk's open interrupts in
 * `longRunningToolIds`; lib/runtime/syndicateTurn.ts stores it), and the
 * route's child session holds the paused walk under one of those ids.
 * Anything stored after the record closes it. `routes`, when given, are the
 * names a record may carry.
 */
export async function routePause(key: DelegationKey & { appName: string }, events: readonly TurnEvent[], routes?: ReadonlySet<string>): Promise<(NestedWorkflowPause & { route: string }) | undefined> {
  const record = events[events.length - 1];
  const route = record?.author;
  if (!record || !route || route === 'user' || (record.content?.parts ?? []).length > 0 || record.nodeInfo?.path !== route) return undefined;
  if (routes && !routes.has(route)) return undefined;
  for (const id of record.longRunningToolIds ?? []) {
    const pause = await nestedWorkflowPause(key, route, id);
    if (pause) return { ...pause, route };
  }
  return undefined;
}

/**
 * An approval request or question found in a workflow's own session, raised
 * by a node that is a nested workflow (lib/workflow/turn.ts raises its
 * walk's requests again on the node's event, ADR 0119): the one its walk
 * waits on, with the path from the node down to the one that asked. Any
 * other request comes back as it is.
 */
export async function deepestPause<T extends PendingApproval | PendingInput>(key: DelegationKey & { appName: string }, pending: T): Promise<T> {
  const raisedBy = 'agent' in pending ? pending.agent : pending.node;
  if (!raisedBy || pending.path) return pending;
  const below = await nestedWorkflowPause(key, raisedBy, pending.id);
  const found = 'agent' in pending ? below?.approval : below?.question;
  return (found as T | undefined) ?? pending;
}

/**
 * Every pause waiting inside a delegated call still open in `events` (one
 * session's events), latest call first: each open call whose child session
 * holds an open approval request or question, at any depth. `author`, when
 * given, keeps one agent's calls. A call the person has written past is no
 * longer open, and neither is anything waiting below it.
 */
export async function delegatedPauses(
  key: DelegationKey,
  events: readonly TurnEvent[],
  author?: string,
  depth = 0,
  seen: ReadonlySet<string> = new Set(),
): Promise<DelegatedPause[]> {
  const out: DelegatedPause[] = [];
  for (const { author: caller, call } of openCalls(events, author)) {
    const pause = await pauseBelow(key, caller, call, depth, seen);
    if (pause) out.push(pause);
  }
  return out;
}

/** The interrupt a delegated pause waits on: the approval request's id, the question's, or the consent request's. */
export function interruptIdOf(pause: DelegatedPause): string | undefined {
  return pause.approval?.id ?? pause.question?.id ?? pause.consent?.id;
}

/** The open delegated calls the latest user message resumes, and the ones still waiting after it. */
export interface ResumedDelegations {
  /** The open calls whose pause the message answers, as the agent made them. */
  calls: TurnFunctionCall[];
  /** By call id: the message's parts that answer what waits below it, to be the child's next message. */
  answers: Map<string, TurnPart[]>;
  /** The open calls whose pause the message does not answer, by id. */
  waiting: string[];
  /** The agent's tools by name, as the loop runs calls against them. */
  tools: Map<string, unknown>;
}

/**
 * The delegated calls `agent` left open that the latest user message
 * answers (ADR 0110): the message's approval decisions and question
 * answers (function responses to `adk_request_confirmation` or `ask_user`)
 * and grants (to `adk_request_credential`, ADR 0118) matched, by interrupt
 * id, to the pause below each open call. Undefined when the message answers
 * none. The child binds the answer itself: an approval is checked against
 * its pinned call there (approvedCalls), a grant against its request
 * (grantedCalls), as at the top.
 */
export async function resumedDelegations(agent: NativeAgent, scope: Scope, sessions: Pick<SessionService, 'get'>): Promise<ResumedDelegations | undefined> {
  const events = scope.session.events;
  let latest: TurnEvent | undefined;
  for (let i = events.length - 1; i >= 0 && !latest; i--) if (events[i]?.author === 'user') latest = events[i];
  if (!latest) return undefined;
  const answerParts = (latest.content?.parts ?? []).filter((p) => {
    const r = p.functionResponse;
    return !!r?.id && (r.name === REQUEST_CONFIRMATION_CALL || r.name === ASK_USER || r.name === REQUEST_CREDENTIAL_CALL);
  });
  if (answerParts.length === 0) return undefined;
  const pauses = await delegatedPauses(
    { sessions, userId: scope.session.userId, sessionId: scope.session.id, appName: scope.session.appName, delegated: scope.delegated === true },
    events,
    agent.name,
  );
  if (pauses.length === 0) return undefined;
  const open = new Map(openCalls(events, agent.name).map(({ call }) => [call.id as string, call]));
  const answers = new Map<string, TurnPart[]>();
  const waiting: string[] = [];
  for (const pause of pauses) {
    const callId = pause.callIds[0] as string;
    const parts = answerParts.filter((p) => p.functionResponse?.id === interruptIdOf(pause));
    if (parts.length) answers.set(callId, [...(answers.get(callId) ?? []), ...parts]);
    else waiting.push(callId);
  }
  if (answers.size === 0) return undefined;
  const calls = [...answers.keys()].map((id) => open.get(id)).filter((c): c is TurnFunctionCall => !!c);
  return { calls, answers, waiting: waiting.filter((id) => !answers.has(id)), tools: await toolsOf(agent, scope) };
}
