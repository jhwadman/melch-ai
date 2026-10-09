/**
 * lib/runtime/syndicateTurn.ts — ONE implementation of "run a syndicate for
 * one user message". The A2A server, the terminal REPL, the background
 * worker and the observatory's eval harness all call `runSyndicateTurn`, and
 * so does a package consumer embedding the engine.
 *
 * ── Why this exists ───────────────────────────────────────────────────────
 * The turn semantics that make the framework work — plan-dispatch with
 * deterministic overrides, the classifier's transcript digest, the projected
 * session a dispatch route reads, the DELEGATE relay fallback, post-answer
 * guards — used to live inside the A2A server's executor, welded to the A2A
 * event bus. The eval harness carried a second copy ("reimplemented, same
 * rule"), and the REPL a third compiler that ignored dispatch, nesting and
 * guards altogether. Three copies of one behaviour drift; this file is the
 * one copy. Surfaces differ only in what they do with the result: the server
 * publishes A2A events, the REPL prints, the harness records.
 *
 * It is also the seam that keeps the runtime an implementation detail: a
 * caller hands in YAML config and plain text parts and gets plain data back.
 * The agent loop, the compiled agents and the event shapes stay on this side
 * of the line (ADR 0024).
 *
 * ── Controls ──────────────────────────────────────────────────────────────
 * Every turn runs under a TurnControl (lib/runtime/turnControl.ts): the
 * YAML's `max_steps` caps model calls across the WHOLE turn (orchestrator,
 * subagents, nested syndicates), an optional deadline bounds wall-clock
 * time, and an outer AbortSignal cancels it. All three abort the provider
 * request in flight, not just the loop around it.
 *
 * ── The runtime (ADR 0045, ADR 0073, ADR 0107) ────────────────────────────
 * Every agent of a turn runs on the engine's own agent loop
 * (lib/runtime/native/agentLoop.ts), compiled from its AgentSpec
 * (lib/compile.ts, lib/compileNative.ts); a workflow syndicate walks on the
 * engine's scheduler (lib/workflow/turn.ts). The sessions are the engine's
 * SessionService (lib/runtime/sessions.ts) and long-term memory its
 * MemoryService (lib/runtime/memoryService.ts). The stored events are the
 * JSON ADK wrote, so a conversation stored before 1.0.0 resumes. What the
 * runtime does not run fails before any model call, naming the feature
 * (lib/runtime/nativeTurn.ts). The ADK runtime 1.0.0 removed is refused by
 * name (lib/runtime/runtimeFlag.ts).
 */

import { randomUUID } from 'node:crypto';

import { DEFAULT_MAX_STEPS } from '../config.ts';
import { agentGates, compileEntrySpec, compileSpec, compileWorkflowSpec, workflowAgentSpecs } from '../compile.ts';
import type { AgentSpec, DispatchSpec, WorkflowSpec } from '../compile.ts';
import { compileNative, compileNativeWorkflow, nativeAdapterFor } from '../compileNative.ts';
import type { NativeWorkflow } from '../compileNative.ts';
import type { ModelAdapter } from '../models/contract.ts';
import type { NativeAgent } from './native/request.ts';
import { nativeMemory, refuseOnNative, runNativeAgent } from './nativeTurn.ts';
import { createTurnEvent, getFunctionCalls, getFunctionResponses } from './events.ts';
import type { TurnEvent } from './events.ts';
import { InProcessSessionService, TEMP_STATE_PREFIX } from './sessions.ts';
import type { SessionService } from './sessions.ts';
import type { MemoryService } from './memoryService.ts';
import type { WorkflowGraph } from '../workflow/graph.ts';
import { UnsupportedWorkflowResumeError } from '../workflow/resume.ts';
import { runNativeWorkflow } from '../workflow/turn.ts';
import type { NestedRun } from '../workflow/turn.ts';
import { NODE_RUN_LIMIT, NodeRunLimitError } from '../workflow/scheduler.ts';
import { SelfCorrection } from './native/selfCorrection.ts';
import { chooseRuntime } from './runtimeFlag.ts';
import type { RuntimeName } from './runtimeFlag.ts';
import { pinnedCredentialStore } from '../tools/auth.ts';
import type { ToolCredentials } from '../tools/oauthConsent.ts';
import { credentialResponsePart, describeConsent, pendingConsent } from './credentials.ts';
import type { PendingConsent } from './credentials.ts';
export { CREDENTIAL_REQUEST, credentialResponsePart, describeConsent, pendingConsent } from './credentials.ts';
export type { PendingConsent } from './credentials.ts';
export type { ToolCredentials } from '../tools/oauthConsent.ts';
export { chooseRuntime, describeRuntime, runtimeSetting, DEFAULT_RUNTIME, RUNTIMES, RuntimeRemovedError, UnsupportedOnRuntimeError } from './runtimeFlag.ts';
export type { RuntimeName, RuntimeSource } from './runtimeFlag.ts';
// The session store a turn takes when nothing durable is configured, and the engine's interfaces (ADR 0107).
export { InProcessSessionService } from './sessions.ts';
export type { Session, SessionKey, SessionService } from './sessions.ts';
export type { MemoryEntry, MemoryIngestOptions, MemorySearchRequest, MemorySearchResult, MemoryService } from './memoryService.ts';
export type { TurnEvent } from './events.ts';
import { ROUTE_STEP_SUFFIX, describeInput, inputRequestFrom, isWorkflowSyndicate } from '../workflow.ts';
import type { PendingInput } from '../workflow.ts';
export { describeInput } from '../workflow.ts';
export type { PendingInput } from '../workflow.ts';
import type { CompileOptions } from '../compile.ts';
import { isDispatchSyndicate, matchRouteOverride, resolveRoute } from '../dispatch.ts';
import type { RouteResolution } from '../dispatch.ts';
import { collectGrounding, describeGrounding, newGroundingState, webSourcesLine } from '../grounding.ts';
import { resolveGuards } from '../guards/index.ts';
import { collectGuards, nestedLoader } from '../loadSyndicate.ts';
import type { SubagentYamlConfig, SyndicateYamlConfig } from '../loadSyndicate.ts';
import { context } from '@opentelemetry/api';
import core from '@opentelemetry/core';
const { suppressTracing } = core;
import { traceAgentRun } from '../observability/tracer.ts';
import { ProjectedSessionService, renderTranscriptDigest } from '../session/transcript.ts';
import { approvalDecisionIn, describeApproval, interruptedTurnStart, pendingApproval } from './approvals.ts';
import { pendingQuestion, questionAnswerPart, questionFrom, turnStartOfCall } from './questions.ts';
import { deepestPause, delegatedPauses, nestedWorkflowPause, routePause } from './native/interrupts.ts';
import type { DelegatedPause, NestedWorkflowPause } from './native/interrupts.ts';
import { consentPinnedTo, entrySession } from './native/delegate.ts';
import { workflowPauseEvent } from '../workflow/pause.ts';
import { INPUT_REQUEST } from '../workflowConfig.ts';
export { ASK_USER, pendingQuestion, questionAnswerPart } from './questions.ts';
import type { PendingApproval } from './approvals.ts';
export { approvalResponsePart, describeApproval, pendingApproval } from './approvals.ts';
export type { PendingApproval } from './approvals.ts';
import { RemoteA2AAgent, remoteContextId, remoteToolOutput } from '../a2a/remoteAgent.ts';
import { createTurnControl, runWithTurnControl, stopCode, stopMessage } from './turnControl.ts';
import { DEFAULT_MODEL_ERROR_RETRIES, DEFAULT_TOOL_ERROR_RETRIES } from './native/selfCorrection.ts';
import type { NestedDispatchEnd, NestedDispatchRun, TurnStopReason } from './turnControl.ts';

// ── Public types ─────────────────────────────────────────────────────────────

/** One part of the user's message. Text is the common case; the genai part
 *  shapes (inlineData, fileData) pass through to the model unchanged. */
export type MessagePart = { text: string } | Record<string, unknown>;

/** Callbacks a surface uses to watch a turn. All optional. */
export interface TurnEvents {
  /** Short human-readable progress lines: tool calls, the chosen route, guard
   *  notes, web sources. The A2A server publishes these as `[STATUS]` lines. */
  onProgress?(text: string): void;
  /** Every raw event of the answering agent, in order (the REPL prints them). */
  onEvent?(event: TurnEvent): void;
  /**
   * A chunk of the answering agent's reply as the model writes it. Fires only
   * with `streaming: true`, never for the dispatch classifier, and never for
   * a syndicate with guards (a guard reads the whole answer before anything
   * leaves). Provisional: the result's `text` is what the user receives.
   */
  onTextDelta?(delta: string): void;
  /** The text streamed so far was narration before a tool call: discard it. */
  onTextReset?(): void;
  /** Diagnostic lines (the server prefixes and prints them). */
  log?(message: string): void;
  warn?(message: string): void;
}

export interface TraceOptions {
  /** Root-span name and `syndicate.name`. Default: config.syndicate_name. */
  syndicateName?: string;
  bindings?: Record<string, unknown>;
  taskId?: string;
  /** Resolved-config digest (lib/observability/lineage.ts). */
  configHash?: string;
  /** Extra root-span attributes (surface headers, eval tags). */
  attributes?: Record<string, string | number | boolean>;
  onSpanStart?: (ids: { traceId: string; spanId: string }) => void;
  /** A caller's W3C traceparent: the turn's root span links to it (never joins it). */
  traceparent?: string;
}

