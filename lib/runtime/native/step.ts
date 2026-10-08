/**
 * lib/runtime/native/step.ts — one model step of the native loop: build the
 * request, call the adapter under the turn's controls, and record the
 * model's answer as the event ADK would have stored (ADR 0045, ADR 0066).
 *
 * WHY this file exists:
 *   Under ADK one step was LlmAgent.runOneStepAsync: build the request,
 *   call the model, turn each response into an event, and let the Runner
 *   store the ones that are not partial. The native loop does the same, and
 *   a session ADK wrote must be one the loop can continue, so each piece
 *   matches:
 *
 *   - THE CALL'S CONTROLS (ADR 0053). The native loop is the adapter's
 *     caller, so it charges the turn and opens the llm.request span, through
 *     traceLlmGeneration, with the adapter's provider, the agent's model id
 *     and the request. A turn that has stopped (cancel, deadline, the step
 *     limit) gets no call and no event: as ADK did, the step checks the
 *     run's signal before the call and after each response and returns
 *     without an event, and the turn
 *     runner reports the stop from the turn's control.
 *   - THE EVENT. Each response becomes ADK's event for it: created before
 *     the call with the run's id, the agent as author and the branch, and
 *     merged with the response as genaiMapping maps it (modelResponseToLlmResponse),
 *     a fresh id for every response after the first. A Responses adapter's
 *     server-side tool calls ride on the final's customMetadata
 *     (withServerTools), where the ledger counts them. For a Gemini adapter
 *     that stands for ADK's own Gemini (standsForAdkGemini), the event has no
 *     turnComplete, since ADK's Gemini wrote none (ADR 0100). A tool call with no id
 *     gets ADK's `adk-<uuid>`; a call to a long-running tool is listed in
 *     longRunningToolIds; a set_model_response call becomes its arguments as
 *     JSON text, ending the step (skipSummarization). An answer with no
 *     parts, no error and no usage makes no event.
 *   - SELF-CORRECTION (ADR 0075). With the caller's `correction`, the
 *     reflection tool is one of the step's tools, after the agent's, and
 *     each response passes through it first, as ADK's reflect-and-retry
 *     model plugin sees it: a retry may stand in its place, or the step may
 *     end on the plugin's UNKNOWN_ERROR event (lib/runtime/native/
 *     selfCorrection.ts). The request declares the tool only where ADK's
 *     model class would (declaresReflectionTool): never to a Gemini model
 *     ADK's own Gemini would serve, which sends no toolsDict (ADR 0097).
 *     On a Gemini adapter the reflection call stored in a response's place
 *     carries its signature, or Gemini 3's placeholder (reflectionSigning,
 *     ADR 0103), where ADK stored it unsigned.
 *   - A THROWN FAILURE. The contract forbids an adapter to throw, but a
 *     leaf that does is read as ADK read it. With
 *     a `redirect`, a provider-side failure (errorDecision, lib/models/
 *     errorResponse.ts) is handed to it as a retryable failed final, so the
 *     fallback answers when nothing was produced yet (ADR 0044). Any
 *     other thrown Error ends the step on ADK's error event for it
 *     (runAndHandleError): UNKNOWN_ERROR, or the code a JSON error message
 *     names, with the message, key-shaped text scrubbed. A throw that is
 *     not an Error, or one while the turn is stopping, is rethrown.
 *   - STORAGE. A final event is appended through the SessionService, which
 *     applies the store's own rules (trimming, state). A partial event is
 *     handed to the caller for streaming and stored nowhere.
 *
 * WHAT IT RETURNS: the request sent, the stored event, and the answer parsed
 * into text, thinking (from the partials: a final never holds thinking) and
 * tool calls with the ids as stored, and the tools the request declared.
 * Running those calls, and looping, is lib/runtime/native/agentLoop.ts.
 */

import { randomUUID } from 'node:crypto';

import type { LlmResponse } from '../../models/genaiMapping.ts';

import type { FinalModelResponse, ModelAdapter, ModelError, ModelRequest, ModelResponse, ToolCallPart } from '../../models/contract.ts';
import { errorDecision, errorText } from '../../models/errorResponse.ts';
import { contractModelResponse, modelResponseToLlmResponse } from '../../models/genaiMapping.ts';
import { responsesServerTools } from '../../models/gptAdapter.ts';
import { resolveAdapter } from '../../models/registry.ts';
import { traceLlmGeneration } from '../../observability/tracer.ts';
import type { MemoryService } from '../memoryService.ts';
import { createTurnEvent, getFunctionCalls, newEventId } from '../events.ts';
import type { TurnContent, TurnEvent } from '../events.ts';
import type { Session, SessionService } from '../sessions.ts';
import { currentTurnControl, currentTurnSignal, stopCode, stopMessage } from '../turnControl.ts';
import { toolOf } from '../../tools/tool.ts';
import { ADK_CALL_ID_PREFIX } from './history.ts';
import { SET_MODEL_RESPONSE, buildModelRequest } from './request.ts';
import type { NativeAgent, WorkflowInstructionScope } from './request.ts';
import { declaresReflectionTool, reflectionSigning, standsForAdkGemini } from './selfCorrection.ts';
import type { ModelCorrection } from './selfCorrection.ts';

