/**
 * lib/toolRegistry.ts — single source of truth mapping YAML tool names to
 * live ADK tool instances.
 *
 * WHY this exists:
 *   a2a_server.ts and syndicate_chat.ts each carried an identical `resolveTools`
 *   switch. The two copies had already begun to drift. Centralising the mapping
 *   here means a newly added tool is available to every entrypoint at once.
 *
 * Every client-side tool here is an own Tool (lib/tools/tool.ts), defined
 * once, and the ADK runtime receives the FunctionTool toFunctionTool
 * (lib/tools/adkTool.ts) makes of it; toolOf() reads the Tool back from it.
 * preload_memory is an own InstructionTool, which the ADK runtime receives
 * through toAdkInstructionTool; instructionToolOf() reads it back. The
 * server-side tools are own NativeToolMarkers (lib/tools/nativeTools.ts),
 * which the ADK runtime receives as the sentinels toAdkNativeTool names;
 * nativeToolMarkerOf() reads the NativeTool back from either (ADR 0062).
 */

import { generateImageTool } from './tools/generateImageTool.ts';
import { inspectImageTool } from './tools/inspectImageTool.ts';
import { toAdkInstructionTool, toAdkTool, toFunctionTool } from './tools/adkTool.ts';
import { loadMemoryTool, preloadMemoryTool } from './tools/memoryTools.ts';
import {
  COLLECTIONS_SEARCH_MARKER,
  GOOGLE_SEARCH_MARKER,
  URL_CONTEXT_MARKER,
  WEB_SEARCH_MARKER,
  X_SEARCH_MARKER,
} from './tools/nativeTools.ts';
import { isInstructionTool, isNativeToolMarker, isTool, toolOf } from './tools/tool.ts';
import { webExtractTool } from './tools/webExtractTool.ts';
import { WIKI_AGENT_TOOL_CONTRACTS } from './tools/wikiTools.ts';
import { SCIENCE_TOOL_CONTRACTS } from './tools/scienceTools.ts';
import { TASK_TOOL_CONTRACTS } from './tools/taskTools.ts';
import { askUserTool } from './runtime/questions.ts';
import { xApiSearchTool } from './tools/xApiSearchTool.ts';

// Knowledge-bundle tools, derived from their contracts so the YAML names
// can never drift from the definitions. The agentic composites
// (wiki_query/wiki_garden) are deliberately absent: a syndicate reaches
// that behavior by being an agent WITH these primitives.
const WIKI_TOOLS = Object.fromEntries(
  WIKI_AGENT_TOOL_CONTRACTS.map((contract) => [
    contract.name,
    toFunctionTool(contract),
  ]),
);

// Science tools (lib/tools/scienceTools.ts): read-only literature and
// registry lookups, derived from their contracts the same way, so the YAML
// name IS the contract name. research.yaml declares them.
const SCIENCE_TOOLS = Object.fromEntries(
  SCIENCE_TOOL_CONTRACTS.map((contract) => [contract.name, toFunctionTool(contract)]),
);

// Task list + background-job queue (lib/tools/taskTools.ts): a single-user
// JSON file by default, per-caller lists on Postgres (setTaskBackend). The
// tools only write the queue; scripts/assistant_worker.ts runs the jobs.
// assistant.yaml declares them.
const TASK_TOOLS = Object.fromEntries(
  TASK_TOOL_CONTRACTS.map((contract) => [contract.name, toFunctionTool(contract)]),
);

// The built-in tools. The wiki build reads these keys from this literal.
// A plain object literal inherits from Object.prototype, so a YAML naming
// `constructor` or `toString` resolved to a prototype function instead of
// the unknown-tool warning; TOOL_MAP below is the null-prototype copy.
const BUILTIN_TOOLS: Record<string, unknown> = {
  ...WIKI_TOOLS,
  ...SCIENCE_TOOLS,
  ...TASK_TOOLS,
  // Provider-agnostic web search: routes to the model's NATIVE search
  // (Gemini grounding / Anthropic / OpenAI / xAI); omitted with a warning
  // for local models. Prefer this in new YAMLs.
  web_search: toAdkTool(WEB_SEARCH_MARKER),
  // Deterministic complement to web_search: client-side URL → clean-text
  // reading (keyless — works on every provider, including local Ollama).
  // augustin.yaml and librarian-style research agents declare it.
  web_extract: webExtractTool,
  // Gemini reads URLs in the conversation server-side; a no-op (reported as
  // dropped by the doctor) on other providers. lib/tools/urlContextTool.ts.
  url_context: toAdkTool(URL_CONTEXT_MARKER),
  x_search: toAdkTool(X_SEARCH_MARKER),
  // X API v2 recent search as a client-side contract, photos transcribed
  // inline — runs on every provider; needs X_BEARER_TOKEN in the server env.
  x_api_search: xApiSearchTool,
  // xAI-only: semantic search over hosted Collections (XAI_COLLECTION_IDS).
  collections_search: toAdkTool(COLLECTIONS_SEARCH_MARKER),
  // Gemini-only ADK grounding tool, kept for backward compatibility.
  google_search: toAdkTool(GOOGLE_SEARCH_MARKER),
  generate_image: generateImageTool,
  inspect_image: inspectImageTool,
  // Ask the person mid-turn (lib/runtime/questions.ts): a long-running call
  // that ends the turn input-required; the next message is its answer. Only
  // on an agent the turn runs directly (the schema enforces it).
  ask_user: toFunctionTool(askUserTool),
  // Long-term memory (lib/tools/memoryTools.ts, ADR 0059): explicit recall
  // by query, and recall written into the instruction before each request.
  // Both reach the run's memory service, pinned to the root namespace.
  load_memory: toFunctionTool(loadMemoryTool),
  preload_memory: toAdkInstructionTool(preloadMemoryTool),
};

