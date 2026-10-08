/**
 * lib/models/genaiMapping.ts — @google/genai `Content`, and ADK's LlmRequest
 * and LlmResponse, to and from the engine's model contract
 * (lib/models/contract.ts, ADR 0048).
 *
 * WHY this file exists:
 *   The ADK runtime holds and stores @google/genai `Content`: the history of
 *   an LlmRequest, and the `content` of every stored event. The native
 *   runtime and every adapter on the contract speak `Message` and `Part`.
 *   This module converts between the two, so the native runtime can read a
 *   session ADK stored, and an adapter can move onto the contract while ADK
 *   still runs: its ADK class maps the LlmRequest in and each ModelResponse
 *   out. It is pure (no I/O, clock or randomness) and never mutates its
 *   input; leaf values (args, results, payloads) are shared, not copied.
 *   The contract stays a leaf: only this module names @google/*.
 *   wiki/models/model-contract.md ("From genai Content") is the spec.
 *
 * LOSSLESS FOR STORED CONTENT. Content → contract → Content gives back the
 * same JSON, keys aside (both event tables are jsonb, which keeps no key
 * order), for every part kind. tests/genaiMapping.test.ts runs every stored
 * session fixture through it.
 *
 *   Roles. `model` → assistant, `system` → system, a `user` content made
 *   only of functionResponse parts → tool, any other `user` content → user.
 *   Back: assistant → `model`, system → `system`, user and tool → `user`.
 *   A content with no role reads as user and comes back as `user`. A user
 *   content that mixes results with other parts is a user message, its
 *   results described as text (below), because a ToolMessage holds only
 *   results; the calls they answered are then left unanswered there. The
 *   engine's surfaces send an approval or an answer as a part of its own.
 *
 *   Parts. Each genai part becomes one contract part:
 *     { text }                       ↔ TextPart
 *     { text, thought: true }        ↔ ThinkingPart
 *     { functionCall: {name,args,id} } ↔ ToolCallPart
 *     { functionResponse: {id,name,response} } ↔ ToolResultPart
 *     { inlineData: {mimeType,data} } ↔ BlobPart with data
 *     { fileData: {mimeType,fileUri} } ↔ BlobPart with url
 *   A part's `thoughtSignature` ↔ providerState { provider: 'gemini', kind:
 *   'thought_signature', payload: <signature> } on the same part, and any
 *   providerState another adapter wrote passes through unchanged.
 *
 *   Everything else is carried whole. A part the contract cannot hold
 *   exactly (Gemini code execution, a field such as `videoMetadata` or
 *   `displayName`, a call with no `args`, a signature beside another
 *   provider's state) or cannot place in its message (a functionCall in a
 *   `user` content, as ADK writes `adk_request_confirmation`) keeps the
 *   original genai part as providerState { provider: 'gemini', kind:
 *   'genai_part', payload: <the part> }, on the nearest part the message
 *   allows: a functionCall or functionResponse as itself where it may stand,
 *   else as text describing it; `executableCode` as its code in a fenced
 *   block; `codeExecutionResult` as its output; anything unknown as empty
 *   text. Back, that state is the genai part, verbatim. So only the Gemini
 *   adapter (provider `gemini`) replays it, and every other adapter sees
 *   the projection.
 *
 *   Tool results. `response` is the result when it is an object; a response
 *   of exactly `{ result: <not an object> }` is that value; exactly
 *   `{ error: <not null or false> }` is that value with `isError: true` (a
 *   tool ADK caught throwing). Back: `{ error: result }` for an error, the
 *   result when it is an object, else `{ result }`. A tool's successful
 *   object result shaped `{ error }` therefore reads back as an error: the
 *   genai bytes cannot tell the two apart.
 *
 *   Ids. A ToolCallPart always has an id. A genai call without one (Gemini
 *   returns none, and ADK strips its own `adk-` ids from every request) gets
 *   `genai-noid-<content>-<part>`, from its position, and a result without
 *   one takes the id of the latest open minted call of the same name, else
 *   one of its own (it then answers no call in the history). Back, a minted
 *   id is left off again, so the round trip restores the absence. Stored
 *   events keep the ids ADK assigned, which pass through as they are.
 *
 * THE REQUEST (llmRequestToModelRequest). The system instruction's text;
 * the contents as above; client tools from `toolsDict` through
 * contractToolDeclaration (lib/models/schemaNormalize.ts), which converts
 * Gemini's dialect once; native tools from the toolsDict entries
 * nativeToolOf names (the web_search, x_search and collections_search
 * sentinels) and from Gemini's `config.tools` entries (`googleSearch` and
 * `googleSearchRetrieval` → web_search, `urlContext`, `codeExecution`);
 * `responseJsonSchema` or `responseSchema` as a lowercase outputSchema; the
 * function-calling mode as toolChoice (`VALIDATED` as strict tools); the
 * reasoning fields as a ReasoningSetting where it is exact (reasoningOf);
 * sampling; stream; the abort signal. Not mapped: tool options inside a
 * `config.tools` entry, any other `config.tools` entry, `includeThoughts`,
 * and the generateContentConfig fields the contract leaves out (topK, seed,
 * penalties, safetySettings, JSON mode without a schema).
 *
 * THE RESPONSE (modelResponseToLlmResponse). Parts back to a `model`
 * content; a partial as `partial: true`, the final with `turnComplete:
 * true`; usage in Gemini's meanings (usageToMetadata); error as `errorCode`
 * and `errorMessage`, key-shaped text scrubbed, with `retryable` and
 * `status` as customMetadata['error.retryable'] and ['error.status']
 * (withRetryVerdict, lib/models/errorResponse.ts), the only place
 * FallbackLlm reads whether a fallback may answer; finishReason as
 * Gemini's; grounding as the `webSearchQueries` and
 * `groundingChunks[].web` that lib/grounding.ts reads. Not carried, since
 * an LlmResponse has no field for them: `cacheWriteTokens`, a citation's
 * span and cited text, and which native tool ran a query.
 *
 * USAGE MEANINGS. usageToMetadata and usageFromMetadata use Gemini's: its
 * `candidatesTokenCount` excludes the thinking in `thoughtsTokenCount`. The
 * ADK-path GPT and chat-completions adapters write `candidatesTokenCount`
 * with reasoning included, so usageFromMetadata on an event they stored
 * counts that reasoning twice in `outputTokens`.
 */

