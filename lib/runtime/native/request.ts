/**
 * lib/runtime/native/request.ts — one model request of the native loop,
 * built from an agent and its session (ADR 0045, ADR 0066).
 *
 * WHY this file exists:
 *   The native runtime calls a ModelAdapter (lib/models/contract.ts) with a
 *   ModelRequest it builds itself, with no LlmRequest in between. A session
 *   moves between the runtimes and an agent must behave the same on either,
 *   so the request is the one the ADK runtime hands the same adapter for
 *   the same agent and session: what ADK's LlmAgent request processors and
 *   tools build, read through the shim's mapping (llmRequestToModelRequest,
 *   lib/models/genaiMapping.ts). tests/nativeStep.test.ts asserts that on
 *   whole syndicates.
 *
 * THE REQUEST, in the order ADK builds it:
 *   1. The agent's generateContentConfig, and its output schema when it has
 *      no tools (or the model takes a schema beside tools: Gemini 2 and
 *      later on Vertex AI).
 *   2. The system prompt, each piece joined to the last by a blank line:
 *      - the identity lines ("You are an agent. Your internal name is …"),
 *        unless the agent may transfer to no one (an output schema rules
 *        transfer out);
 *      - the root agent's globalInstruction, then the agent's instruction,
 *        each with `{state_key}` placeholders filled from session state;
 *      - with an output schema beside tools on a model that cannot take
 *        both, the line asking for set_model_response;
 *      - then, at each tool's place in the agent's list, the text its
 *        `instruction(ctx)` writes: few-shot examples, preload_memory, an
 *        own Tool's note (ADR 0059, ADR 0062). The skills index is part of
 *        the instruction itself (lib/compile.ts appends it).
 *   3. The history: the session's events projected by includeContents
 *      (lib/runtime/native/history.ts), with Gemini code execution's parts
 *      as text when the agent runs code.
 *   4. The tools, in the agent's order, a toolset expanded to its tools:
 *      each client-side tool's declaration (contractToolDeclaration), at
 *      most one per name, the later one winning; each server-side tool
 *      where the ADK runtime sends it (web_search everywhere, url_context
 *      and google_search on Gemini, x_search and collections_search on
 *      xAI); `code_execution` first among Gemini's own tools; and the
 *      set_model_response tool when (2) asked for it.
 *   5. Tool choice, the output schema or JSON mode, reasoning and sampling,
 *      read from the config by the mapping's own readers.
 *
 * WHAT IT DOES NOT DO (later tickets): resume an approval or an input
 * request (ADK's confirmation and input processors run tools before the
 * request; WS2-7), compact the history (WS2-8), add transfer_to_agent
 * (compiled syndicates never set subAgents; delegation is WS2-6), task mode
 * and finish_task (WS3-5), workflow placeholders and artifacts in an
 * instruction (no runtime has an artifact service), and an ADK tool's own
 * processLlmRequest side effects beyond its declaration (an own Tool says
 * what it writes through `instruction`).
 *
 * ADK STAYS OUT OF THIS FILE'S OWN LOGIC: it reads tools by marker and by
 * the own-tool symbols (lib/tools/tool.ts), and only lib/models/
 * genaiMapping.ts, which stored history needs anyway (ADR 0048 item 8),
 * names @google/*. An ADK tool or toolset an agent still carries (an
 * AgentTool, an MCP or OpenAPI tool, the skills toolset) is read through
 * its declaration and `getTools`, by shape.
 */

import type { JsonSchema, Message, ModelRequest, NativeTool, ToolDeclaration } from '../../models/contract.ts';
import { contentsToMessages, reasoningOf, samplingOf, systemText, toolChoiceOf } from '../../models/genaiMapping.ts';
import { providerForModel } from '../../models/providerMap.ts';
import { contractToolDeclaration, nativeToolOf, toContractJsonSchema } from '../../models/schemaNormalize.ts';
import type { MemoryService } from '../memoryService.ts';
import type { TurnContent } from '../events.ts';
import type { Session } from '../sessions.ts';
import { createToolContext, instructionToolOf, isTool, toolOf } from '../../tools/tool.ts';
import type { InstructionTool, Tool, ToolContext } from '../../tools/tool.ts';
import { convertCodeExecutionParts, projectHistory } from './history.ts';

