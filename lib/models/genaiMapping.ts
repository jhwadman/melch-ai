/**
 * lib/models/genaiMapping.ts — @google/genai `Content`, and the genai-shaped
 * LlmRequest and LlmResponse, to and from the engine's model contract
 * (lib/models/contract.ts, ADR 0048).
 *
 * WHY this file exists:
 *   Every stored event's `content` is @google/genai `Content`, the shape ADK
 *   wrote and the engine keeps (ADR 0045's fixed shapes). The native loop
 *   and every adapter on the contract speak `Message` and `Part`. This
 *   module converts between the two, so the loop reads a session ADK stored
 *   before 1.0.0 as it reads its own, and stores each answer in the same
 *   shape (modelResponseToLlmResponse). It is pure (no I/O, clock or randomness) and never mutates its
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
 *   returns none, and the engine strips its own `adk-` ids from every
 *   request, as ADK did) gets
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
 * `responseJsonSchema` or `responseSchema` as a lowercase outputSchema, and
 * `responseMimeType: 'application/json'` with neither as `outputFormat:
 * 'json'` (JSON mode, ADR 0061); the function-calling mode as toolChoice
 * (`VALIDATED` as strict tools); the reasoning fields as a ReasoningSetting where it is exact (reasoningOf);
 * sampling; stream; the abort signal. Not mapped: tool options inside a
 * `config.tools` entry, any other `config.tools` entry, `includeThoughts`,
 * and the generateContentConfig fields the contract leaves out (topK, seed,
 * penalties, safetySettings).
 *
 * THE RESPONSE (modelResponseToLlmResponse). Parts back to a `model`
 * content; a partial as `partial: true`, the final with `turnComplete:
 * true`; usage in Gemini's meanings (usageToMetadata); error as `errorCode`
 * and `errorMessage`, key-shaped text scrubbed, with `retryable` and
 * `status` as customMetadata['error.retryable'] and ['error.status']
 * (withRetryVerdict, lib/models/errorResponse.ts); finishReason as
 * Gemini's, except that an error whose code is one of Gemini's finish
 * reasons (the Gemini adapter keeps it verbatim: MALFORMED_FUNCTION_CALL,
 * RECITATION, ...) gets that reason itself, as ADK's Gemini reported both,
 * so self-correction retries a malformed call and the stored event reads as
 * one ADK stored (ADR 0088); grounding as the `webSearchQueries` and
 * `groundingChunks[].web` that lib/grounding.ts reads. Not carried, since
 * an LlmResponse has no field for them: `cacheWriteTokens`, a citation's
 * span and cited text, and which native tool ran a query.
 *
 * THE REVERSE: a ModelRequest as a genai-shaped LlmRequest, and each
 * LlmResponse back, for a caller that holds a genai-speaking model.
 *
 *   modelRequestToLlmRequest builds the genai-shaped request for a Gemini
 *   model: the system prompt as `systemInstruction`; the messages as
 *   above; client tools as `functionDeclarations` with the lowercase schema
 *   in `parametersJsonSchema`, and in `toolsDict` as declaration-only
 *   entries, where llmRequestToModelRequest reads them; native tools as Gemini's tool objects, in the request's order;
 *   toolChoice and strict as the function-calling mode, sent only beside
 *   declarations; the output schema as `responseJsonSchema`, and
 *   `outputFormat: 'json'` without one as `responseMimeType:
 *   'application/json'`; reasoning
 *   through reasoningConfig (lib/models/reasoning.ts), as the compiler maps
 *   it; sampling; the signal as `config.abortSignal`. What does not come
 *   back the same through llmRequestToModelRequest: `google_search` reads as
 *   `web_search`; `x_search` and `collections_search` are left out (Gemini
 *   has no tool for them, and they go only to xAI); `auto`
 *   reads as absent, and a choice without tools is not sent; one strict tool
 *   makes every tool strict, and strict is lost beside a forced choice; a
 *   level a model renders as a budget or another word reads back as that
 *   rendering; `outputFormat: 'json'` beside a schema reads back as the
 *   schema alone; `stream` is not an LlmRequest field. System messages stay
 *   `system` contents, which Gemini refuses: the caller folds them into the
 *   system prompt.
 *
 *   llmResponseToModelResponse reads one LlmResponse. A partial is its text
 *   and thinking deltas. Anything else is a final: its parts as an assistant
 *   message's, minus thinking, whose signature moves to the next part (or
 *   stays with the last part when none follows); `model`, when given, on
 *   every thought_signature state, as GeminiAdapter writes it; ids minted
 *   from `index`, the answer's place in its conversation; `errorCode` as the
 *   error, with the verdict read back from customMetadata and key-shaped text
 *   scrubbed, except ADK's `STOP`, which is no error; Gemini's finish reason
 *   as the contract's (`tool_call` whenever a call is there); usage under
 *   the contract's meanings; grounding as the cited pages and the search
 *   queries, attributed to `searchTool`. Not read back: citation spans and
 *   cited text, `cacheWriteTokens`, and any thought text in a final, which is
 *   display only (the caller yields it as a partial).
 *
 * USAGE MEANINGS. usageToMetadata and usageFromMetadata use Gemini's: its
 * `candidatesTokenCount` excludes the thinking in `thoughtsTokenCount`.
 * Every adapter's final is stored and charged through usageToMetadata, so
 * this is the ledger's one meaning for every provider (ADR 0107).
 * Events the GPT and chat-completions adapters stored under ADK (before
 * 1.0.0) carry `candidatesTokenCount` with reasoning included, so
 * usageFromMetadata on such an event counts that reasoning twice in
 * `outputTokens`.
 */

