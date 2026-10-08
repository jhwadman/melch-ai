/**
 * lib/tools/tool.ts — the engine's own tool base: what a tool is, and what a
 * call hands it (ADR 0045, ADR 0051).
 *
 * WHY this file exists:
 *   The engine owns its loop, so it owns the tool's shape too: a name, the
 *   declaration the model receives (the model contract's ToolDeclaration,
 *   lib/models/contract.ts), and an `execute(args, ctx)` the loop calls.
 *   Nothing here needs ADK's FunctionTool or its `Context`; registerTool
 *   refuses an ADK tool (anything with runAsync), naming 1.0.0 and
 *   defineTool.
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
 *   - the turn's abort signal;
 *   - the message that started the run (`userContent`), and `searchMemory`,
 *     long-term recall for this user alone, when the run has memory
 *     (ADR 0059);
 *   - `accessToken(provider)`, a valid third-party token for this user
 *     alone, when the run has a credential store (lib/tools/auth.ts,
 *     ADR 0072), and `requestCredential(provider)`, which pauses the turn
 *     for the person's OAuth consent, when it also has a consent step
 *     (lib/tools/oauthConsent.ts, ADR 0085).
 *
 * WRITING INTO THE INSTRUCTION (ADR 0059): a Tool may also add text to the
 * system instruction of each model request made for an agent that lists it
 * (`instruction`), as load_memory says that memory exists. An InstructionTool
 * does only that and declares no function: preload_memory, which writes the
 * user's recalled facts into the instruction. Both run before the request
 * is sent, in the order the agent lists its tools.
 *
 * SERVER-SIDE TOOLS (ADR 0062): a NativeToolMarker declares no function
 * either; it names the NativeTool the provider runs on its own side
 * (web_search, x_search, url_context, collections_search). Every reader
 * recognises one by its marker symbol, never by class or name.
 *
 * A LEAF: types and plain functions. Its imports are types from the model
 * contract and the runtime's event and memory interfaces, and the leaf
 * lib/tools/auth.ts; nothing in its import graph names @google/*, which
 * tests/toolContract.test.ts asserts.
 *
 * Tool results and model output are data, never instructions: a tool returns
 * what it found, and nothing here reads a result to decide what runs next.
 */

import type { NativeTool, ToolDeclaration } from '../models/contract.ts';
import type { TurnContent } from '../runtime/events.ts';
import type { MemorySearchResult, MemoryService } from '../runtime/memoryService.ts';
import { toolAccessToken } from './auth.ts';
import type { CredentialStore, ToolAccessToken } from './auth.ts';

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
  /** The run (an invocation, in ADK's word) this call belongs to. */
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
  /**
   * The message that started this run: what the person asked, or for a
   * delegated subagent the request its orchestrator sent.
   */
  readonly userContent?: TurnContent;
  /**
   * Long-term memory's facts for the query, from this context's own
   * `<appName>/<userId>` silo: a tool cannot name another user's. Present
   * only when the run has a memory service (ADR 0020, ADR 0059).
   */
  readonly searchMemory?: (query: string) => Promise<MemorySearchResult>;
  /**
   * A valid access token for a third-party provider, from this context's
   * own app and user: a tool names the provider, never whose token. It is
   * refreshed first when expired, and throws a ToolCredentialError, whose
   * message names no value, when the user has not connected the provider.
   * The token goes to its provider only: never into a result, an error or a
   * log. Present only when the run has a credential store (ADR 0072).
   */
  readonly accessToken?: ToolAccessToken;
  /**
   * Ask the person to grant this call access to `provider` (OAuth consent,
   * ADR 0085). The runtime raises ADK's `adk_request_credential` interrupt
   * for the call, the turn pauses with the authorization URL, and once the
   * person has granted it their next message runs this call again, when
   * `accessToken(provider)` returns their token. `accessToken` asks by itself
   * when the person has not connected the provider, so most tools never
   * call this. Present only in a run with a consent step, for a call the
   * turn runs directly (not inside a delegated subagent).
   */
  readonly requestCredential?: (provider: string) => Promise<void>;
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
  /**
   * Text added to the system instruction of each model request made for an
   * agent that lists this tool, or undefined to add nothing. It reads the
   * context and writes nothing to it.
   */
  instruction?(ctx: ToolContext): Promise<string | undefined>;
  /**
   * Adds to the history of each model request made for an agent that lists
   * this tool, after the history is projected and before it is sent, in the
   * order the agent lists its tools: load_skill_resource shows a binary file
   * it just answered for as inline data (lib/tools/skills/tools.ts), where
   * ADK's tool did so in its processLlmRequest. It may append to `contents`
   * and changes nothing else; nothing it adds is stored.
   */
  contents?(contents: TurnContent[], ctx: ToolContext): Promise<void>;
}