// ── The agent ────────────────────────────────────────────────────────────────

/**
 * One agent as the native loop runs it: the fields of a compiled agent that
 * shape its model requests, in the YAML's own spelling. lib/compile.ts
 * builds the same fields into ADK's LlmAgent; the compile split (WS2-10)
 * builds this from the same agent spec.
 */
export interface NativeAgent {
  name: string;
  description?: string;
  /** The model id, as the YAML names it. */
  model: string;
  /**
   * The agent's instruction. A string has `{key}` placeholders filled from
   * session state (`{key?}` is optional); a function's result is used as it is.
   */
  instruction?: string | ((ctx: InstructionContext) => string | Promise<string>);
  /** Prepended to every request of the run's root agent (ADK's global instruction). */
  globalInstruction?: string | ((ctx: InstructionContext) => string | Promise<string>);
  /**
   * In the agent's order: own Tools and defineTool contracts, InstructionTools,
   * NativeToolMarkers, and during the dual period the ADK tools and toolsets
   * an agent may still list (their own-tool symbols are read first).
   */
  tools?: readonly unknown[];
  /** The answer's schema, as the YAML spells it (lowercase or Gemini's dialect). */
  outputSchema?: Record<string, unknown>;
  /** As lib/compile.ts builds it: the YAML's config with `reasoning:` mapped in (withReasoning). */
  generateContentConfig?: Record<string, unknown>;
  includeContents?: 'default' | 'none';
  disallowTransferToParent?: boolean;
  disallowTransferToPeers?: boolean;
  /** `code_execution: gemini`: Gemini runs the code it writes. */
  codeExecution?: 'gemini';
  /** `mode: task` (workflow nodes): not yet run by the native step (WS3-5). */
  mode?: 'task';
}

/** What an instruction function reads. */
export interface InstructionContext {
  readonly agentName: string;
  readonly invocationId: string;
  readonly state: Readonly<Record<string, unknown>>;
  readonly userContent?: TurnContent;
}

/** Where the request is made: the run, its session, and who it is for. */
export interface RequestContext {
  /** The session as it stands: the run's user event already appended. */
  session: Session;
  invocationId: string;
  /** The message that started the run (the examples block reads it). */
  userContent?: TurnContent;
  /** The run's branch; undefined at the root. */
  branch?: string;
  isolationScope?: string;
  /** The run's root agent, whose globalInstruction applies. Default: the agent itself. */
  root?: Pick<NativeAgent, 'globalInstruction'>;
  /** The run's memory, already namespaced: preload_memory and load_memory read it. */
  memory?: Pick<MemoryService, 'search'>;
  /** Stream text and thinking as partial responses. Default false. */
  stream?: boolean;
  /** Aborts the call in flight: the turn's signal. */
  signal?: AbortSignal;
}

/** A request, and the client-side tools it declares by name (what the loop runs and checks for long-running calls). */
export interface BuiltRequest {
  request: ModelRequest;
  /** By declared name, in the request's order: the own Tool when there is one, else the object listed. */
  tools: Map<string, unknown>;
}

// ── set_model_response (ADK's output schema beside tools) ────────────────────

/** The tool ADK adds when an agent has an output schema and tools a model cannot take together. */
export const SET_MODEL_RESPONSE = 'set_model_response';
const SET_MODEL_RESPONSE_DESCRIPTION =
  'Call this tool to submit your final response conforming to the output schema. Use this tool only when you have collected all the information and are ready to return the final answer.';
const SET_MODEL_RESPONSE_INSTRUCTION =
  'To output the final result, you must call the "set_model_response" function with the appropriate values. Do not output anything else.';