import { FinishReason, FunctionCallingConfigMode } from '@google/genai';
import type {
  Content,
  ContentUnion,
  GenerateContentConfig,
  GenerateContentResponseUsageMetadata,
  GroundingMetadata,
  Part as GenaiPart,
  CitationMetadata,
  Tool,
  ToolConfig,
} from '@google/genai';

import type {
  Citation,
  FinalModelResponse,
  FinishReason as ContractFinishReason,
  Grounding,
  Message,
  ModelError,
  ModelRequest,
  ModelResponse,
  NativeTool,
  OutputPart,
  Part,
  ProviderState,
  ReasoningLevel,
  ReasoningSetting,
  Role,
  Sampling,
  TextPart,
  ThinkingPart,
  ToolChoice,
  ToolDeclaration,
  Usage,
} from './contract.ts';
import { ERROR_RETRYABLE_KEY, ERROR_STATUS_KEY, errorText, withRetryVerdict } from './errorResponse.ts';
import { CARRIED_PARTS_KIND, GEMINI_PROVIDER, GENAI_PART_KIND, MINTED_CALL_ID_PREFIX, THOUGHT_SIGNATURE_KIND } from './geminiState.ts';
import { reasoningConfig } from './reasoning.ts';
import { contractToolDeclaration, nativeToolOf, toContractJsonSchema } from './schemaNormalize.ts';
import { MAX_VALUE_DEPTH, nestedDeeperThan } from '../runtime/valueDepth.ts';

// ── The genai request and response shapes (ADR 0107) ─────────────────────────

/**
 * A tool as a request's `toolsDict` holds it: a name and, for a function
 * tool, `_getDeclaration()` giving its declaration with a lowercase schema as
 * `parameters` (contractToolDeclaration reads it). A server-side tool carries
 * its NativeTool marker instead (lib/tools/tool.ts NATIVE_TOOL).
 */
export interface DeclaredTool {
  name: string;
  description?: string;
  isLongRunning?: boolean;
  _getDeclaration?(): unknown;
  [key: string | symbol]: unknown;
}

/**
 * One model request in genai's shape: the JSON ADK's LlmRequest carried,
 * owned by the engine since 1.0.0. The summarizer, the memory extractor and
 * the tracer build or read it; llmRequestToModelRequest maps it onto the
 * contract.
 */
export interface LlmRequest {
  model?: string;
  contents: Content[];
  config?: GenerateContentConfig;
  liveConnectConfig?: Record<string, unknown>;
  toolsDict: Record<string, DeclaredTool>;
  allowedTools?: string[];
}

