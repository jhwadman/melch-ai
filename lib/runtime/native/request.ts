/**
 * lib/runtime/native/request.ts — one model request of the native loop,
 * built from an agent and its session (ADR 0045, ADR 0066).
 *
 * WHY this file exists:
 *   The native loop calls a ModelAdapter (lib/models/contract.ts) with a
 *   ModelRequest it builds itself, with no LlmRequest in between. An agent
 *   must behave as it did under ADK, so the request is the one ADK handed
 *   the same adapter for the same agent and session: what ADK's LlmAgent
 *   request processors and tools built, read as genaiMapping reads it
 *   (llmRequestToModelRequest, lib/models/genaiMapping.ts).
 *   tests/nativeStep.test.ts asserts that on whole syndicates.
 *
 * THE REQUEST, in the order ADK built it:
 *   1. The agent's generateContentConfig, and its output schema when it has
 *      no tools, or when every model the step may call (its own and its
 *      fallback_model) takes a schema beside tools in one request: Claude
 *      from Opus 4.8, Sonnet 5 and Haiku 5.5 on, OpenAI, Gemini 2 and later
 *      on Vertex AI (outputSchemaBesideTools, lib/models/capabilities.ts,
 *      ADR 0109). That is how an orchestrator that delegates answers in a
 *      schema without a set_model_response call.
 *   2. The system prompt, each piece joined to the last by a blank line:
 *      - the identity lines ("You are an agent. Your internal name is …"),
 *        unless the agent may transfer to no one (an output schema rules
 *        transfer out);
 *      - the root agent's globalInstruction, then the agent's instruction,
 *        each with `{state_key}` placeholders filled from session state,
 *        and, in a workflow node's run, `{input.field}` and
 *        `<input.field from Node>` filled from its workflow scope;
 *      - with an output schema beside tools on a model that cannot take
 *        both, the line asking for set_model_response;
 *      - then, at each tool's place in the agent's list, the text its
 *        `instruction(ctx)` writes: few-shot examples, preload_memory, an
 *        own Tool's note (ADR 0059, ADR 0062). The skills index is part of
 *        the instruction itself (lib/compile.ts appends it).
 *      A Tool's `contents` hook then adds to the history, after it is
 *      projected (load_skill_resource's binary file, ADR 0083).
 *   3. The history: the session's events projected by includeContents
 *      (lib/runtime/native/history.ts), with Gemini code execution's parts
 *      as text when the agent runs code.
 *   4. The tools, in the agent's order, a toolset expanded to its tools:
 *      each client-side tool's declaration (contractToolDeclaration), at
 *      most one per name, the later one winning; each server-side tool
 *      where ADK sent it (web_search everywhere, url_context
 *      and google_search on Gemini, x_search and collections_search on
 *      xAI); `code_execution` first among Gemini's own tools; and the
 *      set_model_response tool when (2) asked for it, then the caller's
 *      `extraTools` (self-correction's reflection tool, as ADK's plugin adds
 *      it to the toolsDict last, when the step declares it: ADR 0097). In `mode: task`, finish_task takes
 *      set_model_response's place and the output schema is never the
 *      response schema (lib/runtime/native/taskMode.ts).
 *   5. Tool choice, the output schema or JSON mode, reasoning and sampling,
 *      read from the config by genaiMapping's own readers.
 *
 * WHAT IT DOES NOT DO (later tickets): resume an approval or an input
 * request (ADK's confirmation and input processors run tools before the
 * request; WS2-7), add transfer_to_agent
 * (compiled syndicates never set subAgents; they delegate through subagent tools, delegate.ts),
 * artifacts in an
 * instruction (the engine has no artifact service), and an ADK-shaped tool's own
 * processLlmRequest side effects beyond its declaration (an own Tool says
 * what it writes through `instruction`).
 *
 * ADK STAYS OUT OF THIS FILE'S OWN LOGIC: it reads tools by marker and by
 * shape (lib/tools/tool.ts), and only lib/models/genaiMapping.ts, which
 * stored history needs anyway (ADR 0048 item 8), names @google/*. A toolset
 * is expanded through `getTools`, by shape, as is the engine's own skills
 * toolset. An ADK tool (anything with runAsync) reaching the request, listed,
 * yielded by a toolset or passed in `extraTools`, is refused, naming 1.0.0
 * and defineTool, as registerTool refuses one (ADR 0107).
 */