/** set_model_response as an own Tool: its answer is the arguments, as JSON text, and it ends the step. */
export function setModelResponseTool(outputSchema: Record<string, unknown>): Tool {
  return {
    name: SET_MODEL_RESPONSE,
    declaration: (): ToolDeclaration => ({
      name: SET_MODEL_RESPONSE,
      description: SET_MODEL_RESPONSE_DESCRIPTION,
      parameters: toContractJsonSchema(outputSchema),
    }),
    execute: async (args, ctx) => {
      ctx.actions.skipSummarization = true;
      return JSON.stringify(args);
    },
  };
}

// ── Model names (ADK's utils/model_name.js and output_schema_utils.js) ───────

/** A Vertex AI resource name's model id, else the id itself. Split, never a backtracking pattern. */
function modelName(model: string): string {
  const parts = model.split('/');
  const isResource =
    parts.length >= 8 &&
    parts[0] === 'projects' &&
    parts[2] === 'locations' &&
    parts[4] === 'publishers' &&
    parts[6] === 'models' &&
    [1, 3, 5].every((i) => (parts[i] ?? '') !== '');
  if (!isResource) return model;
  const rest = parts.slice(7).join('/');
  return rest === '' ? model : rest;
}

function isGeminiModel(model: string): boolean {
  return modelName(model).startsWith('gemini-');
}

function isGemini1Model(model: string): boolean {
  return modelName(model).startsWith('gemini-1');
}

function isGemini2OrAbove(model: string): boolean {
  const name = modelName(model);
  if (!name.startsWith('gemini-')) return false;
  const version = name.slice('gemini-'.length).split('-', 1)[0] ?? '';
  if (!/^\d+(\.\d+)*$/.test(version)) return false;
  return Number.parseInt(version, 10) >= 2;
}

function envFlag(name: string): boolean {
  return ['true', '1'].includes((process.env[name] || '').toLowerCase());
}

/** ADK's enterprise switch: GOOGLE_GENAI_USE_ENTERPRISE, else the deprecated GOOGLE_GENAI_USE_VERTEXAI. */
function vertexAi(): boolean {
  if (process.env.GOOGLE_GENAI_USE_ENTERPRISE !== undefined) return envFlag('GOOGLE_GENAI_USE_ENTERPRISE');
  return envFlag('GOOGLE_GENAI_USE_VERTEXAI');
}

/** Whether the model takes an output schema beside tools in one request (ADK: Vertex AI, Gemini 2 and later). */
export function outputSchemaWithTools(model: string): boolean {
  return vertexAi() && isGemini2OrAbove(model);
}

// ── Session state in an instruction (ADK's injectSessionState) ───────────────

const STATE_PREFIXES = ['app:', 'user:', 'temp:'];
const ARTIFACT_PREFIX = 'artifact.';

function isIdentifier(s: string): boolean {
  return /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(s);
}

function isStateName(name: string): boolean {
  const parts = name.split(':');
  if (parts.length === 1) return isIdentifier(name);
  if (parts.length !== 2) return false;
  return STATE_PREFIXES.includes(`${parts[0]}:`) && isIdentifier(parts[1] as string);
}

/**
 * Every `{…}` placeholder in a template, as ADK's `/\{+[^{}]*}+/g` finds
 * them, by one linear scan (the regular expression backtracks on a long run
 * of braces): a run of `{`, then no brace, then a run of `}`.
 */
function placeholders(template: string): Array<{ raw: string; index: number }> {
  const found: Array<{ raw: string; index: number }> = [];
  let i = 0;
  while (i < template.length) {
    const open = template.indexOf('{', i);
    if (open < 0) break;
    let j = open;
    while (template[j] === '{') j++;
    let k = j;
    while (k < template.length && template[k] !== '{' && template[k] !== '}') k++;
    if (template[k] !== '}') {
      i = k;
      continue;
    }
    let end = k;
    while (template[end] === '}') end++;
    found.push({ raw: template.slice(open, end), index: open });
    i = end;
  }
  return found;
}

function stripBraces(raw: string): string {
  let start = 0;
  let end = raw.length;
  while (start < end && raw[start] === '{') start++;
  while (end > start && raw[end - 1] === '}') end--;
  return raw.slice(start, end).trim();
}