/**
 * One model response in genai's shape: the JSON ADK's LlmResponse carried,
 * and what a stored model event is made from (lib/runtime/native/step.ts).
 * Owned by the engine since 1.0.0.
 */
export interface LlmResponse {
  content?: Content;
  groundingMetadata?: GroundingMetadata;
  citationMetadata?: CitationMetadata;
  partial?: boolean;
  turnComplete?: boolean;
  errorCode?: string;
  errorMessage?: string;
  interrupted?: boolean;
  customMetadata?: Record<string, unknown>;
  usageMetadata?: GenerateContentResponseUsageMetadata;
  finishReason?: FinishReason;
  modelVersion?: string;
}

/**
 * The provider id the mapping writes its own state under (only a Gemini
 * adapter replays it), and the providerState kind for a Gemini
 * `thoughtSignature`, whose payload is the signature. Defined once in
 * lib/models/geminiState.ts, so the Gemini adapter spells them the same.
 */
export { GEMINI_PROVIDER, THOUGHT_SIGNATURE_KIND };
/** providerState kind for a genai part the contract cannot hold exactly; the payload is the part (defined in lib/models/geminiState.ts). */
export { GENAI_PART_KIND };
/** The prefix of an id the mapping made for a call or result that had none (defined in lib/models/geminiState.ts). */
export { MINTED_CALL_ID_PREFIX };

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

/**
 * Contract parts as genai parts. A part the Gemini adapter wrote with
 * `carried_parts` state (code execution, server-side invocations, ADR 0065)
 * becomes the genai parts it carries, verbatim, then itself with its own
 * signature as `thoughtSignature`. An empty text part that only carried them
 * is left out unless it has a signature. So a stored event holds the parts as
 * Gemini sent them, as ADK's Gemini stores them (ADR 0100).
 */
export function partsToGenai(parts: readonly Part[]): GenaiPart[] {
  const out: GenaiPart[] = [];
  for (const part of parts) {
    const state = part.providerState;
    if (state?.provider !== GEMINI_PROVIDER || state.kind !== CARRIED_PARTS_KIND || !isObject(state.payload)) {
      out.push(partToGenai(part));
      continue;
    }
    const { before, signature } = state.payload as { before?: unknown; signature?: unknown };
    if (Array.isArray(before)) for (const carried of before) if (isObject(carried)) out.push({ ...carried } as GenaiPart);
    const { providerState: _carried, ...bare } = part;
    const own = typeof signature === 'string' && signature ? signature : undefined;
    if (bare.type === 'text' && !bare.text && !own) continue;
    const genai = partToGenai(bare as Part);
    out.push(own ? ({ ...genai, thoughtSignature: own } as GenaiPart) : genai);
  }
  return out;
}

/** One contract message as a genai content. */
export function messageToContent(message: Message): Content {
  return { role: GENAI_ROLE[message.role], parts: partsToGenai(message.parts as Part[]) };
}

/** The inverse of contentsToMessages; the system instruction comes back as a string. */
export function messagesToContents(history: { system?: string; messages: readonly Message[] }): GenaiHistory {
  const contents = history.messages.map(messageToContent);
  return history.system === undefined ? { contents } : { systemInstruction: history.system, contents };
}

// ── LlmRequest → ModelRequest ────────────────────────────────────────────────

/** What an LlmRequest does not carry: the caller passes these beside it, as ADK did to generateContentAsync. */
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

