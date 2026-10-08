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
 *   - a Tool that throws becomes ADK's `Error in tool '<name>': …` response.
 */

import { FunctionTool } from '@google/adk';
import type { Context } from '@google/adk';
import type { Schema } from '@google/genai';

import { currentTurnSignal } from '../runtime/turnControl.ts';
import { OWN_TOOL, createToolContext } from './tool.ts';
import type { Tool, ToolActions, ToolConfirmation, ToolContext, ToolState } from './tool.ts';
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
  const adkTool = new FunctionTool({
    name: own.name,
    description: declaration.description,
    parameters: toGeminiSchema(declaration.parameters) as unknown as Schema,
    execute: (args: unknown, adkContext?: Context) =>
      own.execute((args ?? {}) as Record<string, unknown>, adkToolContext(adkContext)),
    isLongRunning: own.longRunning === true,
    requireConfirmation: own.requiresApproval === true,
  });
  Object.defineProperty(adkTool, OWN_TOOL, { value: own });
  return adkTool;
}
