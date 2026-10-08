/**
 * lib/tools/toolContract.ts — define a tool ONCE, serve it anywhere.
 *
 * WHY this file exists:
 *   A native tool that should be reachable both by our own agents and by
 *   outside MCP clients (standard JSON Schema in tools/list) previously
 *   needed its schema hand-written twice — two dialects of the same
 *   contract, guaranteed to drift. Here a tool is one object — name,
 *   description, zod schema, execute — and `defineTool` makes it an own
 *   Tool (lib/tools/tool.ts) that every surface derives from:
 *
 *     defineTool(...) ──► declaration()          the native runtime (ADR 0048 shape)
 *                    ├──► toFunctionTool()        the ADK runtime (lib/tools/adkTool.ts)
 *                    └──► toMcpToolDefinition()   MCP tools/list entry
 *
 *   The zod schema is the single source of truth. zodInputJsonSchema()
 *   (lib/models/schemaNormalize.ts) emits standard JSON Schema for the
 *   schema's input side, so a field with a default is optional to the
 *   model; toGeminiSchema() below derives the ADK dialect from it.
 *
 *   No ADK here: this module and lib/tools/tool.ts import nothing from
 *   @google/* at runtime, so the native runtime runs a contract without ADK.
 *   The ADK wrapper, toFunctionTool, lives at the boundary in
 *   lib/tools/adkTool.ts.
 *
 *   DELIBERATELY NOT HERE: exposure. Defining a contract publishes nothing.
 *   An agent sees the tool only when its name is added to TOOL_MAP in
 *   lib/toolRegistry.ts AND declared in the syndicate YAML; an MCP client
 *   sees it only when a server script explicitly lists it (see
 *   scripts/science_mcp_server.ts). Both remain deliberate acts.
 */

import type { z } from 'zod';

import type { ToolDeclaration } from '../models/contract.ts';
import { mapSchemaNodes, zodInputJsonSchema, zodToolParameters } from '../models/schemaNormalize.ts';
import { LONG_RUNNING_NOTE, capResult, isTool, toToolContext } from './tool.ts';
import type { Tool, ToolContext } from './tool.ts';

/**
 * Who a tool call is for, when the surface knows. The ADK surface fills it
 * from the invocation (the A2A server's scope key is the user id); the MCP
 * surface has no caller and passes nothing. A tool that keeps per-user state
 * scopes it by `userId`; most tools ignore it. Every ToolContext carries
 * these fields.
 */
export interface ToolCallContext {
  userId?: string;
  appName?: string;
  sessionId?: string;
}

/**
 * The plain shape of a contract: what defineTool takes, and what the
 * surfaces accept from code that builds the object by hand.
 */
export interface ToolContract<S extends z.ZodType = z.ZodType> {
  name: string;
  /** LLM-facing prompt text, not developer docs — it steers when agents call the tool. */
  description: string;
  /** Single source of truth for the input shape; every surface derives from it. */
  schema: S;
  execute: (input: z.infer<S>, context?: ToolCallContext) => Promise<string>;
}

/** What defineTool takes: a contract, with options for how the Tool runs. */
export interface ToolSpec<S extends z.ZodType = z.ZodType, R = string> {
  name: string;
  /** LLM-facing prompt text, not developer docs — it steers when agents call the tool. */
  description: string;
  /** Single source of truth for the input shape; every surface derives from it. */
  schema: S;
  /**
   * Runs with arguments the schema has already validated (defaults
   * applied), and a complete ToolContext on every surface: off a run it is
   * a standalone one carrying whatever identity the caller knew.
   */
  execute: (input: z.infer<S>, context: ToolContext) => Promise<R>;
  /** The answer comes later; the handler resolves to undefined while it is pending (ask_user). */
  longRunning?: boolean;
  /** Cut the result to this many characters (capResult). Off unless set; MAX_RESULT_CHARS is the shared limit. */
  maxResultChars?: number;
}

/**
 * A Tool made by defineTool. It is also a ToolContract: `name`,
 * `description` and `schema` are the spec's, and `execute` validates the
 * model's arguments before the handler runs, returning the readable error
 * string when they do not parse.
 */
export interface DefinedTool<S extends z.ZodType = z.ZodType, R = string> extends Tool {
  readonly name: string;
  readonly description: string;
  readonly schema: S;
  readonly longRunning: boolean;
  declaration(): ToolDeclaration;
  execute(args: unknown, context?: ToolCallContext): Promise<R | string>;
}

/** Marks what defineTool made, so executeContract validates once. A global symbol, so a second copy of this module agrees. */
const DEFINED = Symbol.for('melchizedek.definedTool');

/** The error string a call with arguments the schema refuses returns, never a throw. */
function invalidArguments(name: string, error: { issues: Array<{ path: PropertyKey[]; message: string }> }): string {
  const issues = error.issues.map((i) => `${i.path.map(String).join('.') || '(root)'}: ${i.message}`).join('; ');
  return `Error: invalid arguments for ${name}: ${issues}`;
}

/**
 * Make a contract a Tool. The declaration derives from the schema
 * (zodToolParameters: the input side, in lowercase JSON Schema); `execute`
 * validates the model's arguments against the schema and returns an error
 * STRING (never throws) when they do not parse, so the calling model sees
 * what to fix and can retry. Unknown keys are stripped by zod's default
 * object behavior. A long-running tool's description carries
 * LONG_RUNNING_NOTE, as ADK's LongRunningFunctionTool writes it.
 */