function formatValue(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'object' && value !== null) {
    try {
      const json = JSON.stringify(value);
      if (json !== undefined) return json;
    } catch (e) {
      throw new Error(`Failed to serialize value for instruction template: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return String(value);
}

/**
 * `template` with each `{key}` naming a state key replaced by the value in
 * `state` (a string as it is, anything else as JSON). `{key?}` is optional
 * and becomes empty when the key is absent; a required key that is absent
 * fails, as on the ADK runtime. A placeholder that names no state key
 * (`{ "a": 1 }` in an example) stays as it is. `{artifact.x}` fails: no
 * runtime of this engine has an artifact service. Own keys only: a key such
 * as `constructor` is absent unless the state holds it.
 */
export function injectSessionState(template: string, state: Readonly<Record<string, unknown>>): string {
  const matches = placeholders(template);
  if (matches.length === 0) return template;
  const parsed = matches.map((m) => {
    let key = stripBraces(m.raw);
    const optional = key.endsWith('?');
    if (optional) key = key.slice(0, -1);
    return { ...m, key, optional, valid: key.startsWith(ARTIFACT_PREFIX) || isStateName(key) };
  });
  const required = new Map<string, boolean>();
  for (const p of parsed) if (p.valid) required.set(p.key, (required.get(p.key) ?? false) || !p.optional);
  const values = new Map<string, string>();
  for (const [key, isRequired] of required) {
    if (key.startsWith(ARTIFACT_PREFIX)) throw new Error('Artifact service is not initialized.');
    if (Object.hasOwn(state, key)) values.set(key, formatValue(state[key]));
    else if (!isRequired) values.set(key, '');
    else throw new Error(`Context variable not found: \`${key}\`.`);
  }
  let out = '';
  let last = 0;
  for (const p of parsed) {
    out += template.slice(last, p.index) + (p.valid ? (values.get(p.key) as string) : p.raw);
    last = p.index + p.raw.length;
  }
  return out + template.slice(last);
}

// ── Building the request ─────────────────────────────────────────────────────

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** ADK's appendInstructions: the texts joined by a blank line, after a blank line when there is text already. */
function appendInstructions(system: string | undefined, texts: string[]): string {
  const added = texts.join('\n\n');
  return system ? `${system}\n\n${added}` : added;
}

async function resolveInstruction(
  instruction: NativeAgent['instruction'],
  ctx: InstructionContext,
): Promise<string> {
  if (typeof instruction === 'function') return instruction(ctx);
  return injectSessionState(instruction ?? '', ctx.state);
}

/** A toolset (ADK's skills toolset, an MCP toolset): something that yields tools, and is not one. */
function isToolset(value: unknown): value is { getTools(ctx?: unknown): Promise<unknown[]> } {
  if (!isObject(value)) return false;
  if (typeof value.getTools !== 'function') return false;
  return !('runAsync' in value) && !isTool(value) && typeof value._getDeclaration !== 'function';
}

/** Where the ADK runtime sends each server-side tool for this model (lib/tools/*Tool.ts processLlmRequest). */
type NativePlacement = { in: 'dict' } | { in: 'config'; as: NativeTool } | { in: 'none' };

/**
 * `configTools`: how many entries Gemini's own tool list holds so far (its
 * native tools, and one function-declarations entry per declared tool),
 * which Gemini 1's search refuses to share.
 */
function placementOf(native: NativeTool, model: string, configTools: number): NativePlacement {
  const provider = providerForModel(model);
  switch (native) {
    case 'web_search':
      return provider === 'gemini' ? { in: 'config', as: 'web_search' } : { in: 'dict' };
    case 'x_search':
    case 'collections_search':
      return provider === 'xai' ? { in: 'dict' } : { in: 'none' };
    case 'url_context':
      return provider === 'gemini' ? { in: 'config', as: 'url_context' } : { in: 'none' };
    case 'google_search':
      // ADK's own GoogleSearchTool: Gemini only, and alone on Gemini 1.
      if (isGemini1Model(model)) {
        if (configTools > 0) throw new Error('Google search tool can not be used with other tools in Gemini 1.x.');
        return { in: 'config', as: 'web_search' };
      }
      if (isGeminiModel(model)) return { in: 'config', as: 'web_search' };
      throw new Error(`Google search tool is not supported for model ${model}`);
    case 'code_execution':
      // The agent's code_execution: gemini, never a listed tool.
      return { in: 'none' };
  }
}

