/**
 * lib/runtime/native/agentLoop.ts — the native loop for one agent: a model
 * step, the step's tool calls, their results fed back, until the model
 * stops calling tools or the turn stops it (ADR 0045, ADR 0066).
 *
 * WHY this file exists:
 *   On the ADK runtime this is LlmAgent.runAsyncImpl: run one step
 *   (lib/runtime/native/step.ts is the native step), run the answer's
 *   function calls (ADK's handleFunctionCallList), store the response
 *   event, and step again unless the last event is a final response. A
 *   session either runtime wrote must be one the other continues, so every
 *   event this loop stores is the one ADK stores for the same answer and the
 *   same tool results, ids and times aside. tests/nativeLoop.test.ts runs
 *   the boundary suite's single-agent cases both ways and compares.
 *
 * ONE STEP, AS ADK RUNS IT:
 *   1. The model step (runModelStep). Its partial events are yielded as they
 *      arrive and stored nowhere, so drainAgentStream hands their text to
 *      onTextDelta exactly as it does on the ADK path. With a
 *      `fallback_model`, the step runs once per leaf adapter (ADR 0053): a
 *      provider-side failure before anything was produced is not stored,
 *      and the fallback answers the same request under its own model id, by
 *      ADK's FallbackLlm's rules and the shared circuit breaker (ADR 0044).
 *   2. The answer's calls run in parallel, each with its own context (its
 *      own state delta and actions). Results are kept in call order:
 *      - a call naming no declared tool answers
 *        `{ error: "Function <name> is not found in the toolsDict." }`;
 *      - a tool that throws answers `{ error: "Error in tool '<name>': …" }`,
 *        the text ADK's FunctionTool writes (lib/tools/adkTool.ts);
 *      - with self-correction's tool side on (retries.tool_errors, default
 *        3), those two answer with reflection guidance instead, counted per
 *        tool in call order (lib/runtime/native/selfCorrection.ts);
 *      - a tool that requires approval and has none asks for it, as
 *        FunctionTool's gate does: `{ error: APPROVAL_TEXTS.pending }`,
 *        `skipSummarization`, and the request under the call's id;
 *      - a long-running tool (ask_user) that returns nothing answers
 *        nothing; its actions, when it set any, make an event of their own;
 *      - a result that is not an object is wrapped `{ result }`, an array
 *        `{ results }`, as ADK wraps them.
 *      One call's response is stored as its own event; several are merged
 *      into one, parts in call order and actions merged (ADK's
 *      mergeParallelFunctionResponseEvents). ADK runs the calls one after
 *      another and lets a call read the state an earlier call of the same
 *      step wrote; here each call reads the state as the step left it.
 *   3. An approval request ends the run: the response is NOT stored; in its
 *      place the event ADK stores, a call to `adk_request_confirmation`
 *      (args: the original call and the confirmation; an `adk-` id listed in
 *      longRunningToolIds), carrying the response's actions. The answer
 *      resumes it: before each step, lib/runtime/native/interrupts.ts runs
 *      the pinned call the latest user message approves or refuses, as ADK's
 *      request-confirmation processor does, and its response is stored
 *      before the request is built.
 *   4. The agent's outputKey is written into each final event's stateDelta
 *      before it is stored (ADK's maybeSaveOutputToState, case for case).
 *      The `temp:` keys of every event stored are kept for the rest of the
 *      run, beside the session and never in it, and each later step and
 *      call reads them (lib/runtime/native/tempState.ts).
 *   5. The loop goes on unless the step's last event is final (ADK's
 *      isFinalResponse), the turn stopped the step, or the step stored
 *      nothing. A model call that waits on a person (ask_user) is final: its
 *      model event lists the call in longRunningToolIds, and the run ends
 *      with no response to it, the call pending. The answer resumes it: the
 *      turn runner stores the person's next message as the call's function
 *      response, and the next run's first step reads the call and its answer
 *      from the history (history.ts), as ADK's content processor does. No
 *      request processor acts on it (ADR 0079).
 *
 * DELEGATION: a call to a subagent tool runs the subagent as its own child
 * loop, as ADK's AgentTool runs it (lib/runtime/native/delegate.ts, ADR 0074).
 *
 * SELF-CORRECTION (ADR 0034, ADR 0075) is ADK's reflect-and-retry plugins,
 * ported to lib/runtime/native/selfCorrection.ts: the step declares the
 * reflection tool and passes each response through its model side, and
 * each call's error or answer goes through its tool side. On by default,
 * as runSyndicateTurn installs the plugins by default.
 *
 * COMPACTION (ADR 0033): with the agent's `context:`, each step may first
 * store ADK's compacted event, written by the summary model
 * (lib/runtime/native/compaction.ts). It is yielded like any stored event
 * and is not the run's `lastEvent`.
 *
 * NOT HERE (later tickets): transfer_to_agent (no compiled syndicate sets
 * subAgents), and an auth request a tool raises
 * (no own tool can). The run's spans (agent.invoke, model.call,
 * tool.execute) are lib/runtime/native/telemetry.ts.
 *
 * ADK stays out of this file: an ADK tool an agent still lists during the
 * dual period (a registry FunctionTool, the skills toolset's tools) is run
 * through its runAsync with a context shaped like ADK's, by shape.
 */

