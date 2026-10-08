/**
 * lib/tools/adkTool.ts — the boundary where an own Tool becomes an ADK tool.
 *
 * WHY this file exists:
 *   Tools are the engine's own (lib/tools/tool.ts, ADR 0051): a name, the
 *   declaration the model receives, and `execute(args, ctx)`. Until 1.0.0
 *   removes ADK (ADR 0045) the ADK runtime runs the same tools, and this
 *   module is the one place that turns a Tool into what ADK consumes: a
 *   FunctionTool whose Gemini-dialect parameters come from the Tool's
 *   declaration, and whose execute hands the Tool a ToolContext read from
 *   ADK's own Context. Nothing else in lib/tools builds an ADK tool from an
 *   own Tool, and tool.ts and toolContract.ts import nothing from ADK.
 *
 *   The ADK runtime behaves as it did when every tool was a FunctionTool:
 *   - the declaration ADK sends is the Tool's, in Gemini's dialect
 *     (toGeminiSchema), so contractToolDeclaration reads the same
 *     parameters through either path;
 *   - a long-running Tool is a long-running FunctionTool, and its pending
 *     (undefined) result is the null response ADK waits on;
 *   - a Tool that requires approval sets FunctionTool's own gate, which
 *     raises `adk_request_confirmation` as lib/compile.ts's gate does;
 *   - a Tool that throws becomes ADK's `Error in tool '<name>': …` response;
 *   - a Tool's `instruction`, and an InstructionTool's, are appended to the
 *     request's system instruction in the tool's processLlmRequest, joined
 *     as ADK's own appendInstructions joins them, at the tool's place in the
 *     agent's list: where ADK's load_memory and preload_memory wrote theirs
 *     (ADR 0059);
 *   - the context reaches the run's memory through ADK's own
 *     `Context.searchMemory`, so a search reads the silo ADK's tools read;
 *   - a NativeToolMarker is the shared sentinel the ADK runtime always ran
 *     for that server-side tool, which carries the same marker (ADR 0062).
 *
 *   toAdkTool takes any of these and picks the wrapper.
 */

import { BaseTool, FunctionTool, GOOGLE_SEARCH } from '@google/adk';
import type { Context, LlmRequest, ToolOptions, ToolProcessLlmRequest } from '@google/adk';
import type { Schema } from '@google/genai';

import type { NativeTool } from '../models/contract.ts';
import type { TurnContent } from '../runtime/events.ts';
import type { MemorySearchResult } from '../runtime/memoryService.ts';
import { currentTurnSignal } from '../runtime/turnControl.ts';
import { COLLECTIONS_SEARCH } from './collectionsSearchTool.ts';
import { OWN_TOOL, createToolContext, isInstructionTool, isNativeToolMarker, nativeToolMarkerOf } from './tool.ts';
import type { InstructionTool, NativeToolMarker, Tool, ToolActions, ToolConfirmation, ToolContext, ToolState } from './tool.ts';
import { URL_CONTEXT } from './urlContextTool.ts';
import { WEB_SEARCH } from './webSearchTool.ts';
import { X_SEARCH } from './xSearchTool.ts';
import { asTool, toGeminiSchema, toolCallContextFrom } from './toolContract.ts';
import type { ToolContract } from './toolContract.ts';

/**
 * ADK's Context seen as a ToolContext. Who the call is for is copied once;
 * the rest reads through to ADK's Context, so a state write lands in ADK's
 * own delta and `actions` is the event's actions.
 */
class AdkToolContext implements ToolContext {
  readonly userId?: string;
  readonly appName?: string;
  readonly sessionId?: string;
  readonly #adk: Context;
  #fallback?: ToolContext;

  constructor(adk: Context) {
    this.#adk = adk;
    const who = toolCallContextFrom(adk);
    this.userId = who?.userId;
    this.appName = who?.appName;
    this.sessionId = who?.sessionId;
  }

  /** A stand-in for the parts a partial Context (a test's) lacks. */
  get #local(): ToolContext {
    return (this.#fallback ??= createToolContext());
  }

  get invocationId(): string | undefined {
    return this.#adk.invocationContext?.invocationId;
  }