import { FinishReason } from '@google/genai';
import type { Content, ContentUnion, GenerateContentConfig, GenerateContentResponseUsageMetadata, GroundingMetadata, Part as GenaiPart } from '@google/genai';
import type { LlmRequest, LlmResponse } from '@google/adk';

import type {
  FinishReason as ContractFinishReason,
  Grounding,
  Message,
  ModelRequest,
  ModelResponse,
  NativeTool,
  Part,
  ProviderState,
  ReasoningLevel,
  ReasoningSetting,
  Role,
  Sampling,
  ToolChoice,
  ToolDeclaration,
  Usage,
} from './contract.ts';
import { withRetryVerdict } from './errorResponse.ts';
import { contractToolDeclaration, nativeToolOf, toContractJsonSchema } from './schemaNormalize.ts';

/** The provider id the mapping writes its own state under: only the Gemini adapter replays it. */
export const GEMINI_PROVIDER = 'gemini';
/** providerState kind for a Gemini `thoughtSignature`; the payload is the signature. */
export const THOUGHT_SIGNATURE_KIND = 'thought_signature';
/** providerState kind for a genai part the contract cannot hold exactly; the payload is the part. */
export const GENAI_PART_KIND = 'genai_part';
/** The prefix of an id the mapping made for a call or result that had none. */
export const MINTED_CALL_ID_PREFIX = 'genai-noid-';

/** A conversation as the contract holds it: the system prompt and the messages. */
export interface ContractHistory {
  system?: string;
  messages: Message[];
}

/** The same conversation as genai holds it. */
export interface GenaiHistory {
  systemInstruction?: string;
  contents: Content[];
}

type Json = Record<string, unknown>;
type PartType = Part['type'];