import { randomUUID } from 'node:crypto';

import { circuitOpen, recordFailure, recordSuccess } from '../../models/circuitBreaker.ts';
import type { FinalModelResponse, ModelAdapter } from '../../models/contract.ts';
import { providerForModel } from '../../models/providerMap.ts';
import { resolveAdapter } from '../../models/registry.ts';
import { toContractJsonSchema } from '../../models/schemaNormalize.ts';
import { z } from 'zod';
import { APPROVAL_TEXTS, isTool } from '../../tools/tool.ts';
import type { Tool, ToolActions, ToolConfirmation, ToolContext, ToolState } from '../../tools/tool.ts';
import { createEventActions, createTurnEvent, getFunctionCalls, getFunctionResponses, isFinal } from '../events.ts';
import type { TurnContent, TurnEvent, TurnEventActions, TurnFunctionCall, TurnPart } from '../events.ts';
import type { MemoryService } from '../memoryService.ts';
import { currentTurnSignal } from '../turnControl.ts';
import { compactBeforeStep } from './compaction.ts';
import { ADK_CALL_ID_PREFIX } from './history.ts';
import { runSubagent, subagentOf } from './delegate.ts';
import { approvedCalls } from './interrupts.ts';
import type { NativeAgent } from './request.ts';
import { SelfCorrection } from './selfCorrection.ts';
import type { CallCorrection } from './selfCorrection.ts';
import { eitherSignal, runModelStep, stopOf } from './step.ts';
import { createRunTempState, withStateOverlay } from './tempState.ts';
import type { ModelStepOptions, ModelStepResult, StepStop } from './step.ts';
import { traceAgentInvocation, traceModelCall, traceToolCall } from './telemetry.ts';

// ── The loop's surface ───────────────────────────────────────────────────────

/**
 * Where one agent runs: what runModelStep takes besides the agent and its
 * adapter. The session already holds the run's user event; every event the
 * loop stores is appended to it.
 */
export interface AgentLoopContext extends Omit<ModelStepOptions, 'agent' | 'adapter' | 'onPartial' | 'model' | 'beforeAppend' | 'redirect' | 'correction' | 'stateOverlay'> {
  /** The leaf adapter for a model id: the agent's, and its fallback's. Default resolveAdapter (lib/models/registry.ts). */
  adapterFor?: (model: string) => ModelAdapter;
  /** Where the fallback's redirect notice goes. Default console.warn, as compile's. */
  log?: (message: string) => void;
  /**
   * Self-correction (ADR 0034, ADR 0075): the turn's one instance, built from
   * the syndicate's `retries:`. Default: retries at their defaults, as
   * runSyndicateTurn installs ADK's plugins by default.
   */
  selfCorrection?: SelfCorrection;
}

/** How the run ended. */
export type AgentLoopEndReason =
  /** The last event is a final answer (text, a set_model_response answer, a response that skips summarization). */
  | 'final'
  /** A call waits on a person: an ask_user call, or an approval request. `pending` holds the ids. */
  | 'paused'
  /** The last event carries an error (a failed model call), as the ADK path stores it. */
  | 'error'
  /** The turn stopped a step (cancel, deadline, max_steps): no event was stored for it. */
  | 'stopped'
  /** The model answered nothing: no parts, no error, no usage. */
  | 'empty';