export interface SyndicateTurnOptions {
  config: SyndicateYamlConfig;
  /** The user's message. */
  parts: MessagePart[];
  /** Session coordinates. The session is created if it does not exist. */
  appName: string;
  userId: string;
  sessionId: string;
  /** Where the conversation lives: the engine's SessionService (InProcessSessionService, PostgresSessionService, SupabaseSessionService). */
  sessionService: SessionService;
  /** Long-term memory, so `load_memory` / `preload_memory` can recall: the engine's MemoryService. */
  memoryService?: MemoryService;
  /** Model resolution, unknown-tool handling, nested loading. */
  compile?: CompileOptions;
  /**
   * Transformed ADK agents before they ran (eval tool replay). The ADK
   * runtime it served was removed in 1.0.0: any value throws
   * UnsupportedOnRuntimeError before the session is touched.
   */
  transformAgent?: (agent: never) => unknown;
  /**
   * The runtime that runs the turn's agents: `native`, the only one since
   * 1.0.0. Default: MELCHIZEDEK_RUNTIME, else `native`; `adk` throws
   * RuntimeRemovedError. A feature the runtime does not run throws
   * UnsupportedOnRuntimeError before any model call.
   */
  runtime?: RuntimeName;
  /** Plan-dispatch only: skip the classifier and run this route. Overrides
   *  in the YAML still win, as they do in production. */
  forceRoute?: string;
  /** Cancels the turn when aborted. */
  signal?: AbortSignal;
  /** Wall-clock budget for the turn, in ms. Default: none. */
  deadlineMs?: number;
  /** Model-call ceiling for the whole turn. Default: the YAML's `max_steps`, else DEFAULT_MAX_STEPS (50). */
  maxLlmCalls?: number;
  /** Ask adapters for token-by-token partial events (the REPL's live view). */
  streaming?: boolean;
  /**
   * Root-span metadata. `false` disables tracing for the turn: it records no
   * span, so no row reaches the ledger (adk_telemetry, adk_turns,
   * adk_payloads), the console exporter, the in-process listeners or an OTLP
   * endpoint, and the turn does not start the tracer. The step budget and
   * the usage in the result are unaffected. Default: traced.
   */
  trace?: TraceOptions | false;
  events?: TurnEvents;
  /**
   * The turn's tool credentials (ADR 0072) and consent step (ADR 0085), on
   * the native runtime. The store is pinned to `appName`; a tool reads the
   * grant of `userId` only. With `consent`, a call whose provider the user
   * has not granted pauses the turn input-required (`result.consent`), and
   * the next message after the grant resumes it; inside a delegated
   * subagent too, with `consent.path` set (ADR 0118). Omitted: tools have no
   * `accessToken`, as before.
   */
  toolCredentials?: ToolCredentials;
}

/** What one agent's event stream amounted to. */
export interface DrainedRun {
  /** The answer: the LAST event's non-thinking text (partials append). */
  text: string;
  /** Last plain-text tool result — the DELEGATE relay fallback. */
  lastToolResultText: string;
  /** Every plain-text tool result, whole, in order — what guards check. */
  toolResultTexts: string[];
  invokedToolNames: Set<string>;
  toolCalls: Array<{ agent: string; name: string; args: Record<string, unknown> }>;
  toolResponses: number;
  /** Subagents delegated to (AgentTool calls and transfer_to_agent). */
  delegations: string[];
  /** Every event author seen. */
  agents: Set<string>;
  /** First few hundred characters of thinking, for diagnostics. */
  thoughts: string;
  /** Peak prompt tokens, summed completion and thinking tokens. */
  tokens: { input: number; output: number; thinking: number };
  eventCount: number;
  /** Native search grounding (Gemini groundingMetadata). */
  grounding?: { queries: string[]; sources: string[] };
  error?: { code: string; message: string };
  /** Workflow runs: questions `ask_user` nodes raised (`adk_request_input`). */
  inputRequests: PendingInput[];
  /** Workflow runs: errors nodes reported along the way (a retried attempt, a failed node). */
  nodeErrors: Array<{ node: string; code: string; message: string }>;
}

export type TurnStage = 'classify' | 'dispatch' | 'delegate' | 'workflow';

export interface RouteDecision extends RouteResolution {
  /** `approval`: the turn resumed the route that asked for an approval (ADR 0028).
   *  `answer`: the message answered the route's open `ask_user` question.
   *  `consent`: the turn resumed the route whose call waited for an OAuth grant (ADR 0085). */
  decidedBy: 'override' | 'forced' | 'classifier' | 'approval' | 'answer' | 'consent';
}

export interface SyndicateTurnResult {
  /** completed: an answer was produced. failed: an error, a deadline or the
   *  step limit stopped it. canceled: the caller canceled it. input-required:
   *  a gated tool call waits for a person's approval (`approval`, ADR 0028). */
  status: 'completed' | 'failed' | 'canceled' | 'input-required';
  /** The call waiting for approval, when status is input-required. Answer it
   *  with `approvalResponsePart(approval.id, approved)` as the next turn's part. */
  approval?: PendingApproval;
  /** The question a workflow's `ask_user` node asked, when status is
   *  input-required. The next message on the conversation is the answer. */
  input?: PendingInput;
  /** The OAuth grant a paused call waits for, when status is input-required
   *  (ADR 0085): the person opens `consent.authUri`; their next message after
   *  the grant is stored resumes the call. `consent.path` is set for a call
   *  inside a delegated subagent (ADR 0118). */
  consent?: PendingConsent;
  /** The text the user receives (relay fallback and guards applied). */
  text: string;
  error?: { code: string; message: string };
  /** Which stage failed, when status is failed. */
  failedStage?: TurnStage;
  /** Plan-dispatch only. */
  route?: RouteDecision;
  /** DELEGATE only: the orchestrator's relay failed and the last tool result shipped. */
  relayFallback: boolean;
  /** `<guard>: <note>` lines from post-answer guards. */
  guardNotes: string[];
  /** The answering agent's full run. Absent if it never started. */
  answer?: DrainedRun;
  /** The classifier's run (plan-dispatch, when it ran). */
  classifier?: DrainedRun;
  /** True when the session already existed before this turn. */
  resumedSession: boolean;
  /** Model calls the turn made, across every agent. */
  llmCalls: number;
  /** What the turn spent, across every agent: what budgets and metrics count. */
  usage: TurnUsage;
  /** Set when a control (cancel, deadline, step limit) stopped the turn. */
  stopReason?: TurnStopReason;
}

/** A turn's spend: model calls and the tokens the providers reported. */
export interface TurnUsage {
  llmCalls: number;
  inputTokens: number;
  outputTokens: number;
  thinkingTokens: number;
}

const THOUGHTS_PREVIEW_CHARS = 600;
const CLASSIFIER_PREAMBLE =
  `RECENT CONVERSATION, oldest first — context for your classification only. `
  + `Never answer it, and never route on it alone; it is here so you can tell a `
  + `follow-up, a redo request, or a challenge to a previous answer apart from small talk.\n`;

// ── Self-correction (ADR 0034) ───────────────────────────────────────────────

// The defaults live with the loop's self-correction (lib/runtime/native/selfCorrection.ts).
export { DEFAULT_MODEL_ERROR_RETRIES, DEFAULT_TOOL_ERROR_RETRIES } from './native/selfCorrection.ts';

// ── Draining one agent's stream ──────────────────────────────────────────────

/**
 * The shape of a tool call's arguments for a log line: the key names and the
 * size, never a value. Arguments are model-chosen and routinely carry the
 * person's words, and a server log is not where those belong (the ledger is
 * the deliberate record, with its own retention).
 */
function describeToolArgs(args: Record<string, unknown> | undefined): string {
  const keys = args ? Object.keys(args) : [];
  if (!keys.length) return 'no args';
  let bytes: number;
  try {
    bytes = Buffer.byteLength(JSON.stringify(args), 'utf8');
  } catch {
    return `args: ${keys.join(', ')}`;
  }
  return `args: ${keys.join(', ')} (${bytes.toLocaleString()} bytes)`;
}

/** A pending question for a log line: who asks, never what. */
function describeInputForLog(input: { node: string; path?: string[] }): string {
  return `${input.node} asks a question${input.path?.length ? ` (${input.path.join(' → ')})` : ''}`;
}

/**
 * Drains one agent's event stream into a DrainedRun. The answer is the LAST
 * event's text, not every event's: a tool-using agent narrates between
 * calls, and accumulating glued that narration to the front of its report.
 * Within one event parts are joined, and `partial` events (streaming chunks)
 * append. Thinking never counts as answer text.
 */