  get agentName(): string | undefined {
    const agent = (this.#adk.invocationContext as { agent?: { name?: string } } | undefined)?.agent;
    return agent?.name;
  }

  get functionCallId(): string | undefined {
    return this.#adk.functionCallId;
  }

  get state(): ToolState {
    return (this.#adk.state as unknown as ToolState | undefined) ?? this.#local.state;
  }

  get stateDelta(): Readonly<Record<string, unknown>> {
    return this.#adk.actions?.stateDelta ?? this.#local.stateDelta;
  }

  get actions(): ToolActions {
    return (this.#adk.actions as ToolActions | undefined) ?? this.#local.actions;
  }

  requestConfirmation(request: { hint?: string; payload?: unknown } = {}): void {
    this.#adk.requestConfirmation({ hint: request.hint, payload: request.payload });
  }

  get confirmation(): ToolConfirmation | undefined {
    const c = this.#adk.toolConfirmation;
    return c ? { confirmed: c.confirmed, hint: c.hint, payload: c.payload } : undefined;
  }

  get signal(): AbortSignal | undefined {
    return this.#adk.abortSignal ?? currentTurnSignal();
  }

  get userContent(): TurnContent | undefined {
    return (this.#adk.invocationContext as { userContent?: TurnContent } | undefined)?.userContent;
  }

  /**
   * ADK's own search: the run's memory service, under the session's app name
   * and user id. Absent when the run has no memory service.
   */
  get searchMemory(): ((query: string) => Promise<MemorySearchResult>) | undefined {
    if (!(this.#adk.invocationContext as { memoryService?: unknown } | undefined)?.memoryService) return undefined;
    return (query: string) => this.#adk.searchMemory(query) as Promise<MemorySearchResult>;
  }
}

/** The ToolContext for one ADK call; a standalone one outside a run. */
export function adkToolContext(adkContext: unknown): ToolContext {
  return adkContext && typeof adkContext === 'object' ? new AdkToolContext(adkContext as Context) : createToolContext();
}

/**
 * ADK surface: a FunctionTool that runs `tool`. Its Gemini-dialect
 * parameters derive from the Tool's declaration (for a defineTool contract,
 * from the zod schema), and its execute runs the Tool, which validates its
 * own arguments. Non-Gemini providers keep receiving the schema through
 * schemaNormalize.toLowercaseJsonSchema() at request-build time.
 *
 * Takes a Tool, or a hand-built contract object, which defineTool makes a
 * Tool first. The FunctionTool carries the Tool (toolOf in lib/tools/tool.ts
 * reads it back), so a runtime that resolves names through the registry can
 * run the Tool itself.
 */
export function toFunctionTool(tool: ToolContract<any>): FunctionTool;
export function toFunctionTool(tool: Tool): FunctionTool;
export function toFunctionTool(tool: Tool | ToolContract<any>): FunctionTool {
  const own = asTool(tool);
  const declaration = own.declaration();
  const options: ToolOptions<Schema> = {
    name: own.name,
    description: declaration.description,
    parameters: toGeminiSchema(declaration.parameters) as unknown as Schema,
    execute: (args: unknown, adkContext?: Context) =>
      own.execute((args ?? {}) as Record<string, unknown>, adkToolContext(adkContext)),
    isLongRunning: own.longRunning === true,
    requireConfirmation: own.requiresApproval === true,
  };
  // Only a Tool that writes into the instruction needs more than FunctionTool.
  const adkTool = typeof own.instruction === 'function' ? new InstructingFunctionTool(options) : new FunctionTool(options);
  Object.defineProperty(adkTool, OWN_TOOL, { value: own });
  return adkTool;
}

// ── Writing into the instruction (ADR 0059) ──────────────────────────────────

/**
 * Appends to the request's system instruction exactly as ADK's own
 * appendInstructions (models/llm_request.js, not exported) does: the texts
 * joined by a blank line, after a blank line when there is one already.
 */
function appendInstruction(llmRequest: LlmRequest, text: string): void {
  llmRequest.config ??= {};
  const config = llmRequest.config as { systemInstruction?: unknown };
  config.systemInstruction = config.systemInstruction ? `${config.systemInstruction as string}\n\n${text}` : text;
}

/**
 * The own tool an ADK tool carries. Read through `this`, not a private
 * field, so the copy lib/compile.ts makes with Object.create to gate a tool
 * still finds it.
 */
function carried<T>(adkTool: object): T {
  return (adkTool as Record<PropertyKey, unknown>)[OWN_TOOL] as T;
}

/** A FunctionTool that also appends its Tool's instruction, after declaring itself. */
class InstructingFunctionTool extends FunctionTool<Schema> {
  override async processLlmRequest(request: ToolProcessLlmRequest): Promise<void> {
    await super.processLlmRequest(request);
    const text = await carried<Tool>(this).instruction?.(adkToolContext(request.toolContext));
    if (text) appendInstruction(request.llmRequest, text);
  }
}

/** The ADK tool for an InstructionTool: declares nothing, and appends its instruction. */
class InstructionOnlyTool extends BaseTool {
  override async runAsync(): Promise<unknown> {
    throw new Error(`${this.name} only writes into the instruction and is never called by a model`);
  }

  override async processLlmRequest(request: ToolProcessLlmRequest): Promise<void> {
    await super.processLlmRequest(request);
    const text = await carried<InstructionTool>(this).instruction(adkToolContext(request.toolContext));
    if (text) appendInstruction(request.llmRequest, text);
  }
}

/**
 * ADK surface for an InstructionTool: a BaseTool that declares no function,
 * so it never enters the request's tools, and appends the InstructionTool's
 * text in processLlmRequest, where ADK's PreloadMemoryTool appended its own.
 * instructionToolOf (lib/tools/tool.ts) reads the InstructionTool back.
 */
export function toAdkInstructionTool(tool: InstructionTool): BaseTool {
  // ADK reads neither name nor description from a tool that declares
  // nothing; ADK's PreloadMemoryTool used its name for both.
  const adkTool = new InstructionOnlyTool({ name: tool.name, description: tool.name });
  Object.defineProperty(adkTool, OWN_TOOL, { value: tool });
  return adkTool;
}

// ── Server-side tools (ADR 0062) ─────────────────────────────────────────────

/**
 * The ADK runtime's object for each NativeTool a marker may name: the
 * engine's sentinels, which carry the same marker, and ADK's own
 * GOOGLE_SEARCH. Code execution is the agent's `code_execution: gemini`,
 * never a listed tool, so it has none.
 */
const ADK_NATIVE_TOOLS: Partial<Record<NativeTool, BaseTool>> = {
  web_search: WEB_SEARCH,
  x_search: X_SEARCH,
  url_context: URL_CONTEXT,
  collections_search: COLLECTIONS_SEARCH,
  google_search: GOOGLE_SEARCH,
};

/**
 * ADK surface for a NativeToolMarker: the shared sentinel the ADK runtime
 * has always run for it, which during processLlmRequest leaves itself in
 * the request for the adapter (or adds Gemini's own tool object).
 */
export function toAdkNativeTool(marker: NativeToolMarker): BaseTool {
  const native = nativeToolMarkerOf(marker);
  const adkTool = native ? ADK_NATIVE_TOOLS[native] : undefined;
  if (!adkTool) {
    throw new Error(`${marker.name} names no server-side tool an agent can list (code execution is an agent's code_execution: gemini)`);
  }
  return adkTool;
}

/**
 * What the engine holds as a tool, as the ADK runtime consumes it: a Tool
 * or a defineTool contract through toFunctionTool, an InstructionTool
 * through toAdkInstructionTool, a NativeToolMarker through toAdkNativeTool.
 * An ADK tool (one with runAsync) passes through as it is.
 */
export function toAdkTool(tool: Tool | ToolContract<any> | InstructionTool | NativeToolMarker | BaseTool): BaseTool {
  if (tool instanceof BaseTool || 'runAsync' in tool) return tool as BaseTool;
  if (isNativeToolMarker(tool)) return toAdkNativeTool(tool);
  if (isInstructionTool(tool)) return toAdkInstructionTool(tool);
  return toFunctionTool(tool as Tool);
}