export interface AgentLoopEnd {
  reason: AgentLoopEndReason;
  /** Model steps run (a fallback's answer counts with the step it answered). */
  steps: number;
  /** The last event stored. */
  lastEvent?: TurnEvent;
  /** For `paused`: the ids waiting on a person (the ask_user call ids, or the adk_request_confirmation call ids). */
  pending?: string[];
  /** For `stopped`: the turn's code and message. */
  stop?: StepStop;
}

/** ADK's own ceiling on model calls in one run (RunConfig.maxLlmCalls); the turn's max_steps is lower. */
const MAX_LLM_CALLS = 500;

// ── Events as ADK makes them ─────────────────────────────────────────────────

const REQUEST_CONFIRMATION = 'adk_request_confirmation';
const REQUEST_CREDENTIAL = 'adk_request_credential';

const isEmptyRecord = (r: Record<string, unknown> | undefined): boolean => !r || Object.keys(r).length === 0;

/** Sets an own property even for a key such as `__proto__`. */
function setOwn(target: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(target, key, { value, writable: true, enumerable: true, configurable: true });
}

/** ADK's isDefaultEventActions. */
function isDefaultActions(a: TurnEventActions): boolean {
  return (
    isEmptyRecord(a.stateDelta) &&
    isEmptyRecord(a.artifactDelta) &&
    isEmptyRecord(a.requestedAuthConfigs) &&
    isEmptyRecord(a.requestedToolConfirmations) &&
    a.skipSummarization === undefined &&
    a.transferToAgent === undefined &&
    a.escalate === undefined
  );
}

/** ADK's mergeEventActions: dictionaries merged in order, the later flag winning. */
function mergeActions(sources: TurnEventActions[]): TurnEventActions {
  const out = createEventActions();
  for (const s of sources) {
    if (s.stateDelta) for (const [k, v] of Object.entries(s.stateDelta)) setOwn(out.stateDelta as Record<string, unknown>, k, v);
    if (s.artifactDelta) Object.assign(out.artifactDelta as object, s.artifactDelta);
    if (s.requestedAuthConfigs) Object.assign(out.requestedAuthConfigs as object, s.requestedAuthConfigs);
    if (s.requestedToolConfirmations) Object.assign(out.requestedToolConfirmations as object, s.requestedToolConfirmations);
    if (s.skipSummarization !== undefined) out.skipSummarization = s.skipSummarization;
    if (s.transferToAgent !== undefined) out.transferToAgent = s.transferToAgent;
    if (s.escalate !== undefined) out.escalate = s.escalate;
  }
  return out;
}

// ── outputKey (ADK's maybeSaveOutputToState) ─────────────────────────────────

const validators = new WeakMap<object, z.ZodType | null>();

/** The output schema as a validator, as ADK reads it (z.fromJSONSchema); null when it cannot be read. */
function validatorFor(schema: Record<string, unknown>): z.ZodType | null {
  let v = validators.get(schema);
  if (v !== undefined) return v;
  try {
    v = z.fromJSONSchema(toContractJsonSchema(schema) as Parameters<typeof z.fromJSONSchema>[0]);
  } catch {
    v = null;
  }
  validators.set(schema, v);
  return v;
}

/**
 * Writes the agent's final answer into `event`'s stateDelta under its
 * outputKey: the text of its parts; with an output schema, the parsed and
 * validated JSON (the text itself when it does not parse; the parsed value
 * when it does not validate).
 */
export function saveOutput(agent: Pick<NativeAgent, 'name' | 'outputKey' | 'outputSchema'>, event: TurnEvent): void {
  if (event.author !== agent.name || !agent.outputKey || !isFinal(event)) return;
  const parts = event.content?.parts;
  if (!parts?.length) return;
  const text = parts.map((p) => (p.text ? p.text : '')).join('');
  const delta = (event.actions.stateDelta ??= {});
  let result: unknown = text;
  if (agent.outputSchema) {
    if (!text.trim()) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      setOwn(delta, agent.outputKey, text);
      return;
    }
    try {
      const validator = validatorFor(agent.outputSchema);
      result = validator ? validator.parse(parsed) : parsed;
    } catch {
      result = parsed;
    }
  }
  setOwn(delta, agent.outputKey, result);
}

