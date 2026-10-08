/**
 * lib/tools/tool.ts — the engine's own tool base: what a tool is, and what a
 * call hands it (ADR 0045, ADR 0051).
 *
 * WHY this file exists:
 *   Every tool used to be an ADK FunctionTool, so running one needed ADK's
 *   loop and ADK's `Context`. The native runtime owns its loop, so it owns
 *   the tool's shape too: a name, the declaration the model receives (the
 *   model contract's ToolDeclaration, lib/models/contract.ts), and an
 *   `execute(args, ctx)` the loop calls. During the dual-runtime period the
 *   ADK runtime runs the same tools through one wrapper,
 *   lib/tools/adkTool.ts (`toFunctionTool`), so a tool is written once and
 *   runs on both.
 *
 *   A tool is usually built with `defineTool` (lib/tools/toolContract.ts),
 *   which derives the declaration from a zod schema and validates arguments
 *   before the handler runs. Anything that implements `Tool` works the same.
 *
 * WHAT A CALL HANDS A TOOL (ToolContext):
 *   - who: the invocation, agent, call, user, app and session ids;
 *   - the session state, as a view whose reads see this call's writes, and
 *     `stateDelta`, the writes the runtime applies with the tool's result;
 *   - `actions.skipSummarization`, which ends the agent's step on this result;
 *   - `requestConfirmation` and `confirmation`, the approval gate (ADR 0028);
 *   - the turn's abort signal.
 *
 * A LEAF: types and plain functions. Its one import is a type from the model
 * contract; nothing in its import graph names @google/*, which
 * tests/toolContract.test.ts asserts.
 *
 * Tool results and model output are data, never instructions: a tool returns
 * what it found, and nothing here reads a result to decide what runs next.
 */

import type { ToolDeclaration } from '../models/contract.ts';

// ── The context a call receives ──────────────────────────────────────────────

/** Session state as a tool sees it: reads see the writes this call made. */
export interface ToolState {
  get<T = unknown>(key: string): T | undefined;
  /** Writes the value and records it in the context's `stateDelta`. */
  set(key: string, value: unknown): void;
  has(key: string): boolean;
}

/** A person's answer to an approval request for this call (ADR 0028). */
export interface ToolConfirmation {
  confirmed: boolean;
  hint?: string;
  payload?: unknown;
}

/** What the call asks of the step it runs in. */
export interface ToolActions {
  /** End the agent's step on this result: the model is not called to summarise it. */
  skipSummarization?: boolean;
}

export interface ToolContext {
  /** The run (ADK's invocation) this call belongs to. */
  readonly invocationId?: string;
  /** The agent whose model asked for the call. */
  readonly agentName?: string;
  /** The model's id for this call; the result answers it. */
  readonly functionCallId?: string;
  /** Who the call is for (the A2A server's scope key), when the surface knows. */
  readonly userId?: string;
  readonly appName?: string;
  readonly sessionId?: string;
  /** The session's state. Writes land in `stateDelta`. */
  readonly state: ToolState;
  /** The state writes this call made, applied to the session with its result. */
  readonly stateDelta: Readonly<Record<string, unknown>>;
  readonly actions: ToolActions;
  /**
   * Ask a person to approve this call before it runs. The runtime raises the
   * `adk_request_confirmation` interrupt for it and the turn pauses; the
   * answer arrives as `confirmation` when the call runs again.
   */
  requestConfirmation(request?: { hint?: string; payload?: unknown }): void;
  /** The person's answer, when this call is the approved or refused retry. */
  readonly confirmation?: ToolConfirmation;
  /** Aborts with the turn (lib/runtime/turnControl.ts). */
  readonly signal?: AbortSignal;
}

// ── The tool ─────────────────────────────────────────────────────────────────