export interface ModelStepOptions {
  agent: NativeAgent;
  /** The session as it stands, the run's user event already appended. Appending updates it. */
  session: Session;
  sessions: SessionService;
  /** The run's id: every event of the run carries it. */
  invocationId: string;
  /** The message that started the run. */
  userContent?: TurnContent;
  branch?: string;
  isolationScope?: string;
  /** The run's root agent, whose globalInstruction applies. Default: the agent. */
  root?: Pick<NativeAgent, 'globalInstruction'>;
  /** The run's memory, already namespaced. */
  memory?: Pick<MemoryService, 'search'>;
  /** The leaf adapter to call. Default: resolveAdapter(agent.model) (lib/models/registry.ts). */
  adapter?: ModelAdapter;
  /** Stream text and thinking deltas as partial events. Default false. */
  stream?: boolean;
  /** The run's signal. Default: the current turn's (lib/runtime/turnControl.ts). */
  signal?: AbortSignal;
  /** Each partial event, as it arrives. Never stored. */
  onPartial?: (event: TurnEvent) => void;
  /**
   * The model id the request is sent under. Default the agent's. A fallback
   * model answers the request built for the agent's own model, under its own
   * id (ADR 0044).
   */
  model?: string;
  /** Called on the final event just before it is stored: the loop saves the agent's outputKey here, as ADK does before its Runner appends. */
  beforeAppend?: (event: TurnEvent) => void;
  /** State laid over the session's when the request is built: the run's `temp:` keys (lib/runtime/native/tempState.ts). */
  stateOverlay?: Readonly<Record<string, unknown>>;
  /**
   * Called on each failed final, with whether the adapter had yielded
   * anything before it. True hands the failure back unstored (`redirected`):
   * a fallback model answers the step instead (ADR 0044, ADR 0053).
   */
  redirect?: (final: FinalModelResponse, produced: boolean) => boolean;
  /**
   * Self-correction's model side (lib/runtime/native/selfCorrection.ts):
   * its reflection tool is declared after the agent's tools, and every
   * response passes through it before it is recorded, as ADK's
   * reflect-and-retry model plugin sees it.
   */
  correction?: ModelCorrection;
  /** A workflow agent node's run: fills the instruction's workflow placeholders (request.ts, WorkflowInstructionScope). */
  workflowScope?: WorkflowInstructionScope;
}

/** Why a step made no call, or stopped answering: the turn's own stop. */
export interface StepStop {
  code: string;
  message: string;
}

export interface ModelStepResult {
  /** The request sent, or that would have been sent when the turn had stopped. */
  request: ModelRequest;
  /** The final event as the store returned it. Absent when the turn stopped or the answer was empty. */
  event?: TurnEvent;
  /** The adapter's final response. */
  response?: FinalModelResponse;
  /** The answer's text, thinking aside. */
  text: string;
  /** The model's reasoning as the partials showed it. Display only. */
  thinking: string;
  /** The calls the model made, with the ids as stored. */
  toolCalls: ToolCallPart[];
  /** The calls among them that wait for a person. */
  longRunningToolIds: string[];
  /** The call failed: the adapter's error. */
  error?: ModelError;
  /** The turn stopped before or during the call: no event was made for it. */
  stopped?: StepStop;
  /** The failure `redirect` took: nothing was stored for it. */
  redirected?: ModelError;
  /** The client-side tools the request declared, and the reflection tool when it was not declared, by name: what runs the answer's calls. */
  tools: Map<string, unknown>;
}

export function eitherSignal(...candidates: Array<AbortSignal | undefined>): AbortSignal | undefined {
  const signals = [...new Set(candidates.filter((s): s is AbortSignal => s !== undefined))];
  return signals.length <= 1 ? signals[0] : AbortSignal.any(signals);
}

/** The turn's stop, as the turn runner reports it; a cancel when the signal aborted outside a turn. */
/** The turn's stop, as a step reports it. */
export function stopOf(): StepStop {
  const reason = currentTurnControl()?.stopReason ?? 'canceled';
  return { code: stopCode(reason), message: stopMessage(reason, currentTurnControl()) };
}

function isLongRunning(tool: unknown): boolean {
  const own = toolOf(tool);
  if (own) return own.longRunning === true;
  return !!tool && typeof tool === 'object' && (tool as { isLongRunning?: unknown }).isLongRunning === true;
}