// ── One call's context ───────────────────────────────────────────────────────

/** A ToolContext that is also the shape ADK's tools read from ADK's Context (state, actions, toolConfirmation, invocationContext). */
interface CallContext extends ToolContext {
  readonly actions: ToolActions & TurnEventActions;
  readonly toolConfirmation?: ToolConfirmation;
  readonly abortSignal?: AbortSignal;
  readonly invocationContext: Record<string, unknown>;
}

interface CallScope {
  agent: NativeAgent;
  ctx: AgentLoopContext;
  stateBase: Readonly<Record<string, unknown>>;
  signal?: AbortSignal;
  selfCorrection?: SelfCorrection;
}

function callContext(scope: CallScope, functionCallId: string | undefined, confirmation?: ToolConfirmation): CallContext {
  const { agent, ctx, stateBase } = scope;
  const session = ctx.session;
  const actions = createEventActions() as ToolActions & TurnEventActions;
  const delta = actions.stateDelta as Record<string, unknown>;
  const state: ToolState & { get<T = unknown>(key: string, fallback?: T): T | undefined } = {
    get: <T = unknown>(key: string, fallback?: T) =>
      (Object.hasOwn(delta, key) ? delta[key] : Object.hasOwn(stateBase, key) ? stateBase[key] : fallback) as T | undefined,
    set: (key, value) => setOwn(delta, key, value),
    has: (key) => Object.hasOwn(delta, key) || Object.hasOwn(stateBase, key),
  };
  const memory: Pick<MemoryService, 'search'> | undefined = ctx.memory;
  return {
    invocationId: ctx.invocationId,
    agentName: agent.name,
    functionCallId,
    userId: session.userId,
    appName: session.appName,
    sessionId: session.id,
    state,
    get stateDelta() {
      return delta;
    },
    actions,
    // ADK's Context.requestConfirmation: the request, keyed by the call's id.
    requestConfirmation: ({ hint, payload }: { hint?: string; payload?: unknown } = {}) => {
      if (!functionCallId) throw new Error('functionCallId is not set.');
      (actions.requestedToolConfirmations as Record<string, unknown>)[functionCallId] = { hint: hint ?? '', confirmed: false, payload };
    },
    // The person's answer, when this call is the pinned call an approval resumes (interrupts.ts).
    confirmation,
    toolConfirmation: confirmation,
    signal: scope.signal,
    abortSignal: scope.signal,
    ...(ctx.userContent ? { userContent: ctx.userContent } : {}),
    ...(memory
      ? { searchMemory: (query: string) => memory.search({ appName: session.appName, userId: session.userId, query }) }
      : {}),
    invocationContext: {
      invocationId: ctx.invocationId,
      agent: { name: agent.name },
      branch: ctx.branch,
      session,
      userContent: ctx.userContent,
    },
  };
}

// ── Running the calls (ADK's handleFunctionCallList) ─────────────────────────

/** What one call left: a response part and its actions, its actions alone (a pending long-running call), or nothing. */
type CallOutcome = { part?: TurnPart; actions: TurnEventActions } | undefined;

/** ADK's normalization of a tool's result into a function response. */
function asResponse(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return { result: value };
  if (Array.isArray(value)) return { results: value };
  return value as Record<string, unknown>;
}

/** An ADK tool an agent still lists during the dual period, read by shape. */
interface AdkShapedTool {
  name: string;
  isLongRunning?: boolean;
  runAsync(request: { args: Record<string, unknown>; toolContext: unknown }): Promise<unknown>;
}

function isAdkShaped(tool: unknown): tool is AdkShapedTool {
  return !!tool && typeof tool === 'object' && typeof (tool as { runAsync?: unknown }).runAsync === 'function';
}