export async function drainAgentStream(
  stream: AsyncIterable<TurnEvent>,
  opts: {
    events?: TurnEvents;
    /** Publish per-tool progress lines. */
    publishToolStatus?: boolean;
    /** Names that count as delegations when called as tools (AgentTools). */
    subagentNames?: Set<string>;
    /** Forward partial reply text to events.onTextDelta (answering stages only). */
    streamText?: boolean;
    /**
     * What an event carrying an error means. `fail` (default): the run is
     * over, the error is the result. `collect`: note it and read on — a
     * workflow node that will retry emits its failed attempt, and a node
     * that gives up ends the stream itself.
     */
    errorPolicy?: 'fail' | 'collect';
  } = {},
): Promise<DrainedRun> {
  const ev = opts.events ?? {};
  const d: DrainedRun = {
    text: '',
    lastToolResultText: '',
    toolResultTexts: [],
    invokedToolNames: new Set(),
    toolCalls: [],
    toolResponses: 0,
    delegations: [],
    agents: new Set(),
    thoughts: '',
    tokens: { input: 0, output: 0, thinking: 0 },
    eventCount: 0,
    inputRequests: [],
    nodeErrors: [],
  };
  const grounding = newGroundingState();
  let groundingAnnounced = false;
  let streamed = false;
  let lastNode = '';

  for await (const event of stream) {
    const e = event as any;
    d.eventCount++;
    ev.onEvent?.(event);
    if (e.author) d.agents.add(e.author);

    // Native search grounding rides on the model event, not on a tool call.
    if (collectGrounding(e, grounding)) {
      const firstSight = grounding.queries.size + grounding.sources.size > 0 && !groundingAnnounced;
      ev.log?.(`⌕ Grounding: ${describeGrounding(grounding)}`);
      // Same shape as a function-tool line so consumers that parse
      // "Invoking tool:" status lines list it too.
      if (opts.publishToolStatus && firstSight) ev.onProgress?.('Invoking tool: web_search');
      groundingAnnounced = true;
    }

    // A workflow event names its node; say when the graph moves on. The
    // root (a path with no dot) and the hidden route steps are not nodes a
    // person declared, so they stay out of the progress.
    const nodePath: string | undefined = e.nodeInfo?.path;
    if (nodePath && nodePath.includes('.') && e.author && !String(e.author).endsWith(ROUTE_STEP_SUFFIX) && e.author !== lastNode && e.partial !== true) {
      lastNode = e.author;
      ev.log?.(`⇢ Node: ${e.author}`);
      if (opts.publishToolStatus) ev.onProgress?.(`Running node: ${e.author}`);
    }

    if ((e.errorCode || e.errorMessage) && e.errorCode !== 'STOP') {
      const error = { code: String(e.errorCode ?? 'ERROR'), message: String(e.errorMessage ?? '') };
      if (opts.errorPolicy === 'collect') {
        d.nodeErrors.push({ node: String(e.author ?? ''), ...error });
        ev.warn?.(`Node ${e.author ?? '?'} reported [${error.code}]: ${error.message}`);
        continue;
      }
      d.error = error;
      ev.warn?.(`Error [${d.error.code}]: ${d.error.message}`);
      break;
    }

    if (e.usageMetadata) {
      // Same aggregation as traceAgentRun: peak prompt, summed completions.
      d.tokens.input = Math.max(d.tokens.input, e.usageMetadata.promptTokenCount ?? 0);
      d.tokens.output += e.usageMetadata.candidatesTokenCount ?? 0;
      d.tokens.thinking += e.usageMetadata.thoughtsTokenCount ?? 0;
    }

    const calls = getFunctionCalls(event);
    // Text streamed before a tool call was narration, not the answer.
    if (streamed && calls.length) {
      ev.onTextReset?.();
      streamed = false;
    }
    for (const call of calls) {
      const name = call.name ?? '';
      const args = (call.args ?? {}) as Record<string, unknown>;
      if (name === 'transfer_to_agent') {
        const target = String((args as any).agentName ?? 'unknown');
        d.delegations.push(target);
        ev.log?.(`→ Delegating to: ${target}`);
        if (opts.publishToolStatus) ev.onProgress?.(`Delegating to subagent: ${target}`);
        continue;
      }
      const inputRequest = inputRequestFrom(e.author, call) ?? questionFrom(e.author, call);
      if (inputRequest) {
        // An ask_user node: the workflow waits for the person (lib/workflow.ts).
        d.inputRequests.push(inputRequest);
        ev.log?.(`⏸ ${describeInputForLog(inputRequest)}`);
        continue;
      }
      if (!name) continue;
      d.invokedToolNames.add(name);
      if (opts.subagentNames?.has(name)) d.delegations.push(name);
      d.toolCalls.push({ agent: e.author ?? 'unknown', name, args });
      ev.log?.(`→ Tool: ${name} by ${e.author ?? 'unknown'} — ${describeToolArgs(args)}`);
      if (opts.publishToolStatus) ev.onProgress?.(`Invoking tool: ${name}`);
    }

    for (const resp of getFunctionResponses(event)) {
      const r = resp as any;
      const name: string = r.name ?? r.functionResponse?.name ?? '';
      const content = r.response ?? r.functionResponse?.response ?? {};
      d.toolResponses++;
      if (name) d.invokedToolNames.add(name);
      const asString = typeof content === 'string' ? content : JSON.stringify(content);
      ev.log?.(`← Result: ${name || 'unknown'} — ${asString.length.toLocaleString()} chars`);
      // Only plain text results are relayable answers — a structured or
      // base64 payload (image tools) is not.
      const resultText =
        typeof content === 'string'
          ? content
          : typeof content?.result === 'string'
            ? content.result
            : '';
      if (resultText.trim()) {
        d.lastToolResultText = resultText.trim();
        d.toolResultTexts.push(resultText.trim());
      }
    }

    let eventText = '';
    for (const part of event.content?.parts ?? []) {
      const p = part as any;
      if (!p.text) continue;
      if (p.thought === true) {
        if (d.thoughts.length < THOUGHTS_PREVIEW_CHARS) d.thoughts += p.text;
      } else {
        eventText += p.text;
      }
    }
    if (eventText) d.text = e.partial === true ? d.text + eventText : eventText;
    if (opts.streamText && e.partial === true && eventText) {
      ev.onTextDelta?.(eventText);
      streamed = true;
    }
  }

  const sourcesLine = webSourcesLine(grounding);
  // A consumer contract clients parse: "Web sources: a, b",
  // published once, after the stream, with the full set.
  if (opts.publishToolStatus && sourcesLine) ev.onProgress?.(sourcesLine);
  if (grounding.queries.size || grounding.sources.size) {
    d.grounding = { queries: [...grounding.queries], sources: [...grounding.sources] };
  }
  d.text = d.text.trim();
  return d;
}

/** True when an orchestrator's text is just the name of a tool it called —
 *  the degenerate relay ("FinancialAnalyst", 3 tokens). Deliberately narrow:
 *  short real answers are legitimate, so no length heuristic. */
export function echoesToolName(text: string, toolNames: Iterable<string>): boolean {
  const normalize = (s: string) => s.replace(/[^a-z0-9]/gi, '').toLowerCase();
  if (!text) return false;
  for (const name of toolNames) if (normalize(name) === normalize(text)) return true;
  return false;
}

// ── The turn ─────────────────────────────────────────────────────────────────

/**
 * Runs one user message through a syndicate and returns what the user
 * receives. Never throws for model or tool failures — those come back as
 * `status: 'failed'` with an error. It throws only for programming errors
 * (a session service that rejects, a config naming a route it does not
 * declare), which a surface should treat as an internal error.
 */
export async function runSyndicateTurn(opts: SyndicateTurnOptions): Promise<SyndicateTurnResult> {
  const { config } = opts;
  // `native` is the only runtime; `adk` (removed in 1.0.0) throws RuntimeRemovedError here, before the session is touched.
  const runtime = chooseRuntime(opts.runtime);
  const control = createTurnControl({
    maxLlmCalls: opts.maxLlmCalls ?? config.max_steps ?? DEFAULT_MAX_STEPS,
    deadlineMs: opts.deadlineMs,
    signal: opts.signal,
    // `trace: false`: no span from anything the turn runs, to any sink.
    untraced: opts.trace === false,
  });
  // A nested dispatch syndicate, wherever the turn reaches one, runs as a turn of its own under these controls (ADR 0120).
  control.nestedDispatch = (run) => runNestedDispatch(opts, control, runtime, run);
  try {
    const run = () => runWithTurnControl(control, () => runTurnInner(opts, control, runtime));
    // A span a library opens through OpenTelemetry's own API (not the
    // engine's, which read control.untraced) is suppressed too, while a
    // registered tracer is there to read the suppression.
    return await (control.untraced ? context.with(suppressTracing(context.active()), run) : run());
  } finally {
    control.dispose();
  }
}

/** A compiled agent, for the runtime that runs it. */
type TurnAgent =
  | { runtime: 'native'; agent: NativeAgent; adapterFor: (model: string) => ModelAdapter }
  | NativeWorkflowAgent;

/** A workflow syndicate compiled for the native walk (lib/workflow/turn.ts). */
interface NativeWorkflowAgent {
  runtime: 'native-workflow';
  graph: WorkflowGraph;
  agents: Map<string, NativeAgent>;
  adapterFor: (model: string) => ModelAdapter;
  resolveTool: (name: string) => unknown;
  /** The nodes that are a nested workflow syndicate (ADR 0106), or a nested dispatch syndicate (ADR 0120). */
  workflows: Map<string, NativeWorkflow | NestedRun>;
}

/**
 * A workflow syndicate for the native runtime: its graph, every agent
 * compiled from its specs (compileWorkflowSpec, then compileNativeWorkflow),
 * one adapter lookup that knows every agent's models, and the registry's
 * lookup for tool nodes. An unregistered or long-running tool node is
 * refused here, before any model call.
 */
async function compileNativeWorkflowAgent(config: SyndicateYamlConfig, opts: CompileOptions): Promise<NativeWorkflowAgent> {
  return nativeWorkflowAgent(await compileWorkflowSpec(config, opts), opts);
}

/** A compiled workflow spec for the native walk: the root's, or a dispatch route's nested graph (ADR 0106). */
function nativeWorkflowAgent(spec: WorkflowSpec, opts: CompileOptions): NativeWorkflowAgent {
  const { graph, agents, resolveTool, workflows } = compileNativeWorkflow(spec);
  return { runtime: 'native-workflow', graph, agents, adapterFor: nativeAdapterFor(opts, workflowAgentSpecs(spec)), resolveTool, workflows };
}