const ALLOWED: Record<Role, ReadonlySet<PartType>> = {
  system: new Set<PartType>(['text']),
  user: new Set<PartType>(['text', 'blob']),
  assistant: new Set<PartType>(['text', 'thinking', 'toolCall', 'blob']),
  tool: new Set<PartType>(['toolResult']),
};

const GENAI_ROLE: Record<Role, string> = { system: 'system', user: 'user', assistant: 'model', tool: 'user' };

function isObject(value: unknown): value is Json {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** The keys that carry a value: JSON drops undefined, so the mapping does too. */
function keysOf(o: Json): string[] {
  return Object.keys(o).filter((k) => o[k] !== undefined);
}

function hasOnly(o: Json, allowed: readonly string[]): boolean {
  return keysOf(o).every((k) => allowed.includes(k));
}

export function isMintedCallId(id: unknown): boolean {
  return typeof id === 'string' && id.startsWith(MINTED_CALL_ID_PREFIX);
}

/** An id that may pass through as it is: absent, or a string the mapping did not make. */
function isOwnId(id: unknown): id is string | undefined {
  return id === undefined || (typeof id === 'string' && !isMintedCallId(id));
}

function json(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

// ── Genai → contract ─────────────────────────────────────────────────────────

/** A minted call still waiting for its result. */
interface OpenCall {
  name: string;
  id: string;
  content: number;
}

interface Projection {
  part: Part;
  /** The contract part, with the state the caller adds, gives back the genai part byte for byte. */
  exact: boolean;
  /** The genai call or result had no id of its own: one is assigned once the part's place is known. */
  needsId?: boolean;
}

function slotOf(content: Content): Role {
  if (content.role === 'model') return 'assistant';
  if (content.role === 'system') return 'system';
  const parts = content.parts ?? [];
  if (content.role === 'user' && parts.length > 0 && parts.every((p) => isObject(p) && isObject((p as Json).functionResponse))) {
    return 'tool';
  }
  return 'user';
}

/** A response as a result: see the header for the rule and its one ambiguity. */
function resultOf(response: Json): { result: unknown; isError?: true } {
  const keys = keysOf(response);
  if (keys.length === 1 && keys[0] === 'error' && response.error !== null && response.error !== false) {
    return { result: response.error, isError: true };
  }
  if (keys.length === 1 && keys[0] === 'result' && !isObject(response.result)) return { result: response.result };
  return { result: response };
}

/** The genai part's own data, without its signature and state, as the nearest contract part. */
function project(rest: Json): Projection {
  const { functionResponse: fr, functionCall: fc, inlineData: inline, fileData: file, text, thought } = rest;
  const keys = keysOf(rest);
  const only = (key: string) => keys.length === 1 && keys[0] === key;
  const textual = (exact: boolean): Projection => ({
    part: thought === true ? { type: 'thinking', text: text as string } : { type: 'text', text: text as string },
    exact,
  });

  // Text alone is exact; text beside a call, a result or a blob ranks below them.
  if (typeof text === 'string' && hasOnly(rest, ['text', 'thought']) && (thought === undefined || thought === true)) return textual(true);
  if (isObject(fr)) {
    const exact =
      only('functionResponse') && hasOnly(fr, ['id', 'name', 'response']) && typeof fr.name === 'string' && isObject(fr.response) && isOwnId(fr.id);
    const r = isObject(fr.response) ? resultOf(fr.response) : { result: fr.response ?? null };
    const id = typeof fr.id === 'string' && !isMintedCallId(fr.id) ? fr.id : undefined;
    return {
      part: { type: 'toolResult', id: id ?? '', name: typeof fr.name === 'string' ? fr.name : '', ...r },
      exact,
      needsId: id === undefined,
    };
  }
  if (isObject(fc)) {
    const exact = only('functionCall') && hasOnly(fc, ['name', 'args', 'id']) && typeof fc.name === 'string' && isObject(fc.args) && isOwnId(fc.id);
    const id = typeof fc.id === 'string' && !isMintedCallId(fc.id) ? fc.id : undefined;
    return {
      part: { type: 'toolCall', id: id ?? '', name: typeof fc.name === 'string' ? fc.name : '', args: isObject(fc.args) ? fc.args : {} },
      exact,
      needsId: id === undefined,
    };
  }
  if (isObject(inline) && typeof inline.data === 'string') {
    const exact = only('inlineData') && hasOnly(inline, ['mimeType', 'data']) && typeof inline.mimeType === 'string';
    const mimeType = typeof inline.mimeType === 'string' ? inline.mimeType : 'application/octet-stream';
    return { part: { type: 'blob', mimeType, data: inline.data }, exact };
  }
  if (isObject(file) && typeof file.fileUri === 'string') {
    const exact = only('fileData') && hasOnly(file, ['mimeType', 'fileUri']) && typeof file.mimeType === 'string';
    const mimeType = typeof file.mimeType === 'string' ? file.mimeType : 'application/octet-stream';
    return { part: { type: 'blob', mimeType, url: file.fileUri }, exact };
  }
  if (typeof text === 'string') return textual(false);
  if (isObject(rest.executableCode)) {
    const { code, language } = rest.executableCode;
    const lang = typeof language === 'string' && language !== 'LANGUAGE_UNSPECIFIED' ? language.toLowerCase() : '';
    return { part: { type: 'text', text: `\`\`\`${lang}\n${typeof code === 'string' ? code : ''}\n\`\`\`` }, exact: false };
  }
  if (isObject(rest.codeExecutionResult)) {
    const { outcome, output } = rest.codeExecutionResult;
    const failed = typeof outcome === 'string' && outcome !== 'OUTCOME_OK' ? ` (${outcome})` : '';
    return { part: { type: 'text', text: `Output${failed}:\n${typeof output === 'string' ? output : ''}` }, exact: false };
  }
  return { part: { type: 'text', text: '' }, exact: false };
}

/** Text standing in for a part its message cannot hold. */
function describe(part: Part): string {
  switch (part.type) {
    case 'text':
    case 'thinking':
      return part.text;
    case 'toolCall':
      return `[${part.name} called with ${json(part.args)}]`;
    case 'toolResult':
      return `[${part.name} ${part.isError ? 'failed' : 'returned'} ${json(part.result)}]`;
    case 'blob':
      return `[${part.mimeType}${part.url !== undefined ? ` ${part.url}` : ''}]`;
  }
}

/**
 * Another adapter's state, which may ride through as it is. The mapping's
 * own kinds are not: back, they would be read as a signature or a part.
 */
function isPassThroughState(state: unknown): state is ProviderState {
  if (!isObject(state) || typeof state.provider !== 'string' || typeof state.kind !== 'string') return false;
  if (state.model !== undefined && typeof state.model !== 'string') return false;
  return !(state.provider === GEMINI_PROVIDER && (state.kind === THOUGHT_SIGNATURE_KIND || state.kind === GENAI_PART_KIND));
}

function withState<P extends Part>(part: P, state: ProviderState): P {
  return { ...part, providerState: state };
}

function partFromGenai(raw: unknown, slot: Role, index: number, ids: IdContext): Part {
  if (!isObject(raw)) {
    const part: Part = { type: 'text', text: typeof raw === 'string' ? raw : '' };
    return withState(part, { provider: GEMINI_PROVIDER, kind: GENAI_PART_KIND, payload: raw });
  }
  const { thoughtSignature, providerState, ...rest } = raw;
  const projection = project(rest);
  let { part, exact } = projection;
  if (!ALLOWED[slot].has(part.type)) {
    part = { type: 'text', text: describe(part) };
    exact = false;
  } else if (projection.needsId && part.type === 'toolCall') {
    part = { ...part, id: ids.call(part.name, index) };
  } else if (projection.needsId && part.type === 'toolResult') {
    part = { ...part, id: ids.result(part.name, index) };
  }
  if (exact && thoughtSignature === undefined && providerState === undefined) return part;
  if (exact && typeof thoughtSignature === 'string' && providerState === undefined) {
    return withState(part, { provider: GEMINI_PROVIDER, kind: THOUGHT_SIGNATURE_KIND, payload: thoughtSignature });
  }
  if (exact && thoughtSignature === undefined && isPassThroughState(providerState)) return withState(part, providerState);
  return withState(part, { provider: GEMINI_PROVIDER, kind: GENAI_PART_KIND, payload: raw });
}

interface IdContext {
  /** An id for a call that has none, opened until a result answers it. */
  call(name: string, part: number): string;
  /** The id for a result that has none: its open minted call's, else a new one. */
  result(name: string, part: number): string;
}

function idContext(content: number, open: OpenCall[]): IdContext {
  const mint = (part: number) => `${MINTED_CALL_ID_PREFIX}${content}-${part}`;
  return {
    call(name, part) {
      const id = mint(part);
      open.push({ name, id, content });
      return id;
    },
    result(name, part) {
      // The latest content's calls first, in their order: parallel calls to
      // one tool are answered in the order they were made.
      let match = -1;
      for (let i = 0; i < open.length; i++) {
        if (open[i].name === name && (match < 0 || open[i].content > open[match].content)) match = i;
      }
      if (match < 0) return mint(part);
      return open.splice(match, 1)[0].id;
    },
  };
}

function mapContent(content: Content, index: number, open: OpenCall[]): Message {
  const slot = slotOf(content);
  const ids = idContext(index, open);
  const parts = (content.parts ?? []).map((p, i) => partFromGenai(p, slot, i, ids));
  return { role: slot, parts } as Message;
}

/**
 * One genai content as a contract message. A call or result without an id
 * gets one minted from `index` (the content's position in its history);
 * results are paired with calls only by contentsToMessages.
 */
export function contentToMessage(content: Content, index = 0): Message {
  return mapContent(content, index, []);
}

/**
 * The text of a system instruction in any of genai's spellings, parts joined
 * by newlines, or undefined when it has none (an empty string included).
 */
export function systemText(instruction: ContentUnion | undefined): string | undefined {
  if (instruction === undefined || instruction === null) return undefined;
  if (typeof instruction === 'string') return instruction || undefined;
  const parts: unknown[] = Array.isArray(instruction)
    ? instruction
    : isObject(instruction) && Array.isArray((instruction as Json).parts)
      ? ((instruction as Json).parts as unknown[])
      : [instruction];
  const texts = parts
    .map((p) => (typeof p === 'string' ? p : isObject(p) && typeof p.text === 'string' && p.thought !== true ? p.text : undefined))
    .filter((t): t is string => t !== undefined);
  return texts.length > 0 ? texts.join('\n') : undefined;
}

/**
 * A genai history (contents plus an optional system instruction) as the
 * contract holds it. Calls and results without ids are paired here.
 */
export function contentsToMessages(contents: readonly Content[], systemInstruction?: ContentUnion): ContractHistory {
  const open: OpenCall[] = [];
  const messages = contents.map((content, index) => mapContent(content, index, open));
  const system = systemText(systemInstruction);
  return system === undefined ? { messages } : { system, messages };
}

// ── Contract → genai ─────────────────────────────────────────────────────────

/** A tool result as a genai `response`: see the header. */
function responseOf(result: unknown, isError: boolean | undefined): Record<string, unknown> {
  if (isError) return { error: result };
  return isObject(result) ? result : { result };
}

/** One contract part as the genai part it maps to. */
export function partToGenai(part: Part): GenaiPart {
  const state = part.providerState;
  if (state?.provider === GEMINI_PROVIDER && state.kind === GENAI_PART_KIND) return state.payload as GenaiPart;
  let out: Json;
  switch (part.type) {
    case 'text':
      out = { text: part.text };
      break;
    case 'thinking':
      out = { text: part.text, thought: true };
      break;
    case 'toolCall':
      out = { functionCall: { name: part.name, args: part.args, ...(isMintedCallId(part.id) ? {} : { id: part.id }) } };
      break;
    case 'toolResult':
      out = { functionResponse: { ...(isMintedCallId(part.id) ? {} : { id: part.id }), name: part.name, response: responseOf(part.result, part.isError) } };
      break;
    case 'blob':
      out = part.url !== undefined ? { fileData: { mimeType: part.mimeType, fileUri: part.url } } : { inlineData: { mimeType: part.mimeType, data: part.data } };
      break;
  }
  if (state?.provider === GEMINI_PROVIDER && state.kind === THOUGHT_SIGNATURE_KIND && typeof state.payload === 'string') {
    out.thoughtSignature = state.payload;
  } else if (state !== undefined) {
    out.providerState = state;
  }
  return out as GenaiPart;
}

/** One contract message as a genai content. */
export function messageToContent(message: Message): Content {
  return { role: GENAI_ROLE[message.role], parts: (message.parts as Part[]).map(partToGenai) };
}

/** The inverse of contentsToMessages; the system instruction comes back as a string. */
export function messagesToContents(history: { system?: string; messages: readonly Message[] }): GenaiHistory {
  const contents = history.messages.map(messageToContent);
  return history.system === undefined ? { contents } : { systemInstruction: history.system, contents };
}

// ── LlmRequest → ModelRequest ────────────────────────────────────────────────

/** What an LlmRequest does not carry: ADK passes these to generateContentAsync beside it. */
export interface ModelRequestOptions {
  /** The model id; default the request's own `model`. */
  model?: string;
  stream?: boolean;
  /** Default the request's `config.abortSignal`. */
  signal?: AbortSignal;
}

// Maps, not object literals: a config value such as `constructor` must read as nothing.
const THINKING_LEVELS = new Map<unknown, ReasoningLevel>([['MINIMAL', 'none'], ['LOW', 'low'], ['MEDIUM', 'medium'], ['HIGH', 'high']]);
const EFFORT_LEVELS = new Map<unknown, ReasoningLevel>([['none', 'none'], ['minimal', 'none'], ['low', 'low'], ['medium', 'medium'], ['high', 'high']]);

/**
 * The ReasoningSetting a generateContentConfig asks for, where one is exact:
 *   - `thinkingConfig.thinkingLevel`: `MINIMAL` is `none` (ADR 0047's
 *     Gemini 3 rendering of it), `LOW`, `MEDIUM`, `HIGH` their levels.
 *   - else `thinkingConfig.thinkingBudget` n ≥ 0: `{ budget_tokens: n }`,
 *     which every adapter maps to what the budget maps to today (0 included).
 *   - else `reasoningEffort`: a level word is that level, and `minimal` is
 *     `none` (ADR 0047's rendering of it on the first GPT-5 generation).
 * Lossy, and absent: a budget of -1 (Gemini's dynamic thinking, which is
 * the provider's default), `THINKING_LEVEL_UNSPECIFIED`, the effort words
 * `xhigh` and `max`, and `includeThoughts`. The compiler writes the effort
 * word beside thinkingConfig from one setting, so preferring thinkingConfig
 * loses nothing it wrote; only the older spelling can set the two apart.
 */
export function reasoningOf(config: GenerateContentConfig | undefined): ReasoningSetting | undefined {
  const cfg = (config ?? {}) as Json;
  const thinking = cfg.thinkingConfig;
  if (isObject(thinking)) {
    const level = THINKING_LEVELS.get(thinking.thinkingLevel);
    if (level) return level;
    const budget = thinking.thinkingBudget;
    if (typeof budget === 'number' && Number.isInteger(budget) && budget >= 0) return { budget_tokens: budget };
  }
  return EFFORT_LEVELS.get(cfg.reasoningEffort);
}

function nativeToolsOf(llmRequest: LlmRequest): NativeTool[] {
  const tools = new Set<NativeTool>();
  // The sentinels a non-Gemini request carries in toolsDict (web_search,
  // x_search, collections_search): tools that declare no function.
  for (const tool of Object.values(llmRequest.toolsDict ?? {})) {
    const native = nativeToolOf(tool);
    if (native) tools.add(native);
  }
  // Gemini's own tool objects. `google_search` and `web_search` both become
  // `{ googleSearch: {} }` on Gemini, so the mapping reads it as the neutral name.
  for (const entry of (llmRequest.config?.tools ?? []) as unknown[]) {
    if (!isObject(entry)) continue;
    if (entry.googleSearch !== undefined || entry.googleSearchRetrieval !== undefined) tools.add('web_search');
    if (entry.urlContext !== undefined) tools.add('url_context');
    if (entry.codeExecution !== undefined) tools.add('code_execution');
  }
  return [...tools];
}

function toolChoiceOf(config: GenerateContentConfig | undefined): { toolChoice?: ToolChoice; strict?: true } {
  const fcc = (config?.toolConfig as Json | undefined)?.functionCallingConfig;
  if (!isObject(fcc)) return {};
  const allowed = Array.isArray(fcc.allowedFunctionNames) ? (fcc.allowedFunctionNames as unknown[]) : [];
  switch (String(fcc.mode)) {
    case 'NONE':
      return { toolChoice: 'none' };
    case 'ANY':
      // Several allowed names have no contract form: any tool is required.
      return { toolChoice: allowed.length === 1 && typeof allowed[0] === 'string' ? { name: allowed[0] } : 'required' };
    case 'VALIDATED':
      return { strict: true };
    default:
      return {};
  }
}

function samplingOf(config: GenerateContentConfig | undefined): Sampling | undefined {
  const sampling: Sampling = {};
  if (typeof config?.temperature === 'number') sampling.temperature = config.temperature;
  if (typeof config?.topP === 'number') sampling.topP = config.topP;
  if (typeof config?.maxOutputTokens === 'number') sampling.maxOutputTokens = config.maxOutputTokens;
  if (Array.isArray(config?.stopSequences) && config.stopSequences.length > 0) sampling.stop = [...config.stopSequences];
  return Object.keys(sampling).length > 0 ? sampling : undefined;
}

/** An ADK LlmRequest as a ModelRequest (see the header for what is not mapped). */
export function llmRequestToModelRequest(llmRequest: LlmRequest, options: ModelRequestOptions = {}): ModelRequest {
  const model = options.model ?? llmRequest.model;
  if (!model) throw new TypeError('llmRequestToModelRequest: the request names no model, and none was given');
  const config = llmRequest.config;
  const { messages } = contentsToMessages(llmRequest.contents ?? []);
  const system = systemText(config?.systemInstruction);
  const { toolChoice, strict } = toolChoiceOf(config);

  // VALIDATED asks Gemini to enforce the schema as declared, so the flag is
  // set on the plain declaration rather than asking for the strict form.
  const tools: ToolDeclaration[] = [];
  for (const tool of Object.values(llmRequest.toolsDict ?? {})) {
    const declaration = contractToolDeclaration(tool);
    if (declaration) tools.push(strict ? { ...declaration, strict } : declaration);
  }
  const nativeTools = nativeToolsOf(llmRequest);
  const schema = config?.responseJsonSchema ?? config?.responseSchema;
  const reasoning = reasoningOf(config);
  const sampling = samplingOf(config);
  const signal = options.signal ?? config?.abortSignal;

  return {
    model,
    ...(system !== undefined ? { system } : {}),
    messages,
    ...(tools.length > 0 ? { tools } : {}),
    ...(nativeTools.length > 0 ? { nativeTools } : {}),
    ...(toolChoice !== undefined ? { toolChoice } : {}),
    ...(isObject(schema) ? { outputSchema: toContractJsonSchema(schema) } : {}),
    ...(reasoning !== undefined ? { reasoning } : {}),
    ...(sampling ? { sampling } : {}),
    ...(options.stream !== undefined ? { stream: options.stream } : {}),
    ...(signal ? { signal } : {}),
  };
}

// ── ModelResponse → LlmResponse ──────────────────────────────────────────────

/**
 * Usage in Gemini's meanings: `candidatesTokenCount` excludes the thinking
 * that `thoughtsTokenCount` counts, and `totalTokenCount` is input plus
 * output. `cacheWriteTokens` has no genai field.
 */
export function usageToMetadata(usage: Usage): GenerateContentResponseUsageMetadata {
  const thinking = usage.thinkingTokens ?? 0;
  return {
    promptTokenCount: usage.inputTokens,
    candidatesTokenCount: Math.max(0, usage.outputTokens - thinking),
    ...(usage.thinkingTokens !== undefined ? { thoughtsTokenCount: usage.thinkingTokens } : {}),
    ...(usage.cacheReadTokens !== undefined ? { cachedContentTokenCount: usage.cacheReadTokens } : {}),
    totalTokenCount: usage.inputTokens + usage.outputTokens,
  };
}

/** Gemini's usageMetadata as contract Usage, or undefined when it counts nothing. */
export function usageFromMetadata(meta: GenerateContentResponseUsageMetadata | undefined): Usage | undefined {
  if (!meta) return undefined;
  const counted = [meta.promptTokenCount, meta.toolUsePromptTokenCount, meta.candidatesTokenCount, meta.thoughtsTokenCount];
  if (counted.every((n) => n === undefined)) return undefined;
  return {
    inputTokens: (meta.promptTokenCount ?? 0) + (meta.toolUsePromptTokenCount ?? 0),
    outputTokens: (meta.candidatesTokenCount ?? 0) + (meta.thoughtsTokenCount ?? 0),
    ...(meta.thoughtsTokenCount !== undefined ? { thinkingTokens: meta.thoughtsTokenCount } : {}),
    ...(meta.cachedContentTokenCount !== undefined ? { cacheReadTokens: meta.cachedContentTokenCount } : {}),
  };
}

/** `content_filter` cannot say which of Gemini's policy reasons it was; it becomes SAFETY. */
const FINISH_REASONS: Record<ContractFinishReason, FinishReason | undefined> = {
  stop: FinishReason.STOP,
  tool_call: FinishReason.STOP,
  max_tokens: FinishReason.MAX_TOKENS,
  content_filter: FinishReason.SAFETY,
  other: FinishReason.OTHER,
  error: undefined,
};

/** The groundingMetadata lib/grounding.ts reads: the queries, and each cited URL once. */
function groundingToMetadata(grounding: Grounding): GroundingMetadata | undefined {
  const webSearchQueries = (grounding.searchQueries ?? []).map((q) => q.query).filter((q) => q);
  const seen = new Set<string>();
  const groundingChunks: NonNullable<GroundingMetadata['groundingChunks']> = [];
  for (const c of grounding.citations ?? []) {
    if (seen.has(c.url)) continue;
    seen.add(c.url);
    groundingChunks.push({ web: { uri: c.url, ...(c.title !== undefined ? { title: c.title } : {}) } });
  }
  if (webSearchQueries.length === 0 && groundingChunks.length === 0) return undefined;
  return {
    ...(webSearchQueries.length > 0 ? { webSearchQueries } : {}),
    ...(groundingChunks.length > 0 ? { groundingChunks } : {}),
  };
}

/** A ModelResponse as the LlmResponse ADK expects from a model (see the header). */
export function modelResponseToLlmResponse(response: ModelResponse): LlmResponse {
  const parts = (response.parts as Part[]).map(partToGenai);
  if (response.partial) return { content: { role: 'model', parts }, partial: true };
  const finishReason = FINISH_REASONS[response.finishReason];
  const groundingMetadata = response.grounding ? groundingToMetadata(response.grounding) : undefined;
  const llmResponse: LlmResponse = {
    ...(parts.length > 0 ? { content: { role: 'model', parts } } : {}),
    ...(response.error ? { errorCode: response.error.code, errorMessage: response.error.message } : {}),
    ...(finishReason !== undefined ? { finishReason } : {}),
    ...(response.usage ? { usageMetadata: usageToMetadata(response.usage) } : {}),
    ...(groundingMetadata ? { groundingMetadata } : {}),
    turnComplete: true,
  };
  // FallbackLlm reads the verdict from customMetadata alone (ADR 0044): an
  // error without it would be passed on, never answered by the fallback.
  if (!response.error) return llmResponse;
  const { retryable, status } = response.error;
  return withRetryVerdict(llmResponse, { retryable, ...(status !== undefined ? { status } : {}) });
}