// ── Toolsets ─────────────────────────────────────────────────────────────────

/** What a toolset reads to list its tools: the agent, and the session state. */
export interface ToolsetContext {
  readonly agentName?: string;
  readonly invocationId?: string;
  readonly state: { get(key: string): unknown };
}

/**
 * Listed under an agent's tools like a Tool, but yields the tools the agent
 * has for the next request: the skills harness (lib/tools/skills/tools.ts),
 * whose tools grow as skills are loaded. The native loop expands it before
 * every request.
 */
export interface Toolset {
  readonly name?: string;
  getTools(ctx?: ToolsetContext): Promise<unknown[]>;
}

/** True for an own Toolset: getTools, and neither a Tool nor an ADK-shaped tool or toolset (runAsync, processLlmRequest). */
export function isOwnToolset(value: unknown): value is Toolset {
  if (!value || typeof value !== 'object') return false;
  const t = value as Record<string, unknown>;
  return typeof t.getTools === 'function' && typeof t.execute !== 'function' && !('runAsync' in t) && typeof t.processLlmRequest !== 'function';
}

/** The own Toolset `value` is, else undefined. */
export function toolsetOf(value: unknown): Toolset | undefined {
  return isOwnToolset(value) ? value : undefined;
}

/**
 * Listed under an agent's `tools:` like a Tool, but declares no function and
 * is never called: it only adds text to the system instruction of each model
 * request, as `Tool.instruction` does (preload_memory).
 */
export interface InstructionTool {
  readonly name: string;
  instruction(ctx: ToolContext): Promise<string | undefined>;
}

// ── Server-side tools (ADR 0062) ─────────────────────────────────────────────

/**
 * Where a server-side tool names the NativeTool it stands for. A global
 * symbol, so a second copy of this module still matches.
 */
export const NATIVE_TOOL: unique symbol = Symbol.for('melchizedek.nativeTool');

/**
 * Listed under an agent's `tools:` like a Tool, but declares no function and
 * is never called here: the provider runs it on its own side (web_search,
 * x_search, url_context, collections_search). The marker only names the
 * NativeTool; the request carries it in `nativeTools`, and each adapter adds
 * its provider's own tool object or drops it (lib/models/capabilities.ts).
 */
export interface NativeToolMarker {
  readonly name: string;
  /** What the tool is, for a reader: never sent as a declaration. */
  readonly description: string;
  readonly [NATIVE_TOOL]: NativeTool;
}

/** A frozen marker for `nativeTool`, listed under the NativeTool's own name. */
export function nativeToolMarker(nativeTool: NativeTool, description = ''): NativeToolMarker {
  return Object.freeze({ name: nativeTool, description, [NATIVE_TOOL]: nativeTool });
}

/**
 * The NativeTool `value` stands for, read from its marker: the marker
 * itself, or anything carrying the marker's symbol. Undefined for anything
 * else. Never by class
 * or by name: a client-side tool registered as `web_search` carries no
 * marker and stays a client-side tool.
 */