/** How a nested dispatch syndicate's turn differs from a turn at the top (ADR 0120). */
interface NestedTurn {
  /** The app its grants are read and stored under: the root's, as a delegated subagent's are (ADR 0118). */
  credentialApp: string;
}

/**
 * A nested dispatch syndicate's own turn (ADR 0120): runTurnInner on its
 * conversation (`run`, opened by the caller), under the turn's controls,
 * with the turn's store, memory, credentials and log, never streamed, its
 * guards left to the turn at the top (collectGuards already lists them
 * there). Its result is read as a walk's end: the route's final text, the
 * conversation's state writes, and what it waits on, by id.
 */
async function runNestedDispatch(
  opts: SyndicateTurnOptions,
  control: ReturnType<typeof createTurnControl>,
  runtime: RuntimeName,
  run: NestedDispatchRun,
): Promise<NestedDispatchEnd> {
  const sessions = run.sessions as SessionService;
  const key = { appName: run.appName, userId: run.userId, sessionId: run.sessionId };
  const kept = (state: Record<string, unknown> | undefined): Record<string, unknown> =>
    Object.fromEntries(Object.entries(state ?? {}).filter(([k]) => !k.startsWith(TEMP_STATE_PREFIX)));
  const before = new Map(Object.entries(kept((await sessions.get(key))?.state)).map(([k, v]) => [k, JSON.stringify(v)]));
  const config = run.config as SyndicateYamlConfig;
  const trace = opts.trace === false ? false : { ...(opts.trace ?? {}), syndicateName: config.syndicate_name ?? run.name };
  const nested = await runTurnInner(
    {
      config,
      parts: run.parts as MessagePart[],
      appName: run.appName,
      userId: run.userId,
      sessionId: run.sessionId,
      sessionService: sessions,
      ...(opts.memoryService ? { memoryService: opts.memoryService } : {}),
      compile: run.compile as CompileOptions,
      ...(opts.toolCredentials ? { toolCredentials: opts.toolCredentials } : {}),
      streaming: false,
      trace,
      events: { ...(opts.events?.log ? { log: opts.events.log } : {}), ...(opts.events?.warn ? { warn: opts.events.warn } : {}) },
    },
    control,
    runtime,
    { credentialApp: opts.appName },
  );
  const after = kept((await sessions.get(key))?.state);
  const stateDelta = Object.fromEntries(Object.entries(after).filter(([k, v]) => before.get(k) !== JSON.stringify(v)));
  const interruptId = nested.approval?.id ?? nested.input?.id ?? nested.consent?.id;
  return {
    status: nested.status,
    text: nested.text,
    stateDelta,
    ...(interruptId ? { interruptId } : {}),
    ...(nested.approval ? { approval: nested.approval } : {}),
    ...(nested.input ? { input: nested.input } : {}),
    ...(nested.consent ? { consent: nested.consent } : {}),
    ...(nested.error ? { error: nested.error } : {}),
  };
}