import type { JsonSchema, Message, ModelRequest, NativeTool, ToolDeclaration } from '../../models/contract.ts';
import { contentsToMessages, reasoningOf, samplingOf, systemText, toolChoiceOf } from '../../models/genaiMapping.ts';
import { outputSchemaBesideTools } from '../../models/capabilities.ts';
import { providerForModel } from '../../models/providerMap.ts';
import { contractToolDeclaration, nativeToolOf, toContractJsonSchema } from '../../models/schemaNormalize.ts';
import type { MemoryService } from '../memoryService.ts';
import type { TurnContent, TurnEvent } from '../events.ts';
import type { Session } from '../sessions.ts';
import { createToolContext, instructionToolOf, isTool, toolOf } from '../../tools/tool.ts';
import type { InstructionTool, Tool, ToolContext } from '../../tools/tool.ts';
import type { ContextConfig } from './compaction.ts';
import { convertCodeExecutionParts, projectHistory } from './history.ts';
import { finishTaskTool } from './taskMode.ts';
import { withStateOverlay } from './tempState.ts';

// ── The agent ────────────────────────────────────────────────────────────────

/**
 * One agent as the native loop runs it: the fields of a compiled agent that
 * shape its model requests, in the YAML's own spelling. lib/compile.ts
 * builds the same fields into ADK's LlmAgent, and lib/compileNative.ts
 * builds this from the same AgentSpec (ADR 0073).
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
   * NativeToolMarkers, and any other object an outside caller lists (its
   * own-tool symbol is read first).
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
  /** `mode: task` (workflow nodes): finish_task is declared after the agent's tools and the output schema is its parameters (lib/runtime/native/taskMode.ts). */
  mode?: 'task';
  /** The session-state key the agent's final answer is saved under (the loop writes it, lib/runtime/native/agentLoop.ts). */
  outputKey?: string;
  /** `fallback_model:`: answers a provider-side failure of the agent's model (ADR 0044). The loop calls it as its own leaf adapter. */
  fallbackModel?: string;
  /** `context:` (ADR 0033): compact the history into a summary past a token threshold. The loop runs it before each step (compaction.ts). */
  context?: ContextConfig;
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
  /**
   * State laid over the session's for this request: the run's `temp:` keys,
   * which no store keeps (lib/runtime/native/tempState.ts).
   */
  stateOverlay?: Readonly<Record<string, unknown>>;
  /** Aborts the call in flight: the turn's signal. */
  signal?: AbortSignal;
  /**
   * Tools declared after the agent's own, as a plugin's beforeModelCallback
   * adds them to ADK's toolsDict last: self-correction's reflection tool
   * (lib/runtime/native/selfCorrection.ts).
   */
  extraTools?: readonly unknown[];
  /**
   * A workflow agent node's run: the node's input and the outputs stored so
   * far, which fill the instruction's workflow placeholders as ADK's
   * workflowInstructionScope does (lib/workflow/agentNode.ts).
   */
  workflowScope?: WorkflowInstructionScope;
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

/**
 * ADK's rule for whether the model takes an output schema beside tools in one
 * request (Vertex AI, Gemini 2 and later). `mode: task` keeps it as it is,
 * for the instruction line ADK's processor writes there.
 */
export function outputSchemaWithTools(model: string): boolean {
  return vertexAi() && isGemini2OrAbove(model);
}

/**
 * Whether the agent's output schema travels beside its tools as the
 * provider's own structured-output field (ADR 0109): on every model the step
 * may call, its own and its fallback_model, since a fallback answers the same
 * request. ADK's Gemini rule still holds; the capability matrix's
 * `structured_output_with_tools` adds Claude's current generations and
 * OpenAI. Anywhere else the schema is the set_model_response tool.
 */