/**
 * A Responses adapter's server-side tool record (web_search, x_search, ...)
 * on the final's customMetadata, as `responses.server_tool_calls` and
 * `responses.server_tool_usage`: the contract has no field for them, and the
 * root span turns the calls into ToolCall events (lib/observability/
 * tracer.ts, serverToolEvents), so adk_turns.tool_calls counts a searched
 * answer. Read off the object the adapter yielded, which is what the record
 * is keyed by (lib/models/gptAdapter.ts, responsesServerTools).
 */
function withServerTools(mapped: LlmResponse, yielded: ModelResponse): LlmResponse {
  const record = responsesServerTools(yielded);
  if (!record) return mapped;
  const metadata = {
    ...(record.calls.length > 0 ? { 'responses.server_tool_calls': record.calls } : {}),
    ...(Object.keys(record.usage).length > 0 ? { 'responses.server_tool_usage': record.usage } : {}),
  };
  if (Object.keys(metadata).length === 0) return mapped;
  return { ...mapped, customMetadata: { ...mapped.customMetadata, ...metadata } };
}

/** ADK's postprocess: whether a response makes an event at all. */
function makesEvent(response: LlmResponse): boolean {
  const usageOnly = !response.content && !!response.usageMetadata;
  return !((!response.content || response.content.parts?.length === 0) && !response.errorCode && !response.interrupted && !usageOnly);
}

/** What ADK stores for a model call that threw: UNKNOWN_ERROR, or the code and message of a JSON error body. */
function thrownModelError(err: Error): { code: string; message: string } {
  let code = 'UNKNOWN_ERROR';
  let message = err.message;
  try {
    const body = JSON.parse(err.message) as { error?: { code?: unknown; message?: unknown } } | null;
    if (body?.error) {
      code = String(body.error.code || 'UNKNOWN_ERROR');
      if (typeof body.error.message === 'string' && body.error.message) message = body.error.message;
    }
  } catch {
    // Not JSON: the message as it is.
  }
  return { code, message: errorText(message) };
}

/**
 * One model step for `agent`. Never throws for a failed call: the error is
 * on the result and on the stored event, as ADK stored it, also when the
 * adapter throws an Error, which the contract forbids. Throws when the
 * request cannot be built (as ADK did).
 */