async function runTurnInner(
  opts: SyndicateTurnOptions,
  control: ReturnType<typeof createTurnControl>,
  _runtime: RuntimeName,
  nestedTurn?: NestedTurn,
): Promise<SyndicateTurnResult> {
  const { config, appName, userId, sessionId, sessionService } = opts;
  const ev = opts.events ?? {};
  // Nested references load from the definition's bundle when it has one
  // (a registry version, ADR 0018 item 6), else from files.
  const compileOpts: CompileOptions = { ...opts.compile, loadNested: opts.compile?.loadNested ?? nestedLoader(config) };
  const subagentNames = new Set((config.subagents ?? []).map((s) => s.name));
  const trace = opts.trace === false ? undefined : opts.trace ?? {};
  let parts = opts.parts.map((p) => (typeof p === 'string' ? { text: p } : p));
  const messageText = parts.map((p: any) => (typeof p.text === 'string' ? p.text : '')).join('\n');
  // What the runtime does not run fails here, before the session is touched.
  refuseOnNative(config, { isWorkflow: isWorkflowSyndicate(config), transformAgent: opts.transformAgent });
  const nativeOf = (spec: AgentSpec): TurnAgent => ({ runtime: 'native', agent: compileNative(spec), adapterFor: nativeAdapterFor(compileOpts, spec) });
  /** The orchestrator (a DELEGATE root, or a dispatch classifier). */
  const compileRoot = async (): Promise<TurnAgent> => nativeOf(await compileSpec(config, compileOpts));
  /** A dispatch route: one agent, a nested workflow's whole graph (ADR 0106), or a nested dispatch syndicate's own turn (ADR 0120). */
  const compileRoute = async (routeCfg: SubagentYamlConfig): Promise<(TurnAgent & { workflow?: WorkflowSpec }) | { dispatch: DispatchSpec }> => {
    const entry = await compileEntrySpec(routeCfg, compileOpts);
    if (entry.kind === 'workflow') return { ...nativeWorkflowAgent(entry.workflow, compileOpts), workflow: entry.workflow };
    if (entry.kind === 'dispatch') return { dispatch: entry.dispatch };
    return nativeOf(entry.spec);
  };
  // Self-correction (ADR 0075): one per turn, from the YAML's retries:.
  const selfCorrection = new SelfCorrection(config.retries);

  const result: SyndicateTurnResult = {
    status: 'completed',
    text: '',
    relayFallback: false,
    guardNotes: [],
    resumedSession: false,
    llmCalls: 0,
    usage: { llmCalls: 0, inputTokens: 0, outputTokens: 0, thinkingTokens: 0 },
  };
  const finish = (): SyndicateTurnResult => {
    result.llmCalls = control.llmCalls;
    result.usage = {
      llmCalls: control.llmCalls,
      inputTokens: control.inputTokens,
      outputTokens: control.outputTokens,
      thinkingTokens: control.thinkingTokens,
    };
    if (control.stopReason) {
      result.stopReason = control.stopReason;
      result.status = control.stopReason === 'canceled' ? 'canceled' : 'failed';
      result.error = { code: stopCode(control.stopReason), message: stopMessage(control.stopReason, control) };
    }
    return result;
  };

  // ── Session ────────────────────────────────────────────────────────────────
  const existing = await sessionService.get({ appName, userId, sessionId });
  if (existing) {
    result.resumedSession = true;
  } else {
    await sessionService.create({ appName, userId, sessionId });
  }

  // A guard rewrites the answer after it is complete, so a guarded
  // syndicate never streams: nothing may leave before the guard has read it.
  const guarded = collectGuards(config, compileOpts.loadNested).length > 0;

  // ── Approvals (ADR 0028) ───────────────────────────────────────────────────
  // A message answering an approval resumes the agent that asked; the answer
  // must name the request still open in this conversation.
  const decision = approvalDecisionIn(parts);
  // Pauses inside delegated subagents (ADR 0110): what waits below a call an agent of this conversation left open.
  const delegationKey = { sessions: sessionService, userId, sessionId, appName };
  /** The first pause waiting below an open delegated call in this conversation, `author`'s calls only when given. */
  const pauseBelow = async (events: readonly TurnEvent[], author?: string): Promise<DelegatedPause | undefined> =>
    isWorkflowSyndicate(config) ? undefined : (await delegatedPauses(delegationKey, events, author))[0];
  // Pauses inside nested workflows run as a dispatch route or a workflow node (ADR 0119).
  const pauseKey = { ...delegationKey, appName };
  /** A request a workflow's own session holds, raised by a node that is a nested workflow: the one its walk waits on, with the path. */
  const deepen = <T extends PendingApproval | PendingInput>(pending: T): Promise<T> => deepestPause(pauseKey, pending);
  /** A dispatch route that is a nested workflow, its walk paused: the conversation's last event is its pause record. */
  const routePaused = isDispatchSyndicate(config) ? await routePause(pauseKey, existing?.events ?? [], subagentNames) : undefined;
  let resumingBelow: DelegatedPause | undefined;
  let resumingRoute: (NestedWorkflowPause & { route: string }) | undefined;
  let resuming: PendingApproval | undefined;
  if (decision) {
    resuming = pendingApproval(existing?.events ?? []);
    if (resuming && isWorkflowSyndicate(config)) resuming = await deepen(resuming);
    if (!resuming) {
      resumingBelow = await pauseBelow(existing?.events ?? []);
      resuming = resumingBelow?.approval;
    }
    if (!resuming && routePaused?.approval) {
      resumingRoute = routePaused;
      resuming = routePaused.approval;
    }
    if (!resuming || resuming.id !== decision.id) {
      result.status = 'failed';
      result.error = { code: 'NO_PENDING_APPROVAL', message: `No approval ${decision.id} is waiting in this conversation.` };
      return finish();
    }
    // The log names the call, not its arguments: they are user content.
    ev.log?.(`✓ Approval ${decision.approved ? 'granted' : 'refused'}: ${(resuming.path ?? [resuming.agent]).join(' → ')} → ${resuming.tool}`);
  }

  // ── Consent (lib/runtime/credentials.ts, ADR 0085) ────────────────────────
  // While a call waits for an OAuth grant, the next message resumes it once
  // the callback has stored the grant; until then it repeats the request and
  // runs nothing.
  // A nested dispatch syndicate's turn reads and stores grants under the root's app, as a delegated subagent does (ADR 0118, ADR 0120).
  const credentialApp = nestedTurn?.credentialApp ?? appName;
  const credentialStore = opts.toolCredentials ? pinnedCredentialStore(opts.toolCredentials.store, credentialApp) : undefined;
  const consentStep = opts.toolCredentials?.consent
    ? nestedTurn
      ? consentPinnedTo(opts.toolCredentials.consent, credentialApp)
      : opts.toolCredentials.consent
    : undefined;
  const consentPause = (pending: PendingConsent): SyndicateTurnResult => {
    result.status = 'input-required';
    result.consent = pending;
    result.text = `Authorization needed: ${describeConsent(pending)}. Open the authorization link, then send any message to continue.`;
    ev.log?.(`⏸ Authorization needed: ${(pending.path ?? [pending.agent]).join(' → ')} → ${pending.provider}`);
    return finish();
  };
  let granting: PendingConsent | undefined;
  // A call waiting for a grant inside a delegated subagent (ADR 0118): the grant's answer is stored here, and the open call carries it down.
  let grantingBelow: DelegatedPause | undefined;
  // A dispatch route that is a nested dispatch syndicate, waiting for a grant (ADR 0120): its own turn checks the grant, then resumes or asks again.
  let consentRoute: (NestedWorkflowPause & { route: string }) | undefined;
  if (!decision && !isWorkflowSyndicate(config)) {
    let open = pendingConsent(existing?.events ?? []);
    if (!open && config.subagents?.length) {
      const below = await pauseBelow(existing?.events ?? []);
      if (below?.consent) {
        grantingBelow = below;
        open = below.consent;
      }
    }
    const routeWaits = !open && !!routePaused?.consent;
    if (routeWaits) open = routePaused!.consent;
    if (open) {
      if (!credentialStore) {
        result.status = 'failed';
        result.error = { code: 'CONSENT_UNAVAILABLE', message: `A call waits for a ${open.provider} authorization, but this turn has no credential store.` };
        return finish();
      }
      let granted = false;
      try {
        granted = !!open.provider && !!(await credentialStore.get({ appName: credentialApp, userId, provider: open.provider }));
      } catch {
        // Expired or unreadable: not granted. The request stands.
      }
      if (!granted) return consentPause(open);
      // The route's own turn carries the grant's answer down to its call; the message goes to it as it came.
      if (routeWaits) consentRoute = routePaused;
      else {
        granting = open;
        parts = [credentialResponsePart(open.id, open.provider)];
      }
      ev.log?.(`✓ Authorization granted: ${(open.path ?? [open.agent]).join(' → ')} → ${open.provider}`);
    }
  }

  // ── Questions (lib/runtime/questions.ts) ───────────────────────────────────
  // While an agent's `ask_user` call is open, a plain-text message is its
  // answer: it becomes that call's response, and the agent that asked
  // resumes its own tool loop (the loop reads the response from its history;
  // ADR 0079). A workflow's pauses are its walk's own business.
  // A question asked inside a delegated subagent (ADR 0110) is answered the same way: the answer is stored here, and the
  // open call that leads to the asker carries it down; `answering` names that call and the agent that made it.
  let answering: { agent: string; id: string } | undefined;
  /** The parts a paused workflow route's walk resumes on, when the message answers its question: the answer as the explicit reply to its `adk_request_input` call (ADR 0119). */
  let routeAnswer: unknown[] | undefined;
  if (!decision && !granting && !consentRoute && !isWorkflowSyndicate(config)) {
    const plainText = parts.length > 0 && parts.every((p: any) => typeof p.text === 'string');
    const own = plainText ? pendingQuestion(existing?.events ?? []) : undefined;
    const below = plainText && !own ? await pauseBelow(existing?.events ?? []) : undefined;
    const question = own ?? below?.question;
    if (!question && plainText && routePaused?.question) {
      // The conversation stores the person's words; the route's walk reads them as the reply to the node that asked.
      const waiting = routePaused.question;
      answering = { agent: routePaused.route, id: waiting.id };
      routeAnswer = [{ functionResponse: { id: waiting.id, name: INPUT_REQUEST, response: { result: messageText } } }];
      ev.log?.(`✓ Answer to ${(waiting.path ?? [waiting.node]).join(' → ')}'s question`);
    } else if (question) {
      answering = below ? { agent: below.path[0] as string, id: below.callIds[0] as string } : { agent: question.node, id: question.id };
      parts = [questionAnswerPart(question.id, messageText)];
      ev.log?.(`✓ Answer to ${(question.path ?? [question.node]).join(' → ')}'s question`);
    }
  }
  /** The agent a dispatch turn must resume, and the call its interrupted turn holds. */
  const resumeTarget = resumingBelow
    ? { agent: resumingBelow.path[0] as string, id: resumingBelow.callIds[0] as string, why: 'resuming an approval' }
    : resumingRoute
    ? { agent: resumingRoute.route, id: resuming!.id, why: 'resuming an approval' }
    : consentRoute
    ? { agent: consentRoute.route, id: consentRoute.consent!.id, why: 'resuming after an authorization' }
    : grantingBelow
    ? { agent: grantingBelow.path[0] as string, id: grantingBelow.callIds[0] as string, why: 'resuming after an authorization' }
    : resuming
    ? { agent: resuming.agent, id: resuming.id, why: 'resuming an approval' }
    : granting
      ? { agent: granting.agent, id: granting.id, why: 'resuming after an authorization' }
      : answering
        ? { ...answering, why: 'answering its question' }
        : undefined;
  /** After the answering run: is a call now waiting for a grant? */
  const awaitingConsent = async (agentName: string): Promise<PendingConsent | undefined> => {
    if (!opts.toolCredentials?.consent) return undefined;
    const after = await sessionService.get({ appName, userId, sessionId });
    const pending = pendingConsent(after?.events ?? []);
    return pending && pending.agent === agentName ? pending : undefined;
  };
  /** After the answering run: is a gated call now waiting? */
  const awaitingApproval = async (agentName: string): Promise<PendingApproval | undefined> => {
    const after = await sessionService.get({ appName, userId, sessionId });
    const pending = pendingApproval(after?.events ?? []);
    return pending && pending.agent === agentName ? pending : undefined;
  };
  /** After the answering run: did the agent ask the person something? */
  const asked = (run: DrainedRun): SyndicateTurnResult | undefined => {
    const input = run.inputRequests[run.inputRequests.length - 1];
    if (!input) return undefined;
    result.status = 'input-required';
    result.input = input;
    result.text = input.message;
    ev.log?.(`⏸ Input needed: ${describeInputForLog(input)}`);
    return finish();
  };
  /** After the answering run: does a pause wait inside a delegated call `agentName` left open (ADR 0110)? */
  const pausedBelow = async (agentName: string): Promise<SyndicateTurnResult | undefined> => {
    const after = await sessionService.get({ appName, userId, sessionId });
    const below = await pauseBelow(after?.events ?? [], agentName);
    if (below?.approval) return pause(below.approval);
    if (below?.consent) return consentPause(below.consent);
    if (below?.question) {
      result.status = 'input-required';
      result.input = below.question;
      result.text = below.question.message;
      ev.log?.(`⏸ Input needed: ${describeInputForLog({ node: below.question.node, path: below.path })}`);
      return finish();
    }
    return undefined;
  };
  const pause = (pending: PendingApproval): SyndicateTurnResult => {
    result.status = 'input-required';
    result.approval = pending;
    result.text = `Approval needed: ${describeApproval(pending)}.`;
    ev.log?.(`⏸ Approval needed: ${(pending.path ?? [pending.agent]).join(' → ')} → ${pending.tool}`);
    return finish();
  };
  /** The turn waits on what a question asks. */
  const question = (input: PendingInput): SyndicateTurnResult => {
    result.status = 'input-required';
    result.input = input;
    result.text = input.message;
    ev.log?.(`⏸ Input needed: ${describeInputForLog(input)}`);
    return finish();
  };
  /** A nested workflow's walk, or a nested dispatch syndicate's turn, paused below a route (ADR 0119, ADR 0120): its approval request, its consent request, else its question. */
  const pausedWalk = (paused: NestedWorkflowPause): SyndicateTurnResult =>
    paused.approval ? pause(paused.approval) : paused.consent ? consentPause(paused.consent) : question(paused.question!);

  /** Run ONE agent against ONE session, under the turn's controls. */
  const runAgent = async (params: {
    agent: TurnAgent;
    sid: string;
    /** The app the session is filed under; default the turn's. A workflow route walks on its child session (ADR 0106). */
    appName?: string;
    userParts: any[];
    sessions: SessionService;
    stage: TurnStage;
    route?: RouteResolution;
    publishToolStatus: boolean;
    /** Evaluated at span end: did the DELEGATE relay fall back? */
    relayFallback?: () => boolean;
    /** Workflow runs collect node errors instead of stopping on the first. */
    errorPolicy?: 'fail' | 'collect';
  }): Promise<DrainedRun> => {
    let stream: AsyncIterable<TurnEvent>;
    if (params.agent.runtime === 'native-workflow') {
      // The engine's scheduler walks the graph (lib/workflow/turn.ts): the same events, the same drain.
      stream = runNativeWorkflow({
        graph: params.agent.graph,
        agents: params.agent.agents,
        adapterFor: params.agent.adapterFor,
        resolveTool: params.agent.resolveTool,
        workflows: params.agent.workflows,
        sessions: params.sessions,
        appName: params.appName ?? appName,
        userId,
        sessionId: params.sid,
        userParts: params.userParts,
        signal: control.signal,
        stream: opts.streaming === true,
        memory: nativeMemory(opts.memoryService),
        ...(selfCorrection ? { selfCorrection } : {}),
        ...(credentialStore ? { credentials: credentialStore } : {}),
        ...(compileOpts.log ? { log: compileOpts.log } : {}),
      });
    } else {
      // The engine's own loop (lib/runtime/nativeTurn.ts): the same events, the same drain.
      stream = runNativeAgent({
        agent: params.agent.agent,
        adapterFor: params.agent.adapterFor,
        sessions: params.sessions,
        appName: params.appName ?? appName,
        userId,
        sessionId: params.sid,
        userParts: params.userParts,
        signal: control.signal,
        stream: opts.streaming === true,
        memory: nativeMemory(opts.memoryService),
        ...(selfCorrection ? { selfCorrection } : {}),
        // Tool credentials and the consent step (ADR 0072, ADR 0085); the classifier's lane lists no tools.
        ...(credentialStore ? { credentials: credentialStore } : {}),
        ...(consentStep && params.stage !== 'classify' ? { consent: consentStep } : {}),
        ...(compileOpts.log ? { log: compileOpts.log } : {}),
      });
    }
    if (trace) {
      stream = traceAgentRun(stream as AsyncIterableIterator<TurnEvent>, {
        syndicateName: trace.syndicateName ?? config.syndicate_name ?? appName,
        bindings: trace.bindings ?? config.variables ?? {},
        input: params.userParts,
        route: params.route,
        // Identity: the CONVERSATION id, not the classifier's throwaway lane —
        // every stage of one turn shares session and task ids.
        sessionId,
        userId,
        taskId: trace.taskId,
        stage: params.stage,
        configHash: trace.configHash,
        attributes: trace.attributes,
        onSpanStart: trace.onSpanStart,
        traceparent: trace.traceparent,
        onEnd: () => ({
          'syndicate.relay_fallback': params.stage === 'delegate' && !!params.relayFallback?.(),
          ...(control.stopReason ? { 'syndicate.stop_reason': control.stopReason } : {}),
          'syndicate.llm_calls': control.llmCalls,
        }),
      });
    }
    try {
      return await drainAgentStream(stream, {
        events: params.stage === 'classify' ? { ...ev, onEvent: undefined } : ev,
        publishToolStatus: params.publishToolStatus,
        subagentNames,
        streamText: params.stage !== 'classify' && !guarded,
        errorPolicy: params.errorPolicy,
      });
    } catch (err) {
      // A provider call aborted by cancel / deadline surfaces as a thrown
      // AbortError. That is a stop, not a crash.
      if (control.stopReason) {
        return emptyRun({ code: stopCode(control.stopReason), message: stopMessage(control.stopReason, control) });
      }
      throw err;
    }
  };

  /**
   * A dispatch route that is a workflow syndicate (ADR 0106): its whole graph
   * walked on the child session filed under the agent path and its kind
   * (`{ <app>/route:<route>, userId, sessionId }`, ADR 0119, ADR 0120; the
   * one filed under an older key is continued when the route ran in the
   * conversation before, entrySession),
   * created from the conversation's state the first time, `temp:` keys
   * dropped, and kept, as a delegated nested workflow walks (ADR 0098), and
   * drained by the reader a workflow turn uses, so the route's answer is what
   * the workflow would answer as its own syndicate. The conversation stores
   * the message and the answer, one event authored by the route that carries
   * the walk's state writes, so the classifier and the next route read the
   * exchange as they read any route's. A node that gave up fails the turn
   * NODE_FAILED, as a workflow turn does.
   *
   * A walk that ends paused (ADR 0119) stores the route's pause record in
   * place of the answer: authored by the route at its own path, no content,
   * the walk's open interrupts in `longRunningToolIds`, its state writes so
   * far. While it is the conversation's last event the route waits: the
   * turn reports the request or question with the path from the route down
   * to the node that asked (interrupts.ts routePause), a decision or a
   * plain-text answer resumes the route without classifying, and the walk
   * reads the answer as its explicit reply (`routeAnswer`).
   */
  const runWorkflowRoute = async (
    route: string,
    agent: TurnAgent,
    resolution: RouteResolution,
  ): Promise<{ answer: DrainedRun; paused?: NestedWorkflowPause } | { failed: SyndicateTurnResult }> => {
    const store = sessionService;
    const key = { appName, userId, sessionId };
    const shared = await store.get(key);
    if (!shared) throw new Error(`Session not found: ${sessionId} (appName=${appName}, userId=${userId})`);
    const kept = (state: Record<string, unknown> | undefined): Record<string, unknown> =>
      Object.fromEntries(Object.entries(state ?? {}).filter(([k]) => !k.startsWith(TEMP_STATE_PREFIX)));
    // Filed under the agent path (ADR 0119), else continued under the route's name alone where ADR 0106 filed it.
    const resumingWalk = resumingRoute !== undefined || routeAnswer !== undefined;
    const child = await entrySession(store, { appName, userId, sessionId, events: shared.events }, route, 'route', kept(shared.state), resumingWalk);
    const childKey = { appName: child.appName, userId, sessionId };
    const before = new Map(Object.entries(kept(child.state)).map(([k, v]) => [k, JSON.stringify(v)]));
    const invocationId = `e-${randomUUID()}`;
    await store.append(shared, createTurnEvent({ invocationId, author: 'user', content: { role: 'user', parts } as any }));
    /** The walk's state writes this turn, `temp:` keys aside: what the conversation's event for the route carries. */
    const written = async (): Promise<Record<string, unknown>> => {
      const after = kept((await store.get(childKey))?.state);
      return Object.fromEntries(Object.entries(after).filter(([k, v]) => before.get(k) !== JSON.stringify(v)));
    };
    let walked: DrainedRun;
    try {
      walked = await runAgent({ agent, sid: sessionId, appName: child.appName, userParts: routeAnswer ?? parts, sessions: sessionService, stage: 'dispatch', route: resolution, publishToolStatus: true, errorPolicy: 'collect' });
    } catch (err) {
      const last = control.stopReason ? undefined : (err as Error);
      if (!last) throw err;
      result.status = 'failed';
      result.failedStage = 'dispatch';
      result.error = { code: last instanceof UnsupportedWorkflowResumeError ? 'RESUME_UNSUPPORTED' : last instanceof NodeRunLimitError ? NODE_RUN_LIMIT : 'NODE_FAILED', message: last.message };
      return { failed: finish() };
    }
    if (!walked.error && !control.stopReason) {
      // A walk that ended paused (ADR 0119): the conversation stores the route's pause record, which names the walk's
      // open interrupts and carries its state writes so far; the next message finds the walk through it.
      const walkEnd = (await store.get(childKey))?.events.at(-1);
      const paused = walkEnd?.author === route && walkEnd.nodeInfo?.path === route && !walkEnd.content?.parts?.length ? await nestedWorkflowPause(pauseKey, route, 'route') : undefined;
      if (paused) {
        const record = workflowPauseEvent({ name: route, invocationId, input: null, interruptIds: [...(walkEnd!.longRunningToolIds ?? [])] });
        const stateDelta = await written();
        if (Object.keys(stateDelta).length) record.actions.stateDelta = stateDelta;
        await store.append((await store.get(key)) ?? shared, record);
        return { answer: walked, paused };
      }
    }
    if (walked.text && !walked.error && !control.stopReason) {
      const stateDelta = await written();
      const answered = createTurnEvent({
        invocationId,
        author: route,
        content: { role: 'model', parts: [{ text: walked.text }] },
        ...(Object.keys(stateDelta).length ? { actions: { stateDelta } } : {}),
      });
      await store.append((await store.get(key)) ?? shared, answered);
    }
    return { answer: walked };
  };

  /**
   * A dispatch route that is a nested dispatch syndicate (ADR 0120): its own
   * turn (runNestedDispatch: its classifier picks one of its routes, the
   * route answers), on the child session filed under the route's kind
   * (`<app>/route:<route>`, entrySession), created from the conversation's
   * state the first time, `temp:` keys dropped, and kept. The conversation
   * stores the message and, as for a workflow route, one event authored by
   * the route: its answer (the inner route's final text) with the state
   * writes, or, when its turn ends paused, the route's pause record naming
   * the one request it waits on. The turn reports that request with the
   * path from the route down (routePause, which follows the record into the
   * nested conversation), and the next message that answers it resumes the
   * route without classifying: the nested turn reads it as a message at the
   * top reads an answer (an approval decision as it came, a question's
   * answer as the person's text, any message once a grant is stored).
   */
  const runDispatchRoute = async (route: string, dispatch: DispatchSpec): Promise<{ answer: DrainedRun; paused?: NestedWorkflowPause } | { failed: SyndicateTurnResult }> => {
    const store = sessionService;
    const key = { appName, userId, sessionId };
    const shared = await store.get(key);
    if (!shared) throw new Error(`Session not found: ${sessionId} (appName=${appName}, userId=${userId})`);
    const kept = (state: Record<string, unknown> | undefined): Record<string, unknown> =>
      Object.fromEntries(Object.entries(state ?? {}).filter(([k]) => !k.startsWith(TEMP_STATE_PREFIX)));
    const resumingTurn = resumingRoute !== undefined || routeAnswer !== undefined || consentRoute !== undefined;
    const child = await entrySession(store, { appName, userId, sessionId, events: shared.events }, route, 'route', kept(shared.state), resumingTurn);
    const invocationId = `e-${randomUUID()}`;
    await store.append(shared, createTurnEvent({ invocationId, author: 'user', content: { role: 'user', parts } as any }));
    // A question's answer goes in as the person's words; anything else as it came.
    const nestedParts = routeAnswer ? [{ text: messageText }] : parts;
    const end = await runNestedDispatch(opts, control, _runtime, {
      config: dispatch.config,
      compile: dispatch.compile,
      name: route,
      sessions: store,
      appName: child.appName,
      userId,
      sessionId,
      parts: nestedParts,
    });
    if (control.stopReason) return { failed: finish() };
    if (end.status === 'failed') {
      result.status = 'failed';
      result.failedStage = 'dispatch';
      result.error = end.error ?? { code: 'ROUTE_FAILED', message: `${route} failed.` };
      return { failed: finish() };
    }
    const delta = Object.keys(end.stateDelta).length ? { actions: { stateDelta: end.stateDelta } } : {};
    const answer = emptyRun();
    answer.agents.add(route);
    if (end.status === 'input-required' && end.interruptId) {
      const record = workflowPauseEvent({ name: route, invocationId, input: null, interruptIds: [end.interruptId] });
      if (delta.actions) record.actions.stateDelta = delta.actions.stateDelta;
      await store.append((await store.get(key)) ?? shared, record);
      const stored = (await store.get(key))?.events ?? [];
      const paused = await routePause(pauseKey, stored, subagentNames);
      if (!paused) throw new Error(`${route}: its turn paused on ${end.interruptId}, which its conversation does not hold.`);
      return { answer, paused };
    }
    answer.text = end.text;
    if (end.text) {
      await store.append(
        (await store.get(key)) ?? shared,
        createTurnEvent({ invocationId, author: route, content: { role: 'model', parts: [{ text: end.text }] }, ...delta }),
      );
    }
    return { answer };
  };

  // While a route's walk waits on a gated call (ADR 0119), a message that is not its decision repeats the request: the
  // walk cannot move past the waiting node, so nothing is stored and nothing runs, as a workflow turn answers it.
  if (!decision && routePaused?.approval) return pause(routePaused.approval);

  let answer: DrainedRun;

  if (isDispatchSyndicate(config)) {
    // ══ PLAN ═════════════════════════════════════════════════════════════
    // Deterministic overrides first: when the message itself decides the
    // route there is nothing to classify, and the classifier call is skipped.
    const warnings: string[] = [];
    let resolution: RouteResolution | null = resumeTarget ? null : matchRouteOverride(messageText, config, warnings);
    let decidedBy: RouteDecision['decidedBy'] = 'override';
    for (const w of warnings) ev.warn?.(w);

    if (resumeTarget) {
      if (!subagentNames.has(resumeTarget.agent)) {
        throw new Error(`Call ${resumeTarget.id} was raised by '${resumeTarget.agent}', which is not a route of this syndicate.`);
      }
      resolution = { route: resumeTarget.agent, reason: resumeTarget.why, fellBack: false, fallbackReason: '', viaOverride: false };
      decidedBy = resuming ? 'approval' : granting || consentRoute ? 'consent' : 'answer';
    } else if (resolution) {
      ev.log?.(`⇄ Route pinned by override: ${resolution.route}`);
    } else if (opts.forceRoute) {
      if (!subagentNames.has(opts.forceRoute)) {
        throw new Error(`forceRoute '${opts.forceRoute}' is not a declared subagent`);
      }
      resolution = { route: opts.forceRoute, reason: 'forced by the caller', fellBack: false, fallbackReason: '', viaOverride: false };
      decidedBy = 'forced';
    } else {
      decidedBy = 'classifier';
      // The classifier reads the SHARED transcript as an input digest and runs
      // in a throwaway in-memory lane, so its JSON verdicts never enter the
      // conversation the next specialist reads.
      const routerAgent = await compileRoot();
      const routerSid = `${sessionId}::route`;
      const routerSessions = new InProcessSessionService();
      await routerSessions.create({ appName, userId, sessionId: routerSid });
      const shared = await sessionService.get({ appName, userId, sessionId });
      const digest = renderTranscriptDigest(shared?.events ?? []);
      const routerParts = digest
        ? [{ text: `${CLASSIFIER_PREAMBLE}${digest}\n\n--- MESSAGE TO CLASSIFY ---\n${messageText}` }]
        : parts;
      const plan = await runAgent({
        agent: routerAgent,
        sid: routerSid,
        userParts: routerParts,
        sessions: routerSessions,
        stage: 'classify',
        publishToolStatus: false,
      });
      result.classifier = plan;
      if (control.stopReason) return finish();
      // Fail-static: a dead classifier costs the user a good route, never
      // their answer. An empty payload resolves to default_route.
      resolution = resolveRoute(plan.error ? '' : plan.text, config);
      if (plan.error) {
        ev.warn?.(`Router failed [${plan.error.code}] — defaulting to '${resolution.route}'.`);
      } else if (resolution.fellBack) {
        ev.warn?.(`Routing fell back to '${resolution.route}': ${resolution.fallbackReason}`);
      }
    }

    const routeCfg: SubagentYamlConfig | undefined = (config.subagents ?? []).find((s) => s.name === resolution!.route);
    if (!routeCfg) throw new Error(`Dispatch failed: no subagent named '${resolution.route}' is declared.`);
    result.route = { ...resolution, decidedBy };
    const routeNote = resolution.reason ? ` — ${resolution.reason}` : '';
    // The classifier's reason can paraphrase the person: progress (to the caller) carries it, the log does not.
    ev.log?.(`⇄ Route: ${resolution.route}`);
    ev.onProgress?.(`Routed to ${resolution.route}${routeNote}`);

    // ══ DISPATCH ═════════════════════════════════════════════════════════
    if (routeCfg.a2a_agent_url) {
      // A remote route answers over A2A; its conversation id is derived from
      // this one, so follow-ups reach the same remote conversation.
      answer = await runRemoteRoute(routeCfg.name, routeCfg.a2a_agent_url, messageText, sessionId, control, ev);
    } else {
      // The route answers directly in the SHARED session, read through a
      // projection: other agents' turns would otherwise read as user speech
      // mixed with their tool payloads (lib/session/transcript.ts).
      const routeAgent = await compileRoute(routeCfg);
      if ('dispatch' in routeAgent) {
        // A nested dispatch syndicate runs as its own turn on its own conversation (ADR 0120).
        const ran = await runDispatchRoute(routeCfg.name, routeAgent.dispatch);
        if ('failed' in ran) return ran.failed;
        answer = ran.answer;
        // Its turn paused: the turn waits on what it waits on, with the path from the route down.
        if (ran.paused) {
          result.answer = answer;
          return pausedWalk(ran.paused);
        }
      } else if (routeAgent.workflow) {
        // A workflow route walks its whole graph on its own child session (ADR 0106).
        const walked = await runWorkflowRoute(routeCfg.name, routeAgent, resolution);
        if ('failed' in walked) return walked.failed;
        answer = walked.answer;
        // Its walk paused (ADR 0119): the turn waits on the node that asked, with the path from the route down to it.
        if (walked.paused) {
          result.answer = answer;
          return pausedWalk(walked.paused);
        }
      } else answer = await runAgent({
        agent: routeAgent,
        sid: sessionId,
        userParts: parts,
        // Resuming an approval or answering a question: the interrupted turn
        // is replayed raw, so the loop finds the call the message answers.
        sessions: new ProjectedSessionService(
          sessionService,
          routeCfg.name,
          resumingBelow
            ? { rawFrom: (events) => turnStartOfCall(events, resumingBelow!.callIds[0] as string) }
            : grantingBelow
            ? { rawFrom: (events) => turnStartOfCall(events, grantingBelow!.callIds[0] as string) }
            : resuming
            ? { rawFrom: (events) => interruptedTurnStart(events, resuming!.id) }
            : answering
              ? { rawFrom: (events) => turnStartOfCall(events, answering!.id) }
              : granting
                ? { rawFrom: (events) => turnStartOfCall(events, granting!.id) }
                : {},
        ),
        stage: 'dispatch',
        route: resolution,
        publishToolStatus: true,
      });
    }
    result.answer = answer;
    if (answer.error || control.stopReason) {
      result.status = 'failed';
      result.failedStage = 'dispatch';
      result.error = answer.error;
      return finish();
    }
    if (!routeCfg.a2a_agent_url && (agentGates(routeCfg) || routeCfg.yaml_reference)) {
      const pending = await awaitingApproval(routeCfg.name);
      if (pending) return pause(pending);
    }
    if (!routeCfg.a2a_agent_url) {
      const below = await pausedBelow(routeCfg.name);
      if (below) return below;
    }
    if (!routeCfg.a2a_agent_url) {
      const consent = await awaitingConsent(routeCfg.name);
      if (consent) return consentPause(consent);
    }
    const askedRoute = asked(answer);
    if (askedRoute) return askedRoute;
    result.text = answer.text;
    if (!result.text) {
      // Naming the route turns a blank reply into a lead (the XScout outage
      // shape: the specialist ran and returned nothing because its provider
      // rejected the call upstream).
      ev.warn?.(`Route '${resolution.route}' produced no output.`);
      result.text = `${resolution.route} returned no output — the server logs carry the upstream error.`;
    }
  } else if (isWorkflowSyndicate(config)) {
    // ══ WORKFLOW ═════════════════════════════════════════════════════════
    // The syndicate is a graph (lib/workflow.ts): every agent a node, run
    // in the shared session by the engine's scheduler (lib/workflow/turn.ts,
    // ADR 0095), drained through the same reader as any agent. A node agent sees only its input
    // unless its YAML says otherwise, so no projection is needed. An
    // `ask_user` node ends the turn input-required; the next message
    // resumes the graph where it waited.
    // While a gated call waits, a message that is not its decision repeats the request: the walk cannot move past
    // the waiting node, so nothing is stored and nothing runs, as the A2A server answers it (ADR 0098).
    // A node that is a nested workflow raised its walk's request again on the walk's own session (ADR 0119), wherever the gate is declared.
    if (!decision) {
      const open = pendingApproval(existing?.events ?? []);
      if (open) return pause(await deepen(open));
    }
    const workflowAgent: TurnAgent = await compileNativeWorkflowAgent(config, compileOpts);
    try {
      answer = await runAgent({
        agent: workflowAgent,
        sid: sessionId,
        userParts: parts,
        sessions: sessionService,
        stage: 'workflow',
        publishToolStatus: true,
        errorPolicy: 'collect',
      });
    } catch (err) {
      // A node that gave up (its retries spent, a timeout, a schema it could
      // not satisfy) ends the run by throwing; the last reported error names it.
      const last = control.stopReason ? undefined : (err as Error);
      if (!last) throw err;
      result.status = 'failed';
      result.failedStage = 'workflow';
      // A pause the walk cannot resume fails the turn rather than walking afresh (ADR 0094, ADR 0095).
      // The walk's node-run ceiling ends the turn by its own code, with a progress line (ADR 0105).
      const code = last instanceof UnsupportedWorkflowResumeError ? 'RESUME_UNSUPPORTED' : last instanceof NodeRunLimitError ? NODE_RUN_LIMIT : 'NODE_FAILED';
      if (last instanceof NodeRunLimitError) ev.onProgress?.(`Stopped: the workflow reached its limit of ${last.limit} node runs`);
      result.error = { code, message: last.message };
      return finish();
    }
    result.answer = answer;
    if (answer.error || control.stopReason) {
      result.status = 'failed';
      result.failedStage = 'workflow';
      result.error = answer.error;
      return finish();
    }
    // A gated call paused its node, and the walk with it (ADR 0098): the next message answers it. A node that is a
    // nested workflow pauses on its walk's request, reported with the path down to the node that asked (ADR 0119).
    const after = await sessionService.get({ appName, userId, sessionId });
    const pending = pendingApproval(after?.events ?? []);
    if (pending) return pause(await deepen(pending));
    if (answer.inputRequests.length) return question(await deepen(answer.inputRequests[answer.inputRequests.length - 1]!));
    result.text = answer.text;
    if (!result.text) {
      const failed = answer.nodeErrors[answer.nodeErrors.length - 1];
      ev.warn?.(`The workflow produced no output${failed ? ` (last node error: ${failed.node} [${failed.code}] ${failed.message})` : ''}.`);
      result.text = failed
        ? `The workflow ended without an answer — ${failed.node} failed [${failed.code}]: ${failed.message}`
        : 'The workflow ended without an answer.';
    }
  } else {
    // ══ DELEGATE ═════════════════════════════════════════════════════════
    // Subagents are delegation tools; the orchestrator relays the answer it got.
    const orchestrator = await compileRoot();
    let drained: DrainedRun | undefined;
    answer = await runAgent({
      agent: orchestrator,
      sid: sessionId,
      userParts: parts,
      sessions: sessionService,
      stage: 'delegate',
      publishToolStatus: true,
      relayFallback: () =>
        !!drained && (!drained.text || echoesToolName(drained.text, drained.invokedToolNames)) && !!drained.lastToolResultText,
    });
    drained = answer;
    result.answer = answer;
    if (answer.error || control.stopReason) {
      result.status = 'failed';
      result.failedStage = 'delegate';
      result.error = answer.error;
      return finish();
    }
    if (agentGates(config.orchestrator)) {
      const pending = await awaitingApproval(config.orchestrator.name);
      if (pending) return pause(pending);
    }
    const consent = await awaitingConsent(config.orchestrator.name);
    if (consent) return consentPause(consent);
    if (config.subagents?.length) {
      const below = await pausedBelow(config.orchestrator.name);
      if (below) return below;
    }
    const askedOrchestrator = asked(answer);
    if (askedOrchestrator) return askedOrchestrator;
    result.text = answer.text;
    // Failed-relay fallback: an orchestrator can botch the hop that relays a
    // specialist's answer — STOP with no text, or the bare tool NAME as its
    // text. Both discard a fully-formed result, so the last tool result is
    // returned deterministically instead of retrying the relay.
    const echoed = echoesToolName(result.text, answer.invokedToolNames);
    if ((!result.text || echoed) && answer.lastToolResultText) {
      ev.warn?.(
        `Orchestrator ${echoed ? `echoed the tool name ("${result.text}")` : 'emitted no text'} — `
        + `relaying last tool result verbatim (${answer.lastToolResultText.length.toLocaleString()} chars).`,
      );
      result.text = answer.lastToolResultText;
      result.relayFallback = true;
    }
  }

  // ══ GUARDS ═══════════════════════════════════════════════════════════════
  // Named in the syndicate's `guards:` list (and any nested syndicate's). They
  // REWRITE rather than retry, on the answering turn's text with every tool
  // result it produced. The classifier never reaches here.
  // A nested dispatch syndicate's guards run once, on the turn's answer at the top, which lists them (ADR 0120).
  const guardNames = nestedTurn ? [] : collectGuards(config, compileOpts.loadNested);
  if (result.text && guardNames.length) {
    const inputs = answer.toolResultTexts;
    for (const guard of resolveGuards(guardNames, (n) => ev.warn?.(`Unknown guard '${n}' — ignored`))) {
      try {
        const out = await guard.run(result.text, inputs);
        // Always logged, notes or not: a guard that ran clean must be
        // distinguishable from one that never ran.
        ev.log?.(`⛨ ${guard.name}: checked ${result.text.length.toLocaleString()} chars against ${inputs.length} tool result${inputs.length === 1 ? '' : 's'} — ${out.notes.length} note${out.notes.length === 1 ? '' : 's'}`);
        for (const note of out.notes) {
          ev.log?.(`⛨ ${guard.name}: ${note}`);
          ev.onProgress?.(`Guard ${guard.name}: ${note}`);
          result.guardNotes.push(`${guard.name}: ${note}`);
        }
        result.text = out.text;
      } catch (guardErr: unknown) {
        const msg = guardErr instanceof Error ? guardErr.message : String(guardErr);
        ev.warn?.(`Guard '${guard.name}' failed (answer shipped unguarded): ${msg}`);
        ev.onProgress?.(`Guard ${guard.name}: did not run (${msg})`);
        result.guardNotes.push(`${guard.name}: did not run (${msg})`);
      }
    }
  }

  return finish();
}