/** An own Tool's call, as FunctionTool runs it on the ADK path: its approval gate, then execute, a throw named for the tool. */
async function runOwnTool(tool: Tool, args: Record<string, unknown>, context: CallContext): Promise<unknown> {
  try {
    if (tool.requiresApproval === true) {
      if (!context.confirmation) {
        context.requestConfirmation({ hint: APPROVAL_TEXTS.hint(tool.name) });
        context.actions.skipSummarization = true;
        return { error: APPROVAL_TEXTS.pending };
      }
      if (!context.confirmation.confirmed) return { error: APPROVAL_TEXTS.rejected };
    }
    return await tool.execute(args, context);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Error in tool '${tool.name}': ${message}`);
  }
}

async function runCall(
  scope: CallScope,
  call: TurnFunctionCall,
  tools: Map<string, unknown>,
  correction?: CallCorrection,
  confirmation?: ToolConfirmation,
): Promise<CallOutcome> {
  const context = callContext(scope, call.id || undefined, confirmation);
  const name = call.name ?? '';
  const tool = name && tools.has(name) ? tools.get(name) : undefined;
  const callable = isTool(tool) || isAdkShaped(tool);
  if (!callable) {
    const toolName = name || '<unnamed>';
    const notFound = `Function ${toolName} is not found in the toolsDict.`;
    const guided = await correction?.failed(toolName, call.args ?? {}, new Error(notFound));
    const part: TurnPart = {
      functionResponse: { name: toolName, response: guided ?? { error: notFound }, id: context.functionCallId },
    };
    return { part, actions: context.actions };
  }
  const args = call.args ?? {};
  const toolName = (tool as { name: string }).name;
  const longRunning = isTool(tool) ? tool.longRunning === true : tool.isLongRunning === true;

  // Delegation (WS2-6): a subagent runs as its own child loop, before the generic path (delegate.ts).
  const subagent = subagentOf(tool);

  let response: unknown;
  let failure: unknown;
  try {
    response = subagent
      ? await runSubagent(subagent, args, context, { ctx: scope.ctx, stateBase: scope.stateBase, signal: scope.signal, runLoop: runAgentLoop, queue: scope })
      : isTool(tool) ? await runOwnTool(tool, args, context) : await tool.runAsync({ args, toolContext: context });
  } catch (e) {
    failure = e instanceof Error ? e.message : e;
    // Self-correction answers a thrown Error with reflection guidance in its place.
    const guided = await correction?.failed(toolName, args, e);
    if (guided) [response, failure] = [guided, undefined];
  }
  if (failure === undefined) await correction?.answered(toolName, response);
  // As ADK: a long-running call with no response answers nothing, even when it threw.
  if (longRunning && (response === null || response === undefined)) {
    return isDefaultActions(context.actions) ? undefined : { actions: context.actions };
  }
  const answer = failure ? { error: failure } : response === null || response === undefined ? { result: response } : asResponse(response);
  return { part: { functionResponse: { id: context.functionCallId, name: toolName, response: answer } }, actions: context.actions };
}

/**
 * The calls run, in parallel, as the one response event ADK stores for them
 * (not yet stored); undefined when none answered. `confirmations` holds the
 * person's answer for a pinned call an approval resumes, by call id.
 */
async function runCalls(
  scope: CallScope,
  calls: TurnFunctionCall[],
  tools: Map<string, unknown>,
  confirmations?: ReadonlyMap<string, ToolConfirmation>,
): Promise<TurnEvent | undefined> {
  const order = scope.selfCorrection?.forCalls(scope.ctx.invocationId, calls.length);
  const outcomes = (
    await Promise.all(
      calls.map((call, i) =>
        traceToolCall(call, tools.get(call.name ?? ''), () =>
          runCall(scope, call, tools, order?.call(i), call.id ? confirmations?.get(call.id) : undefined),
        ).finally(() => order?.release(i)),
      ),
    )
  ).filter((o): o is NonNullable<CallOutcome> => !!o);
  if (outcomes.length === 0) return undefined;
  const base = { invocationId: scope.ctx.invocationId, author: scope.agent.name };
  const contentOf = (parts: TurnPart[]): TurnContent => ({ role: 'user', parts });
  if (outcomes.length === 1) {
    const [only] = outcomes as [NonNullable<CallOutcome>];
    return createTurnEvent({
      ...base,
      ...(only.part ? { content: contentOf([only.part]) } : {}),
      actions: only.actions,
      branch: scope.ctx.branch,
    });
  }
  return createTurnEvent({
    ...base,
    branch: scope.ctx.branch,
    content: contentOf(outcomes.flatMap((o) => (o.part ? [o.part] : []))),
    actions: mergeActions(outcomes.map((o) => o.actions)),
  });
}

/** ADK's generateAuthEvent: a credential request per call that asked for one. */
function authEvent(scope: CallScope, response: TurnEvent): TurnEvent | undefined {
  const configs = response.actions.requestedAuthConfigs;
  if (isEmptyRecord(configs)) return undefined;
  const parts: TurnPart[] = Object.entries(configs as Record<string, unknown>).map(([callId, authConfig]) => ({
    functionCall: { name: REQUEST_CREDENTIAL, args: { function_call_id: callId, auth_config: authConfig }, id: `${ADK_CALL_ID_PREFIX}${randomUUID()}` },
  }));
  return createTurnEvent({
    invocationId: scope.ctx.invocationId,
    author: scope.agent.name,
    branch: scope.ctx.branch,
    content: { parts, role: response.content?.role ?? 'user' },
    longRunningToolIds: parts.map((p) => p.functionCall?.id as string),
  });
}

/** ADK's generateRequestConfirmationEvent: an adk_request_confirmation call per gated call, carrying the response's actions. */
function confirmationEvent(scope: CallScope, modelEvent: TurnEvent, response: TurnEvent): TurnEvent | undefined {
  const requested = response.actions.requestedToolConfirmations;
  if (isEmptyRecord(requested)) return undefined;
  const calls = getFunctionCalls(modelEvent);
  const parts: TurnPart[] = [];
  for (const [callId, toolConfirmation] of Object.entries(requested as Record<string, unknown>)) {
    const originalFunctionCall = calls.find((c) => c.id === callId);
    if (!originalFunctionCall) continue;
    parts.push({ functionCall: { name: REQUEST_CONFIRMATION, args: { originalFunctionCall, toolConfirmation }, id: `${ADK_CALL_ID_PREFIX}${randomUUID()}` } });
  }
  return createTurnEvent({
    invocationId: scope.ctx.invocationId,
    author: scope.agent.name,
    branch: scope.ctx.branch,
    content: { parts, role: response.content?.role ?? 'user' },
    actions: response.actions,
    longRunningToolIds: parts.map((p) => p.functionCall?.id as string),
  });
}

/**
 * ADK's request-confirmation processor, before a step: the pinned calls the
 * latest user message approves or refuses run with the answer in their
 * context, and their response is returned to be stored (interrupts.ts). Undefined when
 * there is none; 'stopped' when the turn stopped while they ran (nothing is
 * stored). Throws IntentMismatchError when an answer does not bind.
 */
async function resumeApprovals(
  agent: NativeAgent,
  ctx: AgentLoopContext,
  stateBase: Readonly<Record<string, unknown>>,
  selfCorrection: SelfCorrection,
): Promise<TurnEvent | 'stopped' | undefined> {
  const signal = eitherSignal(ctx.signal, currentTurnSignal());
  const scope: CallScope = { agent, ctx, stateBase, selfCorrection, ...(signal ? { signal } : {}) };
  const approved = await approvedCalls(agent, ctx, (id) => callContext(scope, id));
  if (!approved) return undefined;
  const response = await runCalls(scope, approved.calls, approved.tools, approved.confirmations);
  if (signal?.aborted) return 'stopped';
  return response;
}

// ── The model step, with partials and the fallback ───────────────────────────

/** Runs a step, yielding its partial events as they arrive; returns the step's result. */
async function* withPartials(
  start: (onPartial: (event: TurnEvent) => void) => Promise<ModelStepResult>,
): AsyncGenerator<TurnEvent, ModelStepResult> {
  const queue: TurnEvent[] = [];
  let wake: (() => void) | undefined;
  let done = false;
  const settle = () => {
    done = true;
    wake?.();
  };
  const run = start((event) => {
    queue.push(event);
    wake?.();
  });
  run.then(settle, settle);
  for (;;) {
    while (queue.length > 0) yield queue.shift() as TurnEvent;
    if (done) break;
    await new Promise<void>((resolve) => (wake = resolve));
    wake = undefined;
  }
  return await run;
}

const hasParts = (event: TurnEvent): boolean => (event.content?.parts?.length ?? 0) > 0;

/**
 * One model step for the agent: its own model, and with a fallback_model
 * the fallback by ADK's FallbackLlm's rules (ADR 0044), each a leaf adapter
 * called by its own step (ADR 0053).
 */
async function* modelStep(
  agent: NativeAgent,
  ctx: AgentLoopContext,
  stepOptions: Omit<ModelStepOptions, 'adapter' | 'onPartial'>,
): AsyncGenerator<TurnEvent, ModelStepResult> {
  const adapterFor = ctx.adapterFor ?? resolveAdapter;
  const fallbackId = agent.fallbackModel;
  if (!fallbackId) {
    return yield* withPartials((onPartial) => runModelStep({ ...stepOptions, adapter: adapterFor(agent.model), onPartial }));
  }
  const log = ctx.log ?? ((m: string) => console.warn(m));
  const onFallback = (why: string) => {
    log(`[models] ${why}; answering from ${fallbackId}.`);
    return withPartials((onPartial) => runModelStep({ ...stepOptions, adapter: adapterFor(fallbackId), model: fallbackId, onPartial }));
  };
  const provider = providerForModel(agent.model);
  if (circuitOpen(provider)) return yield* onFallback(`${provider} circuit is open`);

  let answered = false;
  const first = yield* withPartials((onPartial) =>
    runModelStep({
      ...stepOptions,
      adapter: adapterFor(agent.model),
      onPartial: (event) => {
        if (hasParts(event)) answered = true;
        onPartial(event);
      },
      // FallbackLlm: a retryable failure counts against the provider, and redirects when nothing was produced.
      redirect: (final: FinalModelResponse, produced: boolean) => {
        if (!final.error?.retryable) return false;
        recordFailure(provider);
        return !produced && final.parts.length === 0;
      },
    }),
  );
  if (first.redirected) {
    return yield* onFallback(`${agent.model} failed (${first.redirected.code}: ${first.redirected.message.slice(0, 120)})`);
  }
  if (first.event && hasParts(first.event)) answered = true;
  if (answered && !first.error && !first.stopped) recordSuccess(provider);
  return first;
}

// ── The loop ─────────────────────────────────────────────────────────────────

/**
 * Runs `agent` on the session in `ctx` until its answer is final, yielding
 * every event in order: partials as they arrive (never stored), then each
 * event as the store returned it. Returns how the run ended.
 *
 * Never throws for a failed model call or a failing tool: the first is the
 * last event, stored with its error, the second the call's error response.
 * Throws where the ADK runtime throws: a request that cannot be built, an
 * adapter or a store that throws.
 */
export function runAgentLoop(agent: NativeAgent, ctx: AgentLoopContext): AsyncGenerator<TurnEvent, AgentLoopEnd> {
  // Telemetry hook (WS2-11, lib/runtime/native/telemetry.ts): the run is an agent.invoke span.
  return traceAgentInvocation(agent, ctx, () => agentLoop(agent, ctx));
}

async function* agentLoop(agent: NativeAgent, ctx: AgentLoopContext): AsyncGenerator<TurnEvent, AgentLoopEnd> {
  const { session, sessions } = ctx;
  // The run's temp: keys, read from each event before the store drops them (lib/runtime/native/tempState.ts).
  const runTemp = createRunTempState();
  const beforeStore = (event: TurnEvent): void => {
    saveOutput(agent, event);
    runTemp.record(event);
  };
  const store = async (event: TurnEvent): Promise<TurnEvent> => {
    beforeStore(event);
    return sessions.append(session, event);
  };
  let steps = 0;
  let lastEvent: TurnEvent | undefined;
  const selfCorrection = ctx.selfCorrection ?? new SelfCorrection();
  const correction = selfCorrection.forModel(agent.name, ctx.invocationId);

  for (;;) {
    // Interrupts hook (WS2-7a, interrupts.ts): an answered approval runs its pinned call before the step, as ADK's request-confirmation processor does; it runs
    // first, then compaction (ADK inserts its compactor before the contents processor), both before the step budget. ADK's request-input processor sits
    // between them and resumes node-tool calls only, which no native agent lists; an answered ask_user needs none (interrupts.ts, ADR 0079).
    const resumed = await resumeApprovals(agent, ctx, withStateOverlay(session.state, runTemp.values()), selfCorrection);
    if (resumed === 'stopped') return { reason: 'stopped', steps, lastEvent, stop: stopOf() };
    if (resumed) {
      lastEvent = await store(resumed);
      yield lastEvent;
    }
    // Compaction hook (WS2-9, lib/runtime/native/compaction.ts): with `context:`, the summary is stored before the step reads the history,
    // before the step budget, as ADK's request processors run before its call count.
    const compacted = await compactBeforeStep(agent, {
      session,
      adapterFor: ctx.adapterFor ?? resolveAdapter,
      ...(ctx.branch !== undefined ? { branch: ctx.branch } : {}),
      ...(ctx.isolationScope !== undefined ? { isolationScope: ctx.isolationScope } : {}),
      ...(currentTurnSignal() ? { signal: currentTurnSignal() } : {}),
    });
    if (compacted) {
      // As ADK's Runner: a turn that stopped during the summary stores nothing and makes no step.
      if (ctx.signal?.aborted || currentTurnSignal()?.aborted) return { reason: 'stopped', steps, lastEvent, stop: stopOf() };
      yield await sessions.append(session, compacted);
    }
    if (steps >= MAX_LLM_CALLS) {
      return { reason: 'stopped', steps, lastEvent, stop: { code: 'STEP_LIMIT', message: `Max number of llm calls limit of ${MAX_LLM_CALLS} exceeded` } };
    }
    steps += 1;
    // Telemetry hook: each step is a model.call span.
    const step = yield* traceModelCall(agent, ctx, (traced) =>
      modelStep(agent, traced, { ...traced, agent, beforeAppend: beforeStore, stateOverlay: runTemp.values(), ...(correction ? { correction } : {}) }),
    );
    if (step.stopped) return { reason: 'stopped', steps, lastEvent, stop: step.stopped };
    const modelEvent = step.event;
    if (!modelEvent) return { reason: 'empty', steps, lastEvent };
    yield modelEvent;
    lastEvent = modelEvent;

    let stepEnd = modelEvent;
    const hadCalls = getFunctionCalls(modelEvent).length > 0;
    if (hadCalls) {
      const scope: CallScope = { agent, ctx, stateBase: withStateOverlay(session.state, runTemp.values()), selfCorrection, ...(step.request.signal ? { signal: step.request.signal } : {}) };
      const response = await runCalls(scope, getFunctionCalls(modelEvent), step.tools);
      // As ADK: a turn that stopped while the calls ran (a long subagent run, say) stores no response.
      if (scope.signal?.aborted) return { reason: 'stopped', steps, lastEvent, stop: stopOf() };
      if (response) {
        const auth = authEvent(scope, response);
        if (auth) {
          lastEvent = await store(auth);
          yield lastEvent;
        }
        const confirmation = confirmationEvent(scope, modelEvent, response);
        if (confirmation) {
          lastEvent = await store(confirmation);
          yield lastEvent;
          return { reason: 'paused', steps, lastEvent, pending: [...(lastEvent.longRunningToolIds ?? [])] };
        }
        lastEvent = await store(response);
        yield lastEvent;
        stepEnd = lastEvent;
      }
    }

    // ADK's runAsyncImpl: stop on a final event, unless it is an empty metadata event after tool calls.
    const emptyMetadata = stepEnd.author === agent.name && !stepEnd.partial && !hasParts(stepEnd) && isDefaultActions(stepEnd.actions);
    if (isFinal(stepEnd) && !(emptyMetadata && hadCalls)) {
      if (stepEnd.errorCode && stepEnd.errorCode !== 'STOP') return { reason: 'error', steps, lastEvent };
      const answered = new Set(getFunctionResponses(stepEnd).map((r) => r.id));
      const pending = (modelEvent.longRunningToolIds ?? []).filter((id) => !answered.has(id));
      if (pending.length > 0) return { reason: 'paused', steps, lastEvent, pending };
      return { reason: 'final', steps, lastEvent };
    }
  }
}