/**
 * The ModelRequest the native loop sends for `agent` now, with the
 * client-side tools it declares. Throws where the ADK runtime throws
 * building the same request: a required state key that is absent, a
 * Gemini-only tool on another model, a config field LlmAgent refuses.
 */
export async function buildModelRequest(agent: NativeAgent, ctx: RequestContext): Promise<BuiltRequest> {
  if (agent.mode === 'task') throw new Error(`${agent.name}: mode: task does not run on the native step yet (WS3-5)`);
  const model = agent.model;
  const cfg = { ...(agent.generateContentConfig ?? {}) } as Json;
  // LlmAgent's own refusals, so a config that cannot run under ADK cannot run here.
  if (cfg.tools) throw new Error('All tools must be set via LlmAgent.tools.');
  if (cfg.systemInstruction) throw new Error('System instruction must be set via LlmAgent.instruction.');
  if (cfg.responseSchema) throw new Error('Response schema must be set via LlmAgent.output_schema.');

  const listed = agent.tools ?? [];
  const schemaWithTools = !!agent.outputSchema && listed.length > 0 && !outputSchemaWithTools(model);
  // 1. Basic: the config, and the output schema where the model takes it.
  if (agent.outputSchema && !schemaWithTools) {
    cfg.responseSchema = agent.outputSchema;
    cfg.responseMimeType = 'application/json';
  }

  const state = ctx.session.state;
  const instructionCtx: InstructionContext = {
    agentName: agent.name,
    invocationId: ctx.invocationId,
    state,
    ...(ctx.userContent ? { userContent: ctx.userContent } : {}),
  };

  // 2. Identity, then the root's global instruction, then the agent's own.
  let system: string | undefined;
  const transferDisabled = !!agent.outputSchema || (agent.disallowTransferToParent === true && agent.disallowTransferToPeers === true);
  if (!transferDisabled) {
    const identity = [`You are an agent. Your internal name is "${agent.name}".`];
    if (agent.description) identity.push(`The description about you is "${agent.description}"`);
    system = appendInstructions(system, identity);
  }
  const globalInstruction = (ctx.root ?? agent).globalInstruction;
  if (globalInstruction) system = appendInstructions(system, [await resolveInstruction(globalInstruction, instructionCtx)]);
  if (agent.instruction) system = appendInstructions(system, [await resolveInstruction(agent.instruction, instructionCtx)]);
  if (schemaWithTools) system = appendInstructions(system, [SET_MODEL_RESPONSE_INSTRUCTION]);

  // 3. The history, and Gemini code execution's parts in it.
  const contents = projectHistory(ctx.session.events, {
    agentName: agent.name,
    includeContents: agent.includeContents ?? 'default',
    branch: ctx.branch,
    isolationScope: ctx.isolationScope,
  });
  const configNatives: NativeTool[] = [];
  if (agent.codeExecution === 'gemini') {
    if (!isGemini2OrAbove(model)) throw new Error(`Gemini code execution tool is not supported for model ${model}`);
    configNatives.push('code_execution');
    for (const content of contents) convertCodeExecutionParts(content);
  }

  // 4. The tools, in the agent's order.
  const toolContext: ToolContext = createToolContext({
    invocationId: ctx.invocationId,
    agentName: agent.name,
    userId: ctx.session.userId,
    appName: ctx.session.appName,
    sessionId: ctx.session.id,
    state,
    ...(ctx.signal ? { signal: ctx.signal } : {}),
    ...(ctx.userContent ? { userContent: ctx.userContent } : {}),
    ...(ctx.memory ? { memory: ctx.memory } : {}),
  });
  // What a toolset reads to list its tools (ADK's ReadonlyContext, by shape).
  const toolsetContext = {
    agentName: agent.name,
    invocationId: ctx.invocationId,
    state: { get: (key: string) => state[key], has: (key: string) => Object.hasOwn(state, key) },
  };
  const all: unknown[] = [...listed];
  if (schemaWithTools) all.push(setModelResponseTool(agent.outputSchema as Record<string, unknown>));

  // One entry per name, in first-listed order, the later object winning (ADK's toolsDict).
  const dict = new Map<string, { tool: unknown; declaration?: ToolDeclaration; native?: NativeTool }>();
  const instructionTexts: Array<() => Promise<string | undefined>> = [];
  for (const union of all) {
    const expanded = isToolset(union) ? await union.getTools(toolsetContext) : [union];
    for (const listedTool of expanded) {
      const native = nativeToolOf(listedTool);
      if (native) {
        const declaredSoFar = [...dict.values()].filter((e) => e.declaration).length;
        const placement = placementOf(native, model, configNatives.length + declaredSoFar);
        if (placement.in === 'config') configNatives.push(placement.as);
        else if (placement.in === 'dict') dict.set((listedTool as { name: string }).name, { tool: listedTool, native });
        continue;
      }
      const writer: InstructionTool | undefined = instructionToolOf(listedTool);
      if (writer) {
        instructionTexts.push(() => writer.instruction(toolContext));
        continue;
      }
      const own = toolOf(listedTool);
      const declaration = contractToolDeclaration(own ?? listedTool);
      if (declaration) {
        const key = typeof (listedTool as { name?: unknown }).name === 'string' ? (listedTool as { name: string }).name : declaration.name;
        dict.set(key, { tool: own ?? listedTool, declaration });
      }
      if (own?.instruction) {
        const write = own.instruction.bind(own);
        instructionTexts.push(() => write(toolContext));
      }
    }
  }
  // ADK runs each tool's processLlmRequest in turn; its instruction lands in that order.
  for (const text of instructionTexts) {
    const written = await text();
    if (written) system = appendInstructions(system, [written]);
  }

  // 5. Everything the config says, read as the shim's mapping reads it.
  const { toolChoice, strict } = toolChoiceOf(cfg);
  const tools: ToolDeclaration[] = [];
  const declared = new Map<string, unknown>();
  const nativeTools = new Set<NativeTool>();
  for (const [name, entry] of dict) {
    if (entry.native) nativeTools.add(entry.native);
    if (entry.declaration) {
      tools.push(strict ? { ...entry.declaration, strict } : entry.declaration);
      declared.set(name, entry.tool);
    }
  }
  for (const native of configNatives) nativeTools.add(native);
  const schema = cfg.responseJsonSchema ?? cfg.responseSchema;
  const jsonMode = !isObject(schema) && cfg.responseMimeType === 'application/json';
  const reasoning = reasoningOf(cfg);
  const sampling = samplingOf(cfg);
  const systemPrompt = systemText(system);
  const messages: Message[] = contentsToMessages(contents as Parameters<typeof contentsToMessages>[0]).messages;

  const request: ModelRequest = {
    model,
    ...(systemPrompt !== undefined ? { system: systemPrompt } : {}),
    messages,
    ...(tools.length > 0 ? { tools } : {}),
    ...(nativeTools.size > 0 ? { nativeTools: [...nativeTools] } : {}),
    ...(toolChoice !== undefined ? { toolChoice } : {}),
    ...(isObject(schema) ? { outputSchema: toContractJsonSchema(schema) as JsonSchema } : {}),
    ...(jsonMode ? { outputFormat: 'json' as const } : {}),
    ...(reasoning !== undefined ? { reasoning } : {}),
    ...(sampling ? { sampling } : {}),
    stream: ctx.stream ?? false,
    ...(ctx.signal ? { signal: ctx.signal } : {}),
  };
  return { request, tools: declared };
}