/** The function-calling mode as a ToolChoice, and VALIDATED as strict tools. The native request builder reads an agent's config through it too. */
export function toolChoiceOf(config: GenerateContentConfig | undefined): { toolChoice?: ToolChoice; strict?: true } {
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

/** The sampling fields the contract carries, or undefined when none is set. The native request builder reads an agent's config through it too. */
export function samplingOf(config: GenerateContentConfig | undefined): Sampling | undefined {
  const sampling: Sampling = {};
  if (typeof config?.temperature === 'number') sampling.temperature = config.temperature;
  if (typeof config?.topP === 'number') sampling.topP = config.topP;
  if (typeof config?.maxOutputTokens === 'number') sampling.maxOutputTokens = config.maxOutputTokens;
  if (Array.isArray(config?.stopSequences) && config.stopSequences.length > 0) sampling.stop = [...config.stopSequences];
  return Object.keys(sampling).length > 0 ? sampling : undefined;
}

/** A genai-shaped LlmRequest as a ModelRequest (see the header for what is not mapped). */
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
  // JSON mode: the MIME type alone, with no schema to say more (ADR 0061).
  const jsonMode = !isObject(schema) && config?.responseMimeType === 'application/json';
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
    ...(jsonMode ? { outputFormat: 'json' as const } : {}),
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

/** Gemini's finish reasons that end a call short of an answer: every one but STOP and the unspecified one. */
const GEMINI_FINISH_REASONS: ReadonlySet<string> = new Set(
  Object.values(FinishReason).filter((r) => r !== FinishReason.STOP && r !== FinishReason.FINISH_REASON_UNSPECIFIED),
);

/** An error code that is one of Gemini's finish reasons, as the finish reason ADK's Gemini reports beside it (ADR 0088). */
function finishReasonOfCode(code: string | undefined): FinishReason | undefined {
  return code !== undefined && GEMINI_FINISH_REASONS.has(code) ? (code as FinishReason) : undefined;
}

/** What a call's arguments become when they nest past MAX_VALUE_DEPTH (contractOutputPart). */
export const TOO_DEEP_ARGUMENTS = `[arguments nested deeper than ${MAX_VALUE_DEPTH} levels were dropped]`;

/**
 * One part of a model's answer as the contract allows it (lib/models/
 * contract.ts), or undefined to drop it. The contract binds an adapter, and
 * a model's answer is untrusted input to the loop that stores it, so the
 * loop holds an adapter to it here rather than store a part no reader
 * expects (WS5-5, wiki/operations/native-loop-security.md):
 *   - a part that is not an object, of no known kind, or a tool result (an
 *     answer holds none) is dropped;
 *   - a text or thinking part whose text is not a string is dropped;
 *   - a tool call's name and id that are not strings become `''` (the
 *     runtime then mints the id), and its arguments that are not an object
 *     become `{}` when absent or null, else `{ raw: <value> }`, the
 *     contract's form for arguments that do not parse;
 *   - arguments that nest deeper than MAX_VALUE_DEPTH levels (lib/runtime/
 *     valueDepth.ts) become `{ raw: TOO_DEEP_ARGUMENTS }`: every later
 *     reader of the session would overflow its stack on them;
 *   - a blob needs a string mimeType and a string `data` or `url`;
 *   - a Gemini part carried whole must be an object.
 * A part the contract allows is returned as it is, so a well-behaved
 * adapter's answer maps exactly as before.
 */
function contractOutputPart(part: unknown): Part | undefined {
  if (!isObject(part)) return undefined;
  const state = part.providerState as Part['providerState'] | undefined;
  if (state?.provider === GEMINI_PROVIDER && state.kind === GENAI_PART_KIND && !isObject(state.payload)) return undefined;
  switch (part.type) {
    case 'text':
    case 'thinking':
      return typeof part.text === 'string' ? (part as unknown as Part) : undefined;
    case 'toolCall': {
      const { name, id, args } = part;
      const tooDeep = nestedDeeperThan(args);
      if (typeof name === 'string' && typeof id === 'string' && (isObject(args) || Array.isArray(args)) && !tooDeep) return part as unknown as Part;
      const checkedArgs = tooDeep
        ? { raw: TOO_DEEP_ARGUMENTS }
        : isObject(args) || Array.isArray(args)
          ? args
          : args === undefined || args === null
            ? {}
            : { raw: args };
      return { ...part, type: 'toolCall', name: typeof name === 'string' ? name : '', id: typeof id === 'string' ? id : '', args: checkedArgs as Record<string, unknown> };
    }
    case 'blob':
      return typeof part.mimeType === 'string' && (typeof part.data === 'string' || typeof part.url === 'string') ? (part as unknown as Part) : undefined;
    default:
      return undefined;
  }
}

/**
 * `response` with each part held to the contract (contractOutputPart): the
 * same object when every part already is, else a copy with the parts
 * checked. Used by modelResponseToLlmResponse and by the native step, so the
 * step reads the same answer it stores. A
 * response that is not an object is returned as it is: the caller fails on
 * it as on any adapter that broke the contract.
 */
export function contractModelResponse<R extends ModelResponse>(response: R): R {
  if (!isObject(response)) return response;
  const raw: unknown = (response as { parts?: unknown }).parts;
  const parts = Array.isArray(raw) ? raw : [];
  const checked = parts.map(contractOutputPart);
  if (Array.isArray(raw) && checked.every((p, i) => p === parts[i])) return response;
  return { ...response, parts: checked.filter((p): p is Part => p !== undefined) } as R;
}

/** A ModelResponse as a genai-shaped LlmResponse, the shape a stored model event is made from (see the header). */
export function modelResponseToLlmResponse(unchecked: ModelResponse): LlmResponse {
  const response = contractModelResponse(unchecked);
  const parts = partsToGenai(response.parts as Part[]);
  if (response.partial) return { content: { role: 'model', parts }, partial: true };
  const finishReason = finishReasonOfCode(response.error?.code) ?? FINISH_REASONS[response.finishReason];
  const groundingMetadata = response.grounding ? groundingToMetadata(response.grounding) : undefined;
  const llmResponse: LlmResponse = {
    ...(parts.length > 0 ? { content: { role: 'model', parts } } : {}),
    ...(response.error ? { errorCode: response.error.code, errorMessage: response.error.message } : {}),
    ...(finishReason !== undefined ? { finishReason } : {}),
    ...(response.usage ? { usageMetadata: usageToMetadata(response.usage) } : {}),
    ...(groundingMetadata ? { groundingMetadata } : {}),
    turnComplete: true,
  };
  // A reader of this shape takes the verdict from customMetadata alone
  // (ADR 0044): an error without it reads as not retryable.
  if (!response.error) return llmResponse;
  const { retryable, status } = response.error;
  return withRetryVerdict(llmResponse, { retryable, ...(status !== undefined ? { status } : {}) });
}

// ── ModelRequest → LlmRequest ────────────────────────────────────────────────

/** The Gemini tool object each native tool becomes. `x_search` and `collections_search` have none. */
const GEMINI_NATIVE_TOOLS: Partial<Record<NativeTool, () => Tool>> = {
  web_search: () => ({ googleSearch: {} }),
  google_search: () => ({ googleSearch: {} }),
  url_context: () => ({ urlContext: {} }),
  code_execution: () => ({ codeExecution: {} }),
};

/** The native tools in `tools` that Gemini has no tool for, each once: modelRequestToLlmRequest leaves them out. */
export function nativeToolsWithoutGeminiTool(tools: readonly NativeTool[] = []): NativeTool[] {
  return [...new Set(tools)].filter((tool) => !GEMINI_NATIVE_TOOLS[tool]);
}

/**
 * A toolsDict entry that only declares. `_getDeclaration()` gives the
 * declaration with its lowercase schema as `parameters`, where
 * llmRequestToModelRequest (contractToolDeclaration) reads it. It is never
 * run: a Gemini request sends `config.tools`, and nothing calls a tool out
 * of a request.
 */
function declaredTool({ name, description, parameters }: ToolDeclaration): DeclaredTool {
  return { name, description, isLongRunning: false, _getDeclaration: () => ({ name, description, parameters }) };
}

/** The function-calling mode for the request's tool choice and strict tools, sent only beside declarations. */
function toolConfigOf(request: ModelRequest): ToolConfig | undefined {
  if (!request.tools?.length) return undefined;
  const choice = request.toolChoice;
  if (typeof choice === 'object') {
    return { functionCallingConfig: { mode: FunctionCallingConfigMode.ANY, allowedFunctionNames: [choice.name] } };
  }
  const mode =
    choice === 'none'
      ? FunctionCallingConfigMode.NONE
      : choice === 'required'
        ? FunctionCallingConfigMode.ANY
        : request.tools.some((t) => t.strict)
          ? FunctionCallingConfigMode.VALIDATED
          : choice === 'auto'
            ? FunctionCallingConfigMode.AUTO
            : undefined;
  return mode ? { functionCallingConfig: { mode } } : undefined;
}

/** A ModelRequest as the genai-shaped request for a Gemini model (see the header for what does not come back the same). */
export function modelRequestToLlmRequest(request: ModelRequest): LlmRequest {
  const config: GenerateContentConfig = {};
  if (request.system) config.systemInstruction = request.system;

  const declarations = request.tools ?? [];
  const tools: Tool[] = [];
  if (declarations.length > 0) {
    tools.push({
      functionDeclarations: declarations.map(({ name, description, parameters }) => ({ name, description, parametersJsonSchema: parameters })),
    });
  }
  // In the request's order, so llmRequestToModelRequest reads them back in it.
  let searching = false;
  for (const native of new Set(request.nativeTools ?? [])) {
    const tool = GEMINI_NATIVE_TOOLS[native];
    if (!tool) continue;
    if (native === 'web_search' || native === 'google_search') {
      if (searching) continue;
      searching = true;
    }
    tools.push(tool());
  }
  if (tools.length > 0) config.tools = tools;

  const toolConfig = toolConfigOf(request);
  if (toolConfig) config.toolConfig = toolConfig;
  if (request.outputSchema) {
    config.responseMimeType = 'application/json';
    config.responseJsonSchema = request.outputSchema;
  } else if (request.outputFormat === 'json') {
    config.responseMimeType = 'application/json';
  }
  // The fields the compiler writes for the model (ADR 0047): a thinking
  // level or budget on Gemini, and the effort word every other adapter reads.
  if (request.reasoning !== undefined) Object.assign(config, reasoningConfig(request.model, request.reasoning));
  const sampling = request.sampling;
  if (sampling?.temperature !== undefined) config.temperature = sampling.temperature;
  if (sampling?.topP !== undefined) config.topP = sampling.topP;
  if (sampling?.maxOutputTokens !== undefined) config.maxOutputTokens = sampling.maxOutputTokens;
  if (sampling?.stop?.length) config.stopSequences = [...sampling.stop];
  if (request.signal) config.abortSignal = request.signal;

  return {
    model: request.model,
    contents: messagesToContents({ messages: request.messages }).contents,
    config,
    liveConnectConfig: {},
    toolsDict: Object.fromEntries(declarations.map((d) => [d.name, declaredTool(d)])),
  };
}

// ── LlmResponse → ModelResponse ──────────────────────────────────────────────

/** What an LlmResponse does not carry, for the response it maps to. */
export interface ModelResponseOptions {
  /**
   * The model that answered. Set on every thought_signature state the final
   * carries, as GeminiAdapter writes it, so a reader replays it for that
   * model only (ADR 0046). Default none: genai records none.
   */
  model?: string;
  /** The answer's index in its conversation, from which ids are minted for calls without one. Default 0. */
  index?: number;
  /** The native tool a grounded answer's search queries are attributed to. Default `web_search`. */
  searchTool?: NativeTool;
}

/** Gemini's reasons for withholding an answer, or blocking a prompt, on policy grounds. */
const POLICY_REASONS: ReadonlySet<string> = new Set(['SAFETY', 'RECITATION', 'BLOCKLIST', 'PROHIBITED_CONTENT', 'SPII', 'MODEL_ARMOR', 'JAILBREAK']);

function isPolicyReason(reason: string): boolean {
  return POLICY_REASONS.has(reason) || reason.startsWith('IMAGE_');
}

/** Gemini's finish reason as the contract's (the Gemini table of wiki/models/model-contract.md). */
function finishReasonOf(reason: string): ContractFinishReason {
  if (reason === 'STOP') return 'stop';
  if (reason === 'MAX_TOKENS') return 'max_tokens';
  return isPolicyReason(reason) ? 'content_filter' : 'other';
}

function isSignatureState(state: ProviderState | undefined): state is ProviderState {
  return state?.provider === GEMINI_PROVIDER && state.kind === THOUGHT_SIGNATURE_KIND;
}

/**
 * An assistant message's parts as a final's: thinking left out, a signature
 * it carried moved to the next part when that part has no state of its own,
 * or kept by the last part when no part follows; `model` set on every
 * signature that names none.
 */
function outputPartsOf(parts: readonly Part[], model: string | undefined): OutputPart[] {
  const out: OutputPart[] = [];
  let carried: ProviderState | undefined;
  for (const part of parts) {
    if (part.type === 'thinking') {
      if (isSignatureState(part.providerState)) carried = part.providerState;
      continue;
    }
    if (part.type === 'toolResult') continue; // an assistant message holds none
    out.push(carried && part.providerState === undefined ? { ...part, providerState: carried } : part);
    carried = undefined;
  }
  const last = out.at(-1);
  if (carried && last && last.providerState === undefined) out[out.length - 1] = { ...last, providerState: carried };
  if (model === undefined) return out;
  return out.map((p) => (isSignatureState(p.providerState) && p.providerState.model === undefined ? { ...p, providerState: { ...p.providerState, model } } : p));
}

/** A genai-shaped error code as the contract's error, with the verdict the adapter stamped (withRetryVerdict). `STOP` is no error. */
function errorOf(response: LlmResponse): ModelError | undefined {
  const code = response.errorCode;
  if (!code || code === 'STOP') return undefined;
  const status = response.customMetadata?.[ERROR_STATUS_KEY];
  return {
    code,
    message: errorText(response.errorMessage || `The model call ended with ${code}.`),
    retryable: response.customMetadata?.[ERROR_RETRYABLE_KEY] === true,
    ...(typeof status === 'number' ? { status } : {}),
  };
}

/** Each cited page once, with its title, and the queries run: what groundingToMetadata writes. Citation spans are not read. */
function groundingOf(meta: GroundingMetadata | undefined, tool: NativeTool): Grounding | undefined {
  if (!meta) return undefined;
  const citations: Citation[] = [];
  const seen = new Set<string>();
  for (const chunk of meta.groundingChunks ?? []) {
    const url = chunk.web?.uri;
    if (!url || seen.has(url)) continue;
    seen.add(url);
    citations.push(chunk.web?.title ? { url, title: chunk.web.title } : { url });
  }
  const searchQueries = (meta.webSearchQueries ?? []).filter((q) => typeof q === 'string' && q).map((query) => ({ tool, query }));
  if (citations.length === 0 && searchQueries.length === 0) return undefined;
  return { ...(citations.length > 0 ? { citations } : {}), ...(searchQueries.length > 0 ? { searchQueries } : {}) };
}

/** One LlmResponse as a ModelResponse (see the header). A caller folding a stream of them into one final keeps the thinking itself. */
export function llmResponseToModelResponse(response: LlmResponse, options: ModelResponseOptions = {}): ModelResponse {
  const raw = response.content?.parts ?? [];
  if (response.partial === true) {
    const parts: Array<TextPart | ThinkingPart> = [];
    for (const p of raw as unknown[]) {
      if (!isObject(p) || typeof p.text !== 'string' || p.text === '') continue;
      parts.push(p.thought === true ? { type: 'thinking', text: p.text } : { type: 'text', text: p.text });
    }
    return { partial: true, parts };
  }
  const message = contentToMessage({ role: 'model', parts: raw }, options.index ?? 0);
  const parts = outputPartsOf(message.parts as Part[], options.model);
  const error = errorOf(response);
  const reason = typeof response.finishReason === 'string' && response.finishReason ? response.finishReason : undefined;
  const finishReason: ContractFinishReason = parts.some((p) => p.type === 'toolCall')
    ? 'tool_call'
    : reason
      ? finishReasonOf(reason)
      : error
        ? isPolicyReason(error.code)
          ? 'content_filter'
          : 'error'
        : 'stop';
  const usage = usageFromMetadata(response.usageMetadata);
  const grounding = groundingOf(response.groundingMetadata, options.searchTool ?? 'web_search');
  const final: FinalModelResponse = {
    partial: false,
    parts,
    finishReason,
    ...(usage ? { usage } : {}),
    ...(grounding ? { grounding } : {}),
    ...(error ? { error } : {}),
  };
  return final;
}