export interface Tool {
  readonly name: string;
  /** What the model is told: name, description and lowercase JSON Schema parameters. */
  declaration(): ToolDeclaration;
  /**
   * Run one call. `args` are what the model chose: untrusted input, which
   * the tool validates before it acts on them (defineTool does it from the
   * schema). The result is JSON-serializable data the model reads. A tool
   * that fails says so in its result; a throw is caught by the runtime and
   * reported to the model as the call's error. A long-running tool resolves
   * to undefined while its answer is pending.
   */
  execute(args: Record<string, unknown>, ctx: ToolContext): Promise<unknown>;
  /**
   * The call's answer comes later (ask_user): a pending result ends the turn
   * and the next message answers the call. See LONG_RUNNING_NOTE.
   */
  readonly longRunning?: boolean;
  /** Each call waits for a person's approval (requireApproval). */
  readonly requiresApproval?: boolean;
}

/**
 * Appended to a long-running tool's description, word for word what ADK's
 * LongRunningFunctionTool appends, so a model reads the same declaration on
 * either runtime.
 */
export const LONG_RUNNING_NOTE =
  '\n\nNOTE: This is a long-running operation. Do not call this tool again if it has already returned some intermediate or pending status.';

/** True for a tool whose answer arrives later. */
export function isLongRunning(tool: Tool): boolean {
  return tool.longRunning === true;
}

/** True for anything shaped like a Tool (and not an ADK tool, which has runAsync). */
export function isTool(value: unknown): value is Tool {
  if (!value || typeof value !== 'object') return false;
  const t = value as Record<string, unknown>;
  return typeof t.name === 'string' && typeof t.declaration === 'function' && typeof t.execute === 'function' && !('runAsync' in t);
}

// ── Approval (ADR 0028) ──────────────────────────────────────────────────────

/**
 * The texts ADK's FunctionTool gate writes, kept word for word so a call
 * gated on either runtime stores the same interrupt and the same response.
 */
export const APPROVAL_TEXTS = {
  hint: (name: string) =>
    `Please approve or reject the tool call ${name}() by responding with a FunctionResponse with an expected ToolConfirmation payload.`,
  pending: 'This tool call requires confirmation, please approve or reject.',
  rejected: 'This tool call is rejected.',
} as const;

/**
 * A copy of `tool` that runs only after a person approves the call. The
 * first call requests confirmation, ends the step and returns the pending
 * notice; the retry carrying the answer runs the tool or returns the
 * refusal. The original stays ungated for every other agent that lists it.
 */
export function requireApproval(tool: Tool): Tool {
  if (tool.requiresApproval) return tool;
  const gated = Object.create(tool) as Tool;
  Object.defineProperties(gated, {
    requiresApproval: { value: true, enumerable: true },
    execute: {
      enumerable: true,
      value: async (args: Record<string, unknown>, ctx?: ToolContext): Promise<unknown> => {
        const context = toToolContext(ctx);
        if (!context.confirmation) {
          context.requestConfirmation({ hint: APPROVAL_TEXTS.hint(tool.name) });
          context.actions.skipSummarization = true;
          return { error: APPROVAL_TEXTS.pending };
        }
        if (!context.confirmation.confirmed) return { error: APPROVAL_TEXTS.rejected };
        return tool.execute(args, context);
      },
    },
  });
  return gated;
}

// ── Result size ──────────────────────────────────────────────────────────────

/**
 * Characters one tool result may carry into the conversation: the limit the
 * OpenAPI and MCP tools already hold their results to
 * (lib/tools/openapiTools.ts, lib/tools/mcpToolFactory.ts).
 */
export const MAX_RESULT_CHARS = 20_000;

/**
 * `result` cut to `max` characters, saying so. A string stays a string; any
 * other value over the limit becomes `{ truncated: true, text }` holding the
 * start of its JSON, the shape OpenAPI results already take.
 */
export function capResult(result: unknown, max: number = MAX_RESULT_CHARS): unknown {
  if (result === undefined || result === null) return result;
  const marker = `… [cut at ${max} characters]`;
  if (typeof result === 'string') return result.length <= max ? result : `${result.slice(0, max)}${marker}`;
  let text: string;
  try {
    text = JSON.stringify(result) ?? '';
  } catch {
    text = String(result);
  }
  return text.length <= max ? result : { truncated: true, text: `${text.slice(0, max)}${marker}` };
}