export function defineTool<S extends z.ZodType, R = string>(spec: ToolSpec<S, R>): DefinedTool<S, R> {
  const longRunning = spec.longRunning === true;
  let parameters: ToolDeclaration['parameters'] | undefined;
  const tool: DefinedTool<S, R> = {
    // Fields a caller added to the spec ride along, as they did when defineTool returned the spec itself.
    ...(spec as object),
    name: spec.name,
    description: spec.description,
    schema: spec.schema,
    longRunning,
    declaration() {
      parameters ??= zodToolParameters(spec.schema);
      return {
        name: spec.name,
        description: longRunning ? `${spec.description}${LONG_RUNNING_NOTE}` : spec.description,
        // A copy each time, so a caller that edits a declaration edits only its own.
        parameters: structuredClone(parameters),
      };
    },
    async execute(args: unknown, context?: ToolCallContext): Promise<R | string> {
      const parsed = spec.schema.safeParse(args ?? {});
      if (!parsed.success) return invalidArguments(spec.name, parsed.error);
      const result = await spec.execute(parsed.data as z.infer<S>, toToolContext(context));
      return spec.maxResultChars === undefined ? result : (capResult(result, spec.maxResultChars) as R | string);
    },
  };
  Object.defineProperty(tool, DEFINED, { value: true });
  return tool;
}

/** True for a Tool defineTool made (or a copy of one, such as requireApproval's). */
function isDefinedTool(value: unknown): value is DefinedTool {
  return !!value && typeof value === 'object' && (value as Record<PropertyKey, unknown>)[DEFINED] === true;
}

/**
 * `tool` as a Tool: itself when it already is one, else a hand-built
 * contract object made into one with defineTool.
 */
export function asTool(tool: Tool | ToolContract<any>): Tool {
  return isTool(tool) ? tool : defineTool(tool as ToolContract<any>);
}

/**
 * Validate args against the contract's schema and run it. Validation failure
 * returns an error STRING (never throws) so the calling model sees what to
 * fix and can retry — the same convention the hand-written tools used for
 * upstream API failures. A Tool from defineTool validates in its own
 * execute; a hand-built contract object is validated here.
 */
export async function executeContract(
  contract: ToolContract<any>,
  args: unknown,
  context?: ToolCallContext,
): Promise<string> {
  if (isDefinedTool(contract)) return (await contract.execute(args, context)) as string;
  const parsed = contract.schema.safeParse(args ?? {});
  if (!parsed.success) return invalidArguments(contract.name, parsed.error);
  return contract.execute(parsed.data, context);
}

/** The call context from an ADK ToolContext (undefined outside a run). */
export function toolCallContextFrom(toolContext: unknown): ToolCallContext | undefined {
  const inv = (toolContext as { invocationContext?: { userId?: string; appName?: string; session?: { id?: string } } } | undefined)
    ?.invocationContext;
  if (!inv) return undefined;
  return { userId: inv.userId, appName: inv.appName, sessionId: inv.session?.id };
}

/**
 * Standard JSON Schema for the contract's input — the canonical dialect
 * (MCP inputSchema; also what four of our five providers natively accept).
 * The input side: a field with a default is optional.
 */
export function toStandardJsonSchema(contract: ToolContract<any>): Record<string, unknown> {
  return zodInputJsonSchema(contract.schema);
}

/**
 * Standard JSON Schema → Gemini/ADK dialect. The inverse of
 * schemaNormalize.toLowercaseJsonSchema(): every `type` value is UPPERCASED
 * ('object' → 'OBJECT'). Also drops keywords the Gemini API rejects or
 * ignores: an `additionalProperties` that is only `true` or `false`,
 * `default` (defaults are applied by zod at parse time, not by the model),
 * and `propertyNames`, which a live call refused with a 400 ("Unknown name
 * propertyNames", 2026-10-08); a record's keys are strings anyway. A
 * record's value schema (`additionalProperties` holding a schema) is kept:
 * the same live call accepted it and returned the record's arguments.
 * The walk follows schema keywords only, so a property named `type`,
 * `default` or `additionalProperties` is a property like any other, and
 * `enum`, `required` and `const` are data, copied verbatim.
 */
export function toGeminiSchema(jsonSchema: unknown): Record<string, unknown> {
  return (
    mapSchemaNodes(jsonSchema, (node) => {
      delete node.$schema;
      delete node.default;
      delete node.propertyNames;
      if (typeof node.additionalProperties === 'boolean') delete node.additionalProperties;
      if (typeof node.type === 'string') node.type = node.type.toUpperCase();
      else if (Array.isArray(node.type)) node.type = node.type.map((t) => (typeof t === 'string' ? t.toUpperCase() : t));
    }) ?? { type: 'OBJECT', properties: {} }
  );
}

/**
 * MCP surface: a tools/list entry. Pair with executeContract() in the
 * server's CallTool handler — see lib/tools/mcpServe.ts.
 */
export function toMcpToolDefinition(contract: ToolContract<any>): {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
} {
  return {
    name: contract.name,
    description: contract.description,
    inputSchema: toStandardJsonSchema(contract),
  };
}