/** A plan-dispatch route that is a remote A2A agent (`a2a_agent_url`). */
async function runRemoteRoute(
  name: string,
  url: string,
  messageText: string,
  sessionId: string,
  control: ReturnType<typeof createTurnControl>,
  ev: TurnEvents,
): Promise<DrainedRun> {
  ev.onProgress?.(`Invoking remote agent: ${name}`);
  try {
    const answer = await new RemoteA2AAgent(url).send(messageText, {
      contextId: remoteContextId(sessionId, name),
      signal: control.signal,
    });
    const run = emptyRun();
    run.agents.add(name);
    run.delegations.push(name);
    if (answer.state === 'completed') {
      run.text = answer.text;
    } else {
      run.error = { code: `REMOTE_${answer.state.toUpperCase().replace(/-/g, '_')}`, message: remoteToolOutput(name, answer) };
    }
    return run;
  } catch (err: unknown) {
    if (control.stopReason) return emptyRun({ code: stopCode(control.stopReason), message: stopMessage(control.stopReason, control) });
    return emptyRun({ code: 'REMOTE_UNREACHABLE', message: `${name}: ${err instanceof Error ? err.message : String(err)}` });
  }
}

function emptyRun(error?: { code: string; message: string }): DrainedRun {
  return {
    inputRequests: [],
    nodeErrors: [],
    text: '',
    lastToolResultText: '',
    toolResultTexts: [],
    invokedToolNames: new Set(),
    toolCalls: [],
    toolResponses: 0,
    delegations: [],
    agents: new Set(),
    thoughts: '',
    tokens: { input: 0, output: 0, thinking: 0 },
    eventCount: 0,
    ...(error ? { error } : {}),
  };
}

// ── Long-term memory after a turn ────────────────────────────────────────────

/**
 * Distils the conversation into long-term memory (MemoryService.ingest).
 * Call it after the answer has been delivered — it never delays the reply,
 * and a failure here never fails the turn. Returns false when there was
 * nothing to ingest.
 */
export async function ingestTurnMemory(params: {
  memoryService: MemoryService;
  sessionService: SessionService;
  appName: string;
  userId: string;
  sessionId: string;
  extractionRules?: string;
  /** The syndicate's memory_extraction_model, when it declares one. */
  extractionModel?: string;
}): Promise<boolean> {
  const session = await params.sessionService.get({
    appName: params.appName,
    userId: params.userId,
    sessionId: params.sessionId,
  });
  if (!session || session.events.length === 0) return false;
  await params.memoryService.ingest(session, {
    ...(params.extractionRules !== undefined ? { extractionRules: params.extractionRules } : {}),
    ...(params.extractionModel !== undefined ? { extractionModel: params.extractionModel } : {}),
  });
  return true;
}