// ── Contexts ─────────────────────────────────────────────────────────────────

/** What createToolContext starts from. */
export interface ToolContextInit {
  invocationId?: string;
  agentName?: string;
  functionCallId?: string;
  userId?: string;
  appName?: string;
  sessionId?: string;
  /** The session state the call reads. Never mutated: writes go to the delta. */
  state?: Readonly<Record<string, unknown>>;
  confirmation?: ToolConfirmation;
  signal?: AbortSignal;
}

/** A context the caller built, with what the call asked for readable afterwards. */
export interface StandaloneToolContext extends ToolContext {
  /** Set when the tool called requestConfirmation. */
  readonly confirmationRequest?: { hint?: string; payload?: unknown };
}

/**
 * A ToolContext over plain data: for the native runtime, for a call made
 * outside a run (MCP, a test), and for a caller that knows only who the call
 * is for. The runtime reads `stateDelta`, `actions` and `confirmationRequest`
 * back after the call.
 */
export function createToolContext(init: ToolContextInit = {}): StandaloneToolContext {
  const base = init.state ?? {};
  const delta: Record<string, unknown> = {};
  const actions: ToolActions = {};
  let request: { hint?: string; payload?: unknown } | undefined;
  const state: ToolState = {
    get: <T = unknown>(key: string) =>
      (Object.hasOwn(delta, key) ? delta[key] : Object.hasOwn(base, key) ? base[key] : undefined) as T | undefined,
    set: (key, value) => {
      // defineProperty, so a key named __proto__ is data, not a prototype.
      Object.defineProperty(delta, key, { value, enumerable: true, writable: true, configurable: true });
    },
    has: (key) => Object.hasOwn(delta, key) || Object.hasOwn(base, key),
  };
  return {
    invocationId: init.invocationId,
    agentName: init.agentName,
    functionCallId: init.functionCallId,
    userId: init.userId,
    appName: init.appName,
    sessionId: init.sessionId,
    state,
    stateDelta: delta,
    actions,
    requestConfirmation: (req = {}) => {
      request = { hint: req.hint, payload: req.payload };
    },
    get confirmationRequest() {
      return request;
    },
    confirmation: init.confirmation,
    signal: init.signal,
  };
}

/** True for a complete ToolContext. Checks presence only, so no getter runs. */
export function isToolContext(value: unknown): value is ToolContext {
  if (!value || typeof value !== 'object') return false;
  const c = value as Record<string, unknown>;
  return 'state' in c && 'stateDelta' in c && 'actions' in c && typeof c.requestConfirmation === 'function';
}

/**
 * The context a tool runs with: `ctx` itself when it is complete, else a
 * standalone one carrying whatever identity `ctx` names (`{ userId }` from a
 * caller that knows only who the call is for, or nothing).
 */
export function toToolContext(ctx?: Partial<ToolContext>): ToolContext {
  if (isToolContext(ctx)) return ctx;
  return createToolContext({ userId: ctx?.userId, appName: ctx?.appName, sessionId: ctx?.sessionId });
}

// ── The bridge from the ADK runtime ──────────────────────────────────────────

/**
 * Where lib/tools/adkTool.ts keeps the Tool an ADK tool was made from. A
 * global symbol, so a second copy of either module still finds it.
 */
export const OWN_TOOL: unique symbol = Symbol.for('melchizedek.tool');

/**
 * The Tool behind `value`: the value itself when it is a Tool, the Tool an
 * ADK tool was made from by toFunctionTool, else undefined (a server-side
 * sentinel, a memory tool, an MCP or subagent tool). An ADK tool that was
 * gated afterwards (lib/compile.ts sets `requireConfirmation`) yields the
 * gated Tool, so the gate survives the trip back.
 */
export function toolOf(value: unknown): Tool | undefined {
  if (isTool(value)) return value;
  if (!value || typeof value !== 'object') return undefined;
  const own = (value as Record<PropertyKey, unknown>)[OWN_TOOL];
  if (!isTool(own)) return undefined;
  return (value as { requireConfirmation?: unknown }).requireConfirmation === true ? requireApproval(own) : own;
}