export async function runModelStep(options: ModelStepOptions): Promise<ModelStepResult> {
  const { agent, session, sessions } = options;
  const signal = eitherSignal(options.signal, currentTurnSignal());
  const adapter = options.adapter ?? resolveAdapter(agent.model);
  // ADK's plugin puts the reflection tool in the toolsDict alone: declared where the model class reads it, run either way.
  const correctionTools = options.correction?.tools ?? [];
  const declareCorrection = correctionTools.length > 0 && declaresReflectionTool(adapter);
  const { request, tools } = await buildModelRequest(agent, {
    session,
    invocationId: options.invocationId,
    ...(options.userContent ? { userContent: options.userContent } : {}),
    ...(options.branch !== undefined ? { branch: options.branch } : {}),
    ...(options.isolationScope !== undefined ? { isolationScope: options.isolationScope } : {}),
    ...(options.root ? { root: options.root } : {}),
    ...(options.memory ? { memory: options.memory } : {}),
    ...(options.stateOverlay ? { stateOverlay: options.stateOverlay } : {}),
    stream: options.stream ?? false,
    ...(signal ? { signal } : {}),
    ...(declareCorrection ? { extraTools: correctionTools } : {}),
    ...(options.workflowScope ? { workflowScope: options.workflowScope } : {}),
  });
  if (!declareCorrection) for (const tool of correctionTools) tools.set(tool.name, tool);
  if (options.model) request.model = options.model;
  const result: ModelStepResult = { request, text: '', thinking: '', toolCalls: [], longRunningToolIds: [], tools };
  if (signal?.aborted) return { ...result, stopped: stopOf() };

  // The event ADK creates before the call; each response after the first gets a fresh id and time.
  const base = createTurnEvent({ invocationId: options.invocationId, author: agent.name, branch: options.branch });
  let next = { id: base.id, timestamp: base.timestamp };

  // The tracer reads LlmResponses; the contract response each came from rides beside it.
  const sources = new WeakMap<LlmResponse, ModelResponse>();
  // What the adapter itself threw, as opposed to the store or a callback.
  let thrown: { error: unknown } | undefined;
  // ADK's own Gemini wrote no turnComplete, so its stand-in's events carry none (ADR 0100).
  const adkGemini = standsForAdkGemini(adapter);
  // How a reflection call stored in this adapter's place is signed (ADR 0103).
  const signing = reflectionSigning(adapter, request.model);
  async function* inner(): AsyncGenerator<LlmResponse, void> {
    try {
      for await (const unchecked of adapter.generate(request)) {
        // The answer held to the contract (contractModelResponse): the step reads and stores the same parts.
        const response = contractModelResponse(unchecked);
        const mapped = withServerTools(modelResponseToLlmResponse(response), unchecked);
        if (adkGemini) delete mapped.turnComplete;
        sources.set(mapped, response);
        yield mapped;
      }
    } catch (err) {
      thrown = { error: err };
      throw err;
    }
  }

  let produced = false;
  try {
    return await readResponses();
  } catch (err) {
    // An adapter that threw (see the header): the fallback's catch (ADR 0044).
    if (thrown?.error !== err || signal?.aborted) throw err;
    const decision = errorDecision(err);
    if (options.redirect && decision.retryable) {
      const error: ModelError = { code: 'PROVIDER_ERROR', message: errorText(err), retryable: true, ...(decision.status !== undefined ? { status: decision.status } : {}) };
      const failed: FinalModelResponse = { partial: false, parts: [], finishReason: 'error', error };
      if (options.redirect(failed, produced)) return { ...result, response: failed, redirected: error };
    }
    if (!(err instanceof Error)) throw err;
    // ADK's runAndHandleError: the step ends on an error event of its own.
    const { code, message } = thrownModelError(err);
    const event = createTurnEvent({ invocationId: options.invocationId, author: agent.name, errorCode: code, errorMessage: message });
    options.beforeAppend?.(event);
    const stored = await sessions.append(session, event);
    return { ...result, event: stored, error: { code, message, retryable: false } };
  }

  async function readResponses(): Promise<ModelStepResult> {
    for await (const traced of traceLlmGeneration({ provider: adapter.provider, model: request.model, request }, inner())) {
      if (signal?.aborted) return { ...result, stopped: stopOf() };
      const source = sources.get(traced);
      if (!source) {
        // A refusal the tracer made in place of the call: the turn has stopped.
        return { ...result, stopped: { code: String(traced.errorCode), message: String(traced.errorMessage ?? '') } };
      }
      // Leaving the loop closes this call (and its span) before a fallback's opens.
      if (!source.partial && source.error && options.redirect?.(source, produced)) return { ...result, response: source, redirected: source.error };
      produced = true;
      // Self-correction sees the response as ADK's afterModelCallback does: it may stand a retry in its place, or end the step.
      // On Gemini the reflection call it stores is signed, so the next request does not 400 (ADR 0103).
      const corrected = options.correction?.afterModel(traced, signing) ?? { response: traced, replaced: false };
      if ('failed' in corrected) {
        // ADK's runAndHandleError: a callback that threw ends the step on an error event of its own.
        const { code, message } = corrected.failed;
        const event = createTurnEvent({ invocationId: options.invocationId, author: agent.name, errorCode: code, errorMessage: message });
        options.beforeAppend?.(event);
        const stored = await sessions.append(session, event);
        return { ...result, event: stored, ...(source.partial ? {} : { response: source }), error: { code, message, retryable: false } };
      }
      const llmResponse = corrected.response;
      if (!makesEvent(llmResponse)) {
        if (!source.partial) result.response = source;
        continue;
      }
      const event = createTurnEvent({ ...base, ...next, actions: base.actions, ...(llmResponse as Partial<TurnEvent>) });
      next = { id: newEventId(), timestamp: Date.now() };

      if (source.partial) {
        for (const part of source.parts) if (part.type === 'thinking') result.thinking += part.text;
        options.onPartial?.(event);
        continue;
      }

      const calls = getFunctionCalls(event);
      const setModelResponse = calls.find((c) => c.name === SET_MODEL_RESPONSE);
      if (event.content && setModelResponse) {
        event.content.parts = [{ text: JSON.stringify(setModelResponse.args) }];
        event.actions.skipSummarization = true;
      } else if (calls.length > 0) {
        for (const call of calls) if (!call.id) call.id = `${ADK_CALL_ID_PREFIX}${randomUUID()}`;
        event.longRunningToolIds = [
          ...new Set(calls.filter((c) => c.name && c.id && tools.has(c.name) && isLongRunning(tools.get(c.name))).map((c) => c.id as string)),
        ];
      }
      options.beforeAppend?.(event);

      const stored = await sessions.append(session, event);
      result.event = stored;
      result.response = source;
      if (source.error && !corrected.replaced) result.error = source.error;
      result.text = (stored.content?.parts ?? []).filter((p) => !p.thought && typeof p.text === 'string').map((p) => p.text).join('');
      result.toolCalls = getFunctionCalls(stored).map((c) => ({ type: 'toolCall', id: c.id as string, name: c.name ?? '', args: c.args ?? {} }));
      result.longRunningToolIds = [...(stored.longRunningToolIds ?? [])];
    }
    return result;
  }
}