function schemaBesideTools(agent: Pick<NativeAgent, 'model' | 'fallbackModel'>): boolean {
  const models = agent.fallbackModel ? [agent.model, agent.fallbackModel] : [agent.model];
  return models.every((m) => outputSchemaWithTools(m) || outputSchemaBesideTools(m));
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

// ── Workflow placeholders (ADK 2.2's workflowInstructionScope) ───────────────

/**
 * What ADK's runLlmAgentAsNode puts in a node agent's invocation context
 * (`withWorkflowInstructionScope`): the node's input, and the output each
 * node of the invocation stored so far, by node name, the last one winning.
 * Its instruction then fills `{<any>.<field>}` from the input and
 * `<<any>.<field> from <Node>>` from that node's output.
 */
export interface WorkflowInstructionScope {
  readonly input: unknown;
  readonly outputsByNode: Readonly<Record<string, unknown>>;
}

const isWordChar = (c: string | undefined): boolean => c !== undefined && ((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c === '_');
const isIdentStart = (c: string | undefined): boolean => c !== undefined && c !== '' && isWordChar(c) && !(c >= '0' && c <= '9');
const isSpace = (c: string | undefined): boolean => c !== undefined && c !== '' && /\s/.test(c);

/** ADK's WORKFLOW_FIELD_KEY, `^[A-Za-z_]\w*\.[A-Za-z_]\w*$`, without a pattern: two identifiers joined by one dot. */
function isWorkflowFieldKey(key: string): boolean {
  const dot = key.indexOf('.');
  return dot > 0 && isIdentifier(key.slice(0, dot)) && isIdentifier(key.slice(dot + 1));
}

/** The identifier `[A-Za-z_]\w*` starting at `i`, and where it ends; undefined when none starts there. */
function identAt(s: string, i: number): { name: string; end: number } | undefined {
  if (!isIdentStart(s[i])) return undefined;
  let end = i + 1;
  while (isWordChar(s[end])) end++;
  return { name: s.slice(i, end), end };
}

function skipSpaces(s: string, i: number): number {
  while (isSpace(s[i])) i++;
  return i;
}

/**
 * Every `<x.field from Node>` placeholder, as ADK's SOURCE_NODE_PLACEHOLDER,
 * `/<\s*[A-Za-z_]\w*\.([A-Za-z_]\w*)\s+from\s+([A-Za-z_]\w*)\s*>/g`, finds
 * them. Each token of that pattern is determined by the next character, so
 * a hand parser takes the same matches; an attempt from a `<` cannot pass
 * the next `<`, so the scan is linear.
 */
function sourcePlaceholders(template: string): Array<{ raw: string; index: number; field: string; node: string }> {
  const found: Array<{ raw: string; index: number; field: string; node: string }> = [];
  let open = template.indexOf('<');
  while (open >= 0) {
    const match = sourcePlaceholderAt(template, open);
    if (match) found.push(match);
    open = template.indexOf('<', match ? match.index + match.raw.length : open + 1);
  }
  return found;
}

function sourcePlaceholderAt(s: string, open: number): { raw: string; index: number; field: string; node: string } | undefined {
  const head = identAt(s, skipSpaces(s, open + 1));
  if (!head || s[head.end] !== '.') return undefined;
  const field = identAt(s, head.end + 1);
  if (!field || !isSpace(s[field.end])) return undefined;
  const from = skipSpaces(s, field.end);
  if (s.slice(from, from + 4) !== 'from' || !isSpace(s[from + 4])) return undefined;
  const node = identAt(s, skipSpaces(s, from + 4));
  if (!node) return undefined;
  const close = skipSpaces(s, node.end);
  if (s[close] !== '>') return undefined;
  return { raw: s.slice(open, close + 1), index: open, field: field.name, node: node.name };
}

/** ADK's resolveSourceNode: the field of the named node's object output, else the placeholder as written. */
function resolveSourceNode(raw: string, field: string, node: string, scope: WorkflowInstructionScope): string {
  const out = (scope.outputsByNode as Record<string, unknown>)[node];
  if (out && typeof out === 'object' && field in out) return formatValue((out as Record<string, unknown>)[field]);
  return raw;
}

/**
 * ADK's collectPredecessorOutputs: the output every event of the invocation
 * carries, keyed by the last segment of its node path without the run
 * suffix (`Graph.Fan.Agent@2` is `Agent`), the later event winning.
 */
export function predecessorOutputs(events: readonly TurnEvent[], invocationId: string): Record<string, unknown> {
  const outputs: Record<string, unknown> = {};
  for (const event of events) {
    if (event.invocationId !== invocationId || event.output === undefined) continue;
    const path = event.nodeInfo?.path;
    if (!path) continue;
    const leaf = path.slice(path.lastIndexOf('.') + 1);
    const at = leaf.indexOf('@');
    outputs[at >= 0 ? leaf.slice(0, at) : leaf] = event.output;
  }
  return outputs;
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
 * fails, as it did under ADK. A placeholder that names no state key
 * (`{ "a": 1 }` in an example) stays as it is. `{artifact.x}` fails: the
 * engine has no artifact service. Own keys only: a key such
 * as `constructor` is absent unless the state holds it.
 *
 * With a workflow `scope` (a workflow agent node's run), ADK 2.2's two
 * workflow placeholders are filled too, as its injectSessionState fills
 * them: `{x.field}` (any identifier before the dot) from the node's input
 * when it is an object holding `field`, `''` when optional and absent, else
 * left as written (the key's first spelling); and `<x.field from Node>`
 * from that node's stored object output, else left as written.
 */
export function injectSessionState(template: string, state: Readonly<Record<string, unknown>>, scope?: WorkflowInstructionScope): string {
  const sources = scope ? sourcePlaceholders(template).map((m) => ({ raw: m.raw, index: m.index, text: resolveSourceNode(m.raw, m.field, m.node, scope) })) : [];
  const matches = placeholders(template);
  if (matches.length === 0 && sources.length === 0) return template;
  const parsed = matches.map((m) => {
    let key = stripBraces(m.raw);
    const optional = key.endsWith('?');
    if (optional) key = key.slice(0, -1);
    return { ...m, key, optional, valid: key.startsWith(ARTIFACT_PREFIX) || isStateName(key) || (!!scope && isWorkflowFieldKey(key)) };
  });
  const unique = new Map<string, { required: boolean; raw: string }>();
  for (const p of parsed) {
    if (!p.valid) continue;
    const seen = unique.get(p.key);
    if (seen) seen.required ||= !p.optional;
    else unique.set(p.key, { required: !p.optional, raw: p.raw });
  }
  const values = new Map<string, string>();
  for (const [key, { required, raw }] of unique) values.set(key, resolveKey(key, required, raw, state, scope));
  // ADK's merge: both kinds in template order, each replaced in turn.
  const all = [...parsed.map((p) => ({ raw: p.raw, index: p.index, text: p.valid ? (values.get(p.key) as string) : p.raw })), ...sources].sort((a, b) => a.index - b.index);
  let out = '';
  let last = 0;
  for (const p of all) {
    out += template.slice(last, p.index) + p.text;
    last = p.index + p.raw.length;
  }
  return out + template.slice(last);
}

/** ADK's resolveKey for one placeholder key: an artifact (refused), a state key, or a workflow field. */
function resolveKey(key: string, required: boolean, raw: string, state: Readonly<Record<string, unknown>>, scope: WorkflowInstructionScope | undefined): string {
  if (key.startsWith(ARTIFACT_PREFIX)) throw new Error('Artifact service is not initialized.');
  if (isStateName(key)) {
    if (Object.hasOwn(state, key)) return formatValue(state[key]);
    if (!required) return '';
    throw new Error(`Context variable not found: \`${key}\`.`);
  }
  if (scope && isWorkflowFieldKey(key)) {
    const field = key.slice(key.indexOf('.') + 1);
    const input = scope.input;
    if (input && typeof input === 'object' && field in input) return formatValue((input as Record<string, unknown>)[field]);
    if (!required) return '';
  }
  return raw;
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
  scope?: WorkflowInstructionScope,
): Promise<string> {
  if (typeof instruction === 'function') return instruction(ctx);
  return injectSessionState(instruction ?? '', ctx.state, scope);
}

/** An ADK tool (anything with runAsync), read by shape: the engine refuses it. */
function isAdkTool(tool: unknown): boolean {
  return isObject(tool) && 'runAsync' in tool;
}

/** The error an ADK tool reaching a model request throws, as registerTool's refusal words it. */
function adkToolRefused(tool: unknown): Error {
  const name = String((tool as { name?: unknown }).name ?? '<unnamed>');
  return new Error(`model request: '${name}' is an ADK tool, which melchizedek-agents 1.0.0 no longer runs (ADR 0107); define it with defineTool (melchizedek-agents) instead`);
}

/** A toolset (the skills harness, an MCP toolset): something that yields tools, and is not one. */
export function isToolset(value: unknown): value is { getTools(ctx?: unknown): Promise<unknown[]> } {
  if (!isObject(value)) return false;
  if (typeof value.getTools !== 'function') return false;
  return !('runAsync' in value) && !isTool(value) && typeof value._getDeclaration !== 'function';
}

/** Where each server-side tool goes for this model, as ADK's tools placed it in their processLlmRequest. */
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
 * client-side tools it declares. Throws where ADK threw building the same
 * request: a required state key that is absent, a
 * Gemini-only tool on another model, a config field LlmAgent refuses.
 */
export async function buildModelRequest(agent: NativeAgent, ctx: RequestContext): Promise<BuiltRequest> {
  const model = agent.model;
  const cfg = { ...(agent.generateContentConfig ?? {}) } as Json;
  // LlmAgent's own refusals, so a config that cannot run under ADK cannot run here.
  if (cfg.tools) throw new Error('All tools must be set via LlmAgent.tools.');
  if (cfg.systemInstruction) throw new Error('System instruction must be set via LlmAgent.instruction.');
  if (cfg.responseSchema) throw new Error('Response schema must be set via LlmAgent.output_schema.');

  const listed = agent.tools ?? [];
  const taskMode = agent.mode === 'task';
  // An output schema beside tools: set_model_response unless the step's models take both in one request
  // (ADR 0109). Task mode keeps ADK's rule: finish_task carries the schema there.
  const besideTools = !!agent.outputSchema && listed.length > 0;
  const schemaWithTools = besideTools && !(taskMode ? outputSchemaWithTools(model) : schemaBesideTools(agent));
  // 1. Basic: the config, and the output schema where the model takes it (never in task mode: finish_task carries it).
  if (agent.outputSchema && !schemaWithTools && !taskMode) {
    cfg.responseSchema = agent.outputSchema;
    cfg.responseMimeType = 'application/json';
  }

  const state = withStateOverlay(ctx.session.state, ctx.stateOverlay);
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
  if (globalInstruction) system = appendInstructions(system, [await resolveInstruction(globalInstruction, instructionCtx, ctx.workflowScope)]);
  if (agent.instruction) system = appendInstructions(system, [await resolveInstruction(agent.instruction, instructionCtx, ctx.workflowScope)]);
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
  // Task mode (lib/runtime/native/taskMode.ts): finish_task in set_model_response's place. ADK's
  // instruction processor still writes the set_model_response line above; LlmAgent adds no such tool.
  if (taskMode) all.push(finishTaskTool(agent.outputSchema));
  else if (schemaWithTools) all.push(setModelResponseTool(agent.outputSchema as Record<string, unknown>));
  if (ctx.extraTools) all.push(...ctx.extraTools);

  // One entry per name, in first-listed order, the later object winning (ADK's toolsDict).
  const dict = new Map<string, { tool: unknown; declaration?: ToolDeclaration; native?: NativeTool }>();
  const instructionTexts: Array<() => Promise<string | undefined>> = [];
  const contentWriters: Array<() => Promise<void>> = [];
  for (const union of all) {
    const expanded = isToolset(union) ? await union.getTools(toolsetContext) : [union];
    for (const listedTool of expanded) {
      if (isAdkTool(listedTool)) throw adkToolRefused(listedTool);
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
      if (own?.contents) {
        const add = own.contents.bind(own);
        contentWriters.push(() => add(contents, toolContext));
      }
    }
  }
  // As ADK ran each tool's processLlmRequest in turn, each instruction lands in that order.
  for (const text of instructionTexts) {
    const written = await text();
    if (written) system = appendInstructions(system, [written]);
  }
  // ...and what it adds to the history (load_skill_resource's binary file, ADR 0083), after the history.
  for (const write of contentWriters) await write();

  // 5. Everything the config says, read as genaiMapping reads it.
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