// Null-prototype copy (as GUARD_MAP is): resolution and registration go
// through this map, never the literal above.
const TOOL_MAP: Record<string, unknown> = Object.assign(Object.create(null), BUILTIN_TOOLS);

/**
 * Resolve an array of tool-name strings to live ADK tool instances.
 * Unknown names are skipped; `onUnknown` (if provided) is invoked for each so
 * callers can log in their own format.
 */
export function resolveTools(
  toolNames: string[] = [],
  onUnknown?: (name: string) => void,
): any[] {
  return toolNames
    .map((name) => {
      const tool = Object.prototype.hasOwnProperty.call(TOOL_MAP, name) ? TOOL_MAP[name] : undefined;
      if (tool === undefined) {
        onUnknown?.(name);
        return null;
      }
      return tool;
    })
    .filter(Boolean);
}

/**
 * Names the framework itself declares, calls or reads on the wire: the
 * approval, credential and input interrupts, the reflection tool, delegation,
 * structured output and task mode. A consumer's tool under one of them would
 * be mistaken for the framework's own (a forged approval request, a fake
 * transfer), so registerTool refuses them. `ask_user` is the framework's
 * question tool; only that tool may be registered under it.
 */
export const RESERVED_TOOL_NAMES: readonly string[] = [
  'adk_request_confirmation',
  'adk_request_credential',
  'adk_request_input',
  'ask_user',
  'adk_handle_model_error',
  'transfer_to_agent',
  'set_model_response',
  'finish_task',
];

/** Whether `tool` is the framework's own ask_user (the own Tool, or the registry's wrapper of it). */
function isFrameworkAskUser(tool: unknown): boolean {
  return tool === askUserTool || tool === TOOL_MAP.ask_user || (!!tool && typeof tool === 'object' && toolOf(tool) === askUserTool);
}

/** The reserved name `name` or `tool` would take, if any. */
function reservedNameOf(name: string, tool: unknown): string | undefined {
  const own = tool && typeof tool === 'object' ? (tool as { name?: unknown }).name : undefined;
  for (const candidate of [name, typeof own === 'string' ? own : undefined]) {
    if (!candidate || !RESERVED_TOOL_NAMES.includes(candidate)) continue;
    if (candidate === 'ask_user' && isFrameworkAskUser(tool)) continue;
    return candidate;
  }
  return undefined;
}

/**
 * Make a tool resolvable by name from a syndicate YAML's `tools:` list.
 *
 * For package consumers: the registry is otherwise closed (YAML can name
 * only what is registered, never load code), and editing this file under
 * node_modules is not an option. Registering is the same deliberate act of
 * exposure as listing a tool above — it happens in your code, where a
 * reviewer reads it. Pass a `defineTool` contract (lib/tools/toolContract.ts),
 * any own Tool, InstructionTool or NativeToolMarker (lib/tools/tool.ts), or
 * a ready ADK tool. A contract or Tool reaches the ADK runtime through
 * toFunctionTool, an InstructionTool through toAdkInstructionTool, a
 * NativeToolMarker as its sentinel (toAdkTool, lib/tools/adkTool.ts).
 * Replacing a built-in requires `{ override: true }`. A reserved framework
 * name (RESERVED_TOOL_NAMES), as the registry name or the tool's own, is
 * refused whatever the options say.
 */
export function registerTool(
  name: string,
  tool: unknown,
  options: { override?: boolean } = {},
): void {
  if (!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(name)) {
    throw new Error(`registerTool: '${name}' is not a valid tool name`);
  }
  const reserved = reservedNameOf(name, tool);
  if (reserved) {
    throw new Error(`registerTool: '${reserved}' is reserved by the framework (${RESERVED_TOOL_NAMES.join(', ')}); register the tool under another name`);
  }
  if (Object.prototype.hasOwnProperty.call(TOOL_MAP, name) && !options.override) {
    throw new Error(`registerTool: '${name}' is already registered (pass { override: true } to replace it)`);
  }
  const t = tool as Record<string, unknown>;
  const isContract = !!t && typeof t === 'object' && 'schema' in t && typeof t.execute === 'function' && !('runAsync' in t);
  TOOL_MAP[name] = isContract || isTool(tool) || isInstructionTool(tool) || isNativeToolMarker(tool)
    ? toAdkTool(tool as any)
    : tool;
}

/** Names a YAML can declare under `tools:` right now. */
export function registeredToolNames(): string[] {
  return Object.keys(TOOL_MAP).sort();
}