export function nativeToolMarkerOf(value: unknown): NativeTool | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const native = (value as Record<PropertyKey, unknown>)[NATIVE_TOOL];
  return typeof native === 'string' ? (native as NativeTool) : undefined;
}

/** True for a NativeToolMarker itself (not an ADK tool, which has runAsync). */
export function isNativeToolMarker(value: unknown): value is NativeToolMarker {
  return nativeToolMarkerOf(value) !== undefined && typeof (value as { name?: unknown }).name === 'string' && !('runAsync' in (value as object));
}

/** True for an InstructionTool: an instruction and no declaration (and not an ADK tool, which has runAsync). */
export function isInstructionTool(value: unknown): value is InstructionTool {
  if (!value || typeof value !== 'object') return false;
  const t = value as Record<string, unknown>;
  return typeof t.name === 'string' && typeof t.instruction === 'function' && !('declaration' in t) && !('runAsync' in t);
}

/**
 * Appended to a long-running tool's description, word for word what ADK's
 * LongRunningFunctionTool appended, so a model reads the declaration it
 * read before 1.0.0.
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
 * The texts ADK's FunctionTool gate wrote, kept word for word so a call
 * gated now stores the interrupt and the response a session written before
 * 1.0.0 holds.
 */
export const APPROVAL_TEXTS = {
  hint: (name: string) =>
    `Please approve or reject the tool call ${name}() by responding with a FunctionResponse with an expected ToolConfirmation payload.`,
  pending: 'This tool call requires confirmation, please approve or reject.',
  rejected: 'This tool call is rejected.',
} as const;

/**
 * What a call that asked for a grant answers while the person grants it
 * (ADR 0085): the model reads it if the turn goes on without the grant. It
 * names the provider, never a URL, a state or a token.
 */
export const CONSENT_TEXTS = {
  pending: (provider: string) => `This tool call needs access to the user's ${provider} account. The user has been asked to authorize it; the call runs again once they have.`,
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
  /** The message that started the run. */
  userContent?: TurnContent;
  /**
   * The run's long-term memory, already pinned to the root syndicate's
   * namespace (namespacedMemoryService). The context searches it under its
   * own `appName` and `userId` only.
   */
  memory?: Pick<MemoryService, 'search'>;
  /**
   * The run's tool credentials, already pinned to its app
   * (pinnedCredentialStore). The context reads them under its own `appName`
   * and `userId` only.
   */
  credentials?: Pick<CredentialStore, 'get'>;
}

/** A context the caller built, with what the call asked for readable afterwards. */
export interface StandaloneToolContext extends ToolContext {
  /** Set when the tool called requestConfirmation. */
  readonly confirmationRequest?: { hint?: string; payload?: unknown };
}

/**
 * A ToolContext over plain data: for the native loop, for a call made
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
    userContent: init.userContent,
    searchMemory: init.memory ? memorySearch(init.memory, init.appName, init.userId) : undefined,
    accessToken: init.credentials ? toolAccessToken(init.credentials, init.appName, init.userId, init.signal) : undefined,
  };
}

/**
 * Search bound to one silo. A context that does not know whose silo it is
 * refuses, rather than search a key nobody writes to.
 */
function memorySearch(
  memory: Pick<MemoryService, 'search'>,
  appName: string | undefined,
  userId: string | undefined,
): (query: string) => Promise<MemorySearchResult> {
  return async (query: string) => {
    if (!appName || !userId) throw new Error('Memory search needs the app name and user id of the run.');
    return memory.search({ appName, userId, query });
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

// ── Reading a listed tool ────────────────────────────────────────────────────

/**
 * The Tool `value` is, else undefined (a server-side tool and an
 * InstructionTool are not Tools).
 */
export function toolOf(value: unknown): Tool | undefined {
  return isTool(value) ? value : undefined;
}

/** The InstructionTool `value` is, else undefined. */
export function instructionToolOf(value: unknown): InstructionTool | undefined {
  return isInstructionTool(value) ? value : undefined;
}
