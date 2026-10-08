/**
 * lib/models/gptAdapter.ts — the Responses API behind the engine's own model
 * contract (lib/models/contract.ts, ADR 0048): OpenAI's GPT, and the base
 * that xAI's Grok (lib/models/grokAdapter.ts) extends.
 *
 * WHY this file exists:
 *   OpenAI's Responses API is where OpenAI exposes reasoning summaries and
 *   its first-class `web_search` tool, and xAI's Agent Tools API speaks the
 *   same wire. GptLlm and GrokLlm translated ADK's LlmRequest to it
 *   directly. This module is that translation on the contract: it reads a
 *   ModelRequest and yields ModelResponses, with no ADK in the path, so the
 *   native runtime (ADR 0045) can call it. GptLlm and GrokLlm (gptLlm.ts,
 *   grokLlm.ts) are now the ADK shim (lib/models/adkShim.ts) around it.
 *
 * THE MAPPING is the OpenAI Responses table of wiki/models/model-contract.md
 * (and its xAI table for the subclass). In short:
 *   system, system messages  → `instructions`
 *   user / assistant text    → { role, content: [input_text | output_text] }
 *   toolCall                 → { type: 'function_call', call_id, name, arguments }
 *   toolResult               → { type: 'function_call_output', call_id, output }
 *   user blob                → input_image (a data URL, or an https URL), input_file for PDF
 *   reasoning                → `reasoning` (ADR 0047), per vendor (reasoningParam)
 *   outputSchema             → text.format json_schema, strict
 *   outputFormat 'json'      → text.format json_object (JSON mode, ADR 0061)
 *   nativeTools              → the vendor's own tool objects (nativeToolPlan)
 *   'reasoning' output items → providerState on the part after them (ADR 0050),
 *                              replayed before that part within the turn's tool loop
 *   summaries                → thinking partials (display only)
 *   web_search_call, custom_tool_call → grounding.searchQueries; url_citation → citations
 *
 * THE ADAPTER RULES (contract.ts header) as this adapter keeps them:
 *   - Errors are finals, never throws: `<PROVIDER>_ERROR` for a failed call,
 *     with the retry verdict lib/models/retry.ts gives; `<PROVIDER>_STREAM_ERROR`
 *     for a stream that reported `response.failed` or `error`, with a verdict
 *     when the event names a status or an error type (streamErrorDecision).
 *   - The SDK's own retries (two) run before the first byte, inside generate().
 *   - `request.signal` goes to the SDK and also ends the iteration at once.
 *   - It opens no span and charges no turn (ADR 0053); it only adds
 *     attributes to the span open around it (setLlmSpanAttribute).
 *
 * BEYOND THE CONTRACT: the server-side tool calls a response reports, with
 * their arguments and sources, have no contract field. responsesServerTools()
 * returns them for a final this adapter yielded, so GptLlm can put them on the
 * ADK event's customMetadata where the ledger reads them (ADR 0056).
 */

import type {
  BlobPart,
  Citation,
  FinalModelResponse,
  FinishReason,
  Grounding,
  ModelAdapter,
  ModelError,
  ModelErrorCode,
  ModelRequest,
  ModelResponse,
  NativeTool,
  OutputPart,
  Part,
  PartialModelResponse,
  ReasoningSetting,
  SearchQuery,
  ToolResultPart,
  Usage,
} from './contract.ts';
import { endpointFromEnv, entraTokenSource, nativeSearchOn, platformModel } from './endpoints.ts';
import type { ProviderEndpoint } from './endpoints.ts';
import { errorDecision, errorText, statusDecision } from './errorResponse.ts';
import { currentTurnStart, providerStateOf } from './providerState.ts';
import type { ProviderState } from './providerState.ts';
import { reasoningConfig } from './reasoning.ts';
import type { RetryDecision } from './retry.ts';
import { toContractJsonSchema } from './schemaNormalize.ts';
import { setLlmSpanAttribute } from '../observability/tracer.ts';

/** The providerState kind the Responses adapters write: the reasoning output items that preceded a part (ADR 0046, ADR 0050). */
export const REASONING_STATE_KIND = 'reasoning_items';

/** The `include` value that returns reasoning items with their encrypted content. */
const ENCRYPTED_REASONING = 'reasoning.encrypted_content';

/** OpenAI's reasoning ids: the o-series and the gpt-5 family. */
export function isOpenAiReasoningModel(model: string): boolean {
  return /^o[0-9]/.test(model) || /^gpt-5/.test(model);
}

/** A reasoning item that can be sent back with `store: false`: one that carries its encrypted content. */
const isReplayableReasoning = (item: unknown): boolean =>
  !!item && typeof item === 'object' && (item as Record<string, unknown>).type === 'reasoning' && typeof (item as Record<string, unknown>).encrypted_content === 'string';

type Json = Record<string, unknown>;
type WireItem = Record<string, any>;

function isPlainObject(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// ── The request ──────────────────────────────────────────────────────────────

/** Who replays reasoning items in a request: this provider's, for this model only. */
export interface ReasoningReplay {
  provider: string;
  model: string;
}

/** The input items built from a conversation, and what was left out of them. */
export interface ResponsesInput {
  instructions?: string;
  input: WireItem[];
  /** Blobs that could not be sent, by reason (`URL scheme`). */
  droppedBlobs: string[];
}

/** A tool result as the `output` text: what genai's functionResponse.response holds for it. */
function resultJson(part: ToolResultPart): string {
  const response = part.isError ? { error: part.result } : isPlainObject(part.result) ? part.result : { result: part.result };
  return JSON.stringify(response);
}

/** A user-turn blob as an input content item, or why it is left out. */
function blobItem(part: BlobPart): WireItem | string {
  // The genai mapping types an untyped part as octet-stream; the ADK path
  // sent an untyped image as PNG, and the provider reads the bytes.
  const mimeType = !part.mimeType || part.mimeType === 'application/octet-stream' ? 'image/png' : part.mimeType;
  if (part.url !== undefined && !/^https:\/\//i.test(part.url)) return 'URL scheme';
  if (mimeType === 'application/pdf') {
    return part.url !== undefined
      ? { type: 'input_file', file_url: part.url }
      : { type: 'input_file', filename: 'document.pdf', file_data: `data:application/pdf;base64,${part.data}` };
  }
  return { type: 'input_image', image_url: part.url ?? `data:${mimeType};base64,${part.data}` };
}

/** The replayable reasoning items `replay`'s adapter wrote on a part. */
function replayedItems(part: Part, replay: ReasoningReplay): WireItem[] {
  const payload = providerStateOf(part, replay.provider, REASONING_STATE_KIND, replay.model)?.payload;
  return Array.isArray(payload) ? payload.filter(isReplayableReasoning) : [];
}

/**
 * A conversation as Responses API `input` items and `instructions`.
 *
 * With `replay`, the reasoning items that provider's adapter wrote for that
 * model (providerState, ADR 0046) are sent back verbatim, immediately before
 * their part's item, on the assistant messages of the current turn's tool
 * loop only (currentTurnStart). An assistant message that replays keeps the
 * model's order of text and calls, so each run of reasoning items is
 * followed by the item it preceded; one that does not puts its calls before
 * its text, as the ADK path always built it.
 */
export function responsesInput(request: Pick<ModelRequest, 'system' | 'messages'>, replay?: ReasoningReplay): ResponsesInput {
  const system: string[] = request.system ? [request.system] : [];
  const input: WireItem[] = [];
  const droppedBlobs: string[] = [];
  const turnStart = replay ? currentTurnStart(request.messages) : request.messages.length;

  for (const [index, message] of request.messages.entries()) {
    if (message.role === 'system') {
      const text = message.parts
        .filter((p) => p.text)
        .map((p) => p.text)
        .join('\n');
      if (text) system.push(text);
      continue;
    }

    const role = message.role === 'assistant' ? 'assistant' : 'user';
    const content: WireItem[] = [];
    const flush = () => {
      if (content.length > 0) input.push({ role, content: content.splice(0) });
    };
    const replayHere = role === 'assistant' && index > turnStart ? replay : undefined;
    let ordered = false;

    for (const part of message.parts as Part[]) {
      const items = replayHere ? replayedItems(part, replayHere) : [];
      if (items.length > 0) {
        flush();
        input.push(...items);
        ordered = true;
      }
      switch (part.type) {
        case 'thinking':
          // Display only: a thinking part's text never goes back to a model.
          break;
        case 'text':
          if (part.text) content.push({ type: role === 'assistant' ? 'output_text' : 'input_text', text: part.text });
          break;
        case 'blob': {
          if (role !== 'user') break;
          const item = blobItem(part);
          if (typeof item === 'string') droppedBlobs.push(item);
          else content.push(item);
          break;
        }
        case 'toolCall':
          if (ordered) flush();
          input.push({ type: 'function_call', call_id: part.id, name: part.name, arguments: JSON.stringify(part.args ?? {}) });
          break;
        case 'toolResult':
          input.push({ type: 'function_call_output', call_id: part.id, output: resultJson(part) });
          break;
      }
    }
    flush();
  }

  return { ...(system.length > 0 ? { instructions: system.join('\n\n') } : {}), input, droppedBlobs };
}

/** The request's client-side tools as Responses function tools; a strict one sends the strict form of its schema. */
export function responsesFunctionTools(request: Pick<ModelRequest, 'tools'>): WireItem[] {
  return (request.tools ?? []).map((tool) => ({
    type: 'function',
    name: tool.name,
    description: tool.description,
    parameters: tool.strict ? toContractJsonSchema(tool.parameters, { strict: true }) : tool.parameters,
    strict: tool.strict === true,
  }));
}

/** The request's tool choice on the wire; absent leaves the provider's default (`auto`). */
function toolChoiceOf(request: ModelRequest): unknown {
  const choice = request.toolChoice;
  if (choice === undefined) return undefined;
  return typeof choice === 'string' ? choice : { type: 'function', name: choice.name };
}

/** The native tools a request sends, the ones it drops, and the span flags they set. */
export interface NativeToolPlan {
  tools: WireItem[];
  dropped: NativeTool[];
  attributes: Record<string, boolean>;
}

// ── Streaming and server-side tools ─────────────────────────────────────────

/** One Responses SSE event as a displayable delta, or null for events that carry none. Calls are never delta-streamed. */
export function streamEventDelta(ev: any): { thought: boolean; text: string } | null {
  if (!ev || typeof ev !== 'object') return null;
  if (ev.type === 'response.output_text.delta' && typeof ev.delta === 'string') {
    return { thought: false, text: ev.delta };
  }
  if (ev.type === 'response.reasoning_summary_text.delta' && typeof ev.delta === 'string') {
    return { thought: true, text: ev.delta };
  }
  return null;
}

/**
 * One tool call the vendor ran on its own side inside a single Responses
 * call. It never comes back as a toolCall, so without this record a searched
 * answer and a recalled one look identical in a trace.
 */
export interface ServerToolCall {
  name: string;
  args: Record<string, unknown>;
  status?: string;
  /** URLs the vendor reports the call returned (web search only). */
  sources?: string[];
}

/**
 * The server-side tool calls in a Responses `output` array. Two shapes,
 * both verified against a live xAI response (2026-09-25):
 *   web_search_call   → { status, action: { type:'search', query, sources:[{url}] } }
 *   custom_tool_call  → { name:'x_keyword_search'|'x_semantic_search', input:'<json>', status }
 * Any other `*_call` item (code_interpreter_call, file_search_call…) is
 * recorded by its type with its `action` as args. `custom_tool_call` is
 * server-side here because this adapter never declares a client custom tool.
 */
export function extractServerToolCalls(output: unknown): ServerToolCall[] {
  const calls: ServerToolCall[] = [];
  for (const item of Array.isArray(output) ? output : []) {
    const type = item?.type;
    if (typeof type !== 'string' || type === 'function_call') continue;
    if (type === 'custom_tool_call') {
      let args: Record<string, unknown>;
      try {
        args = JSON.parse(item.input ?? '{}');
      } catch {
        args = { raw: item.input };
      }
      calls.push({ name: String(item.name ?? 'custom_tool'), args, status: item.status });
    } else if (type.endsWith('_call')) {
      const { sources, ...args } = item.action ?? {};
      const urls = Array.isArray(sources) ? sources.map((s: any) => s?.url).filter((u: unknown) => typeof u === 'string') : [];
      calls.push({
        name: type.slice(0, -'_call'.length),
        args,
        status: item.status,
        ...(urls.length > 0 ? { sources: urls } : {}),
      });
    }
  }
  return calls;
}

/** xAI's server-side tool counters off `usage` (num_server_side_tools_used + server_side_tool_usage_details), non-zero entries only; {} for OpenAI. */
export function serverToolUsage(usage: any): Record<string, number> {
  const out: Record<string, number> = {};
  if (typeof usage?.num_server_side_tools_used === 'number') out.total = usage.num_server_side_tools_used;
  for (const [k, v] of Object.entries(usage?.server_side_tool_usage_details ?? {})) {
    if (typeof v === 'number' && v > 0) out[k] = v;
  }
  return out;
}

/** What a final's response said about the tools the vendor ran on its own side. */
export interface ResponsesServerTools {
  calls: ServerToolCall[];
  usage: Record<string, number>;
}

/** Keyed by the final object the adapter yielded; nothing else holds the record. */
const SERVER_TOOLS = new WeakMap<FinalModelResponse, ResponsesServerTools>();

/**
 * The server-side tool calls and counters behind a final response a
 * Responses adapter yielded, or undefined when it reported none. The
 * contract has no field for them (only their queries, as grounding); GptLlm
 * writes them on the ADK event's customMetadata, where the ledger counts
 * them (lib/observability/tracer.ts, serverToolEvents).
 */
export function responsesServerTools(response: ModelResponse): ResponsesServerTools | undefined {
  return response.partial ? undefined : SERVER_TOOLS.get(response);
}

// ── Usage, grounding, failures ───────────────────────────────────────────────

const count = (n: unknown): number | undefined => (typeof n === 'number' && Number.isFinite(n) ? n : undefined);

/**
 * The Responses usage under the contract's meanings. Both vendors already
 * count the reasoning inside `output_tokens` and the cached input inside
 * `input_tokens` (a live grok-4.7 usage: 56,765 in + 1,247 out = 58,012
 * total, 943 of the output reasoning), so the counts carry over as they are.
 */
export function responsesUsage(usage: any): Usage | undefined {
  if (!isPlainObject(usage)) return undefined;
  const input = count(usage.input_tokens);
  const output = count(usage.output_tokens);
  if (input === undefined && output === undefined) return undefined;
  const thinking = count((usage.output_tokens_details as Json | undefined)?.reasoning_tokens);
  const cached = count((usage.input_tokens_details as Json | undefined)?.cached_tokens);
  return {
    inputTokens: input ?? 0,
    outputTokens: output ?? 0,
    ...(thinking !== undefined ? { thinkingTokens: thinking } : {}),
    ...(cached !== undefined ? { cacheReadTokens: cached } : {}),
  };
}

/** A code-point offset into `text` as a UTF-16 offset (the API's indices count characters). */
function utf16Offset(text: string, codePoints: number): number {
  let units = 0;
  let seen = 0;
  for (const ch of text) {
    if (seen >= codePoints) break;
    units += ch.length;
    seen++;
  }
  return units;
}

/** The queries a server-side call ran: web search's `queries` (or its older `query`), X search's `query`. */
function queriesOf(item: WireItem): SearchQuery[] {
  if (item?.type === 'web_search_call') {
    const action = item.action ?? {};
    const queries: unknown[] = Array.isArray(action.queries) && action.queries.length > 0 ? action.queries : [action.query];
    return queries.filter((q): q is string => typeof q === 'string' && q.length > 0).map((query) => ({ tool: 'web_search', query }));
  }
  if (item?.type === 'custom_tool_call' && (item.name === 'x_keyword_search' || item.name === 'x_semantic_search')) {
    try {
      const query = JSON.parse(item.input ?? '{}')?.query;
      return typeof query === 'string' && query ? [{ tool: 'x_search', query }] : [];
    } catch {
      return [];
    }
  }
  return [];
}

/**
 * What decides whether a failure a stream reported may succeed on another
 * attempt: an HTTP status when the event carries one, else its error code or
 * type. These codes are a server fault or a rate limit (OpenAI's
 * ResponseError codes `server_error`, `rate_limit_exceeded` and
 * `vector_store_timeout`); every other code is the request's own fault.
 */
const RETRYABLE_STREAM_ERRORS: ReadonlySet<string> = new Set(['server_error', 'rate_limit_exceeded', 'vector_store_timeout']);

/**
 * The retry verdict for a stream failure: a `response.failed` event (its
 * `response.error`), an `error` event, or the APIError the SDK throws for an
 * SSE frame named `error` (its `error` body). Retryable when the event names a
 * status lib/models/retry.ts retries, or one of the codes above; otherwise
 * not, which is also what an event that says nothing gets.
 */
export function streamErrorDecision(event: unknown): RetryDecision {
  const ev = isPlainObject(event) ? event : {};
  const candidates = [ev, isPlainObject(ev.response) ? ev.response.error : undefined, ev.error].filter(isPlainObject);
  for (const c of candidates) {
    const status = count(c.status) ?? (typeof c.code === 'number' ? c.code : undefined);
    if (status !== undefined && status >= 100 && status < 600) return statusDecision(status);
  }
  const names = candidates.flatMap((c) => [c.code, c.type]).filter((n): n is string => typeof n === 'string');
  return { retryable: names.some((n) => RETRYABLE_STREAM_ERRORS.has(n)) };
}

/** Removes the key in use from a message; errorText already removed key-shaped text. */
function scrub(message: string, secret: string | undefined): string {
  return secret ? message.split(secret).join('[redacted]') : message;
}

function failed(code: ModelErrorCode, message: string, decision: RetryDecision = { retryable: false }): FinalModelResponse {
  const error: ModelError = { code, message, retryable: decision.retryable, ...(decision.status !== undefined ? { status: decision.status } : {}) };
  return { partial: false, parts: [], finishReason: 'error', error };
}

// ── Abort ────────────────────────────────────────────────────────────────────

/** Rejects as soon as `signal` aborts, so a stalled SDK call never holds the caller. */
function abortable<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return promise;
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new Error('aborted'));
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (v) => {
        signal.removeEventListener('abort', onAbort);
        resolve(v);
      },
      (e) => {
        signal.removeEventListener('abort', onAbort);
        reject(e);
      },
    );
  });
}

/**
 * Iterates `source` until `signal` aborts, then throws at once: the SDK would
 * end an aborted stream quietly, which would read as a complete answer.
 */
async function* untilAborted<T>(source: AsyncIterable<T>, signal: AbortSignal | undefined): AsyncGenerator<T, void> {
  const iterator = source[Symbol.asyncIterator]();
  let done = false;
  try {
    for (;;) {
      const next = await abortable(iterator.next(), signal);
      if (next.done) {
        done = true;
        return;
      }
      yield next.value;
    }
  } finally {
    if (!done) iterator.return?.(undefined)?.catch?.(() => {});
  }
}

// ── The adapter ──────────────────────────────────────────────────────────────

export interface GptAdapterOptions {
  /** The model id as the YAML names it. */
  model: string;
  /** A key that wins over the endpoint's and the environment's: a caller's own, or the credentials plug point's. */
  apiKey?: string;
  /** Where requests go (ADR 0023): OpenAI's API, a proxy at its base URL, or Azure OpenAI. Default `endpointFromEnv('openai')`. */
  endpoint?: ProviderEndpoint;
}

/** The key (or token source) and base URL for the client, or why there is none. */
type ClientAuth = { apiKey: string | (() => Promise<string>); baseURL?: string } | { error: string };

/** The thinking partial and the final a Responses reply becomes. */
export interface ResponsesFinal {
  thinking?: PartialModelResponse;
  final: FinalModelResponse;
}

/**
 * GPT on OpenAI's Responses API (or Azure OpenAI, or a proxy at
 * OPENAI_BASE_URL), as a contract ModelAdapter. The protected hooks are what
 * another vendor of the same wire overrides: GrokAdapter changes the
 * provider id, the endpoint, the key, the client options, the reasoning
 * field, which ids replay reasoning, and the native tools.
 */
export class GptAdapter implements ModelAdapter {
  readonly provider: string = 'openai';
  readonly model: string;
  /** The vendor's name in a message for a person. */
  protected readonly label: string = 'OpenAI';
  protected readonly apiKey: string | undefined;
  readonly #endpoint: ProviderEndpoint | undefined;
  readonly #warned = new Set<string>();

  constructor(options: GptAdapterOptions) {
    this.model = options.model;
    this.apiKey = options.apiKey;
    this.#endpoint = options.endpoint;
  }

  // ── Vendor hooks ───────────────────────────────────────────────────────────

  /** Where requests go. Default the constructor's endpoint, else the environment's (`OPENAI_PLATFORM`). */
  protected endpoint(): ProviderEndpoint {
    return this.#endpoint ?? endpointFromEnv('openai');
  }

  /** SDK baseURL override; undefined is the vendor's default (api.openai.com). */
  protected baseURL(): string | undefined {
    return undefined;
  }

  protected apiKeyFromEnv(): string | undefined {
    return process.env.OPENAI_API_KEY;
  }

  protected missingKeyMessage(): string {
    return 'OPENAI_API_KEY is not set in environment.';
  }

  /** Extra options for the OpenAI SDK client constructor. */
  protected clientOptions(): Record<string, unknown> {
    return {};
  }

  /**
   * The `reasoning` request field for one setting (ADR 0047), or undefined to
   * send none. OpenAI's reasoning ids ask for summaries, plus the effort in
   * that model's own word (`reasoningConfig`: `none` is `minimal` on the
   * first GPT-5 generation and `low` on the o-series). Other ids: nothing. A
   * 400 on the field is retried once without it.
   */
  reasoningParam(setting: ReasoningSetting | undefined, model: string = this.model): Record<string, unknown> | undefined {
    if (!isOpenAiReasoningModel(model)) return undefined;
    return { summary: 'auto', ...(setting !== undefined ? { effort: reasoningConfig(model, setting).reasoningEffort } : {}) };
  }

  /**
   * Whether this id carries its reasoning across the steps of a tool loop
   * (ADR 0050): its requests send `store: false` and ask for encrypted
   * reasoning, its finals write the reasoning items on the part after them,
   * and its requests replay them. OpenAI's reasoning ids.
   */
  replaysReasoning(model: string = this.model): boolean {
    return isOpenAiReasoningModel(model);
  }

  /** Whether `temperature` and `top_p` are sent: OpenAI's reasoning ids reject them. */
  protected acceptsSampling(model: string): boolean {
    return !isOpenAiReasoningModel(model);
  }

  /**
   * The vendor's own tool objects for the request's native tools. OpenAI's
   * `web_search` is sent bare on OpenAI's API and a direct proxy, and not on
   * Azure OpenAI (lib/models/endpoints.ts). Every other native tool is dropped.
   */
  nativeToolPlan(request: Pick<ModelRequest, 'nativeTools'>, endpoint: ProviderEndpoint = { platform: 'direct' }): NativeToolPlan {
    const plan: NativeToolPlan = { tools: [], dropped: [], attributes: {} };
    for (const tool of new Set(request.nativeTools ?? [])) {
      if (tool === 'web_search' && nativeSearchOn('openai', endpoint.platform)) {
        plan.tools.push({ type: 'web_search' });
        plan.attributes['llm.web_search.native'] = true;
      } else {
        if (tool === 'web_search') plan.attributes['llm.web_search.omitted'] = true;
        plan.dropped.push(tool);
      }
    }
    return plan;
  }

  /** The warning for a native tool this path does not send, once per adapter and tool. */
  protected droppedToolWarning(tool: NativeTool, model: string, endpoint: ProviderEndpoint): string {
    return tool === 'web_search' && endpoint.platform === 'azure'
      ? `⚠ web_search is not sent to ${model} on Azure OpenAI; the agent answers without it (use web_extract).`
      : `⚠ ${tool} is not an ${this.label} tool; ${model} runs without it.`;
  }

  // ── Generation ─────────────────────────────────────────────────────────────

  async *generate(request: ModelRequest): AsyncGenerator<ModelResponse, void> {
    const model = request.model || this.model;
    const signal = request.signal;
    if (signal?.aborted) {
      yield this.aborted();
      return;
    }

    let endpoint: ProviderEndpoint;
    try {
      endpoint = this.endpoint();
    } catch (err) {
      yield failed('ENDPOINT_MISCONFIGURED', errorText(err));
      return;
    }
    const auth = this.clientAuth(endpoint);
    if ('error' in auth) {
      yield failed(endpoint.platform === 'direct' ? 'MISSING_API_KEY' : 'ENDPOINT_MISCONFIGURED', auth.error);
      return;
    }

    // A dynamic import, so the engine boots without the openai SDK for
    // users of other providers.
    let OpenAI: any;
    try {
      const mod: any = await import('openai');
      OpenAI = mod.default ?? mod.OpenAI;
    } catch {
      yield failed('SDK_NOT_INSTALLED', 'The openai package is not installed. Run: npm install openai');
      return;
    }
    const secret = typeof auth.apiKey === 'string' ? auth.apiKey : undefined;
    let client: any;
    try {
      client = new OpenAI({ apiKey: auth.apiKey, ...(auth.baseURL ? { baseURL: auth.baseURL } : {}), ...this.clientOptions() });
    } catch (err) {
      yield failed('ENDPOINT_MISCONFIGURED', scrub(`The ${this.label} client failed to build: ${errorText(err)}`, secret));
      return;
    }

    try {
      const body = this.requestBody(request, model, endpoint);
      if (request.stream === true) {
        yield* this.#stream(client, body, model, signal, secret);
        return;
      }
      const reply = await abortable(this.#create(client, body, signal), signal);
      const { thinking, final } = this.finalOf(reply, model);
      if (thinking) yield thinking;
      yield final;
    } catch (err) {
      yield signal?.aborted ? this.aborted() : this.#failure(err, secret);
    }
  }

  /**
   * The Responses request body for a ModelRequest on one endpoint. It marks
   * the open span with what the request sends and drops, and warns once per
   * dropped native tool.
   */
  requestBody(request: ModelRequest, model: string = request.model || this.model, endpoint: ProviderEndpoint = { platform: 'direct' }): Record<string, unknown> {
    const replays = this.replaysReasoning(model);
    const { instructions, input, droppedBlobs } = responsesInput(request, replays ? { provider: this.provider, model } : undefined);
    if (droppedBlobs.length > 0) setLlmSpanAttribute('llm.image.dropped', [...new Set(droppedBlobs)].join(','));

    const native = this.nativeToolPlan(request, endpoint);
    for (const [key, value] of Object.entries(native.attributes)) setLlmSpanAttribute(key, value);
    if (native.dropped.length > 0) {
      setLlmSpanAttribute('llm.capability.dropped', native.dropped.join(','));
      for (const tool of native.dropped) {
        if (this.#warned.has(tool)) continue;
        this.#warned.add(tool);
        console.warn(this.droppedToolWarning(tool, model, endpoint));
      }
    }
    const tools = [...responsesFunctionTools(request), ...native.tools];
    const toolChoice = tools.length > 0 ? toolChoiceOf(request) : undefined;
    const sampling = request.sampling ?? {};
    const sampled = this.acceptsSampling(model);
    const reasoning = this.reasoningParam(request.reasoning, model);

    return {
      model: platformModel(endpoint, model),
      input,
      ...(instructions ? { instructions } : {}),
      ...(tools.length > 0 ? { tools } : {}),
      ...(toolChoice !== undefined ? { tool_choice: toolChoice } : {}),
      ...(sampling.maxOutputTokens !== undefined ? { max_output_tokens: sampling.maxOutputTokens } : {}),
      ...(sampling.temperature !== undefined && sampled ? { temperature: sampling.temperature } : {}),
      ...(sampling.topP !== undefined && sampled ? { top_p: sampling.topP } : {}),
      ...(request.outputSchema
        ? {
            text: {
              format: {
                type: 'json_schema',
                name: 'response',
                // Strict: the API enforces the exact property names, so a
                // judge rubric's fields arrive as declared, never renamed.
                strict: true,
                schema: toContractJsonSchema(request.outputSchema, { strict: true }),
              },
            },
          }
        : request.outputFormat === 'json'
          ? { text: { format: { type: 'json_object' } } }
          : {}),
      ...(reasoning ? { reasoning } : {}),
      // ADR 0050: the vendor keeps nothing, and returns the reasoning
      // encrypted so the next step of the tool loop can send it back.
      ...(replays ? { store: false, include: [ENCRYPTED_REASONING] } : {}),
    };
  }

  /**
   * A Responses reply as the thinking partial (its reasoning summaries, unless
   * `skipThoughts` because they streamed) and the final. Each run of
   * replayable reasoning items rides, verbatim, as providerState on the part
   * made from the output item right after it: a function call, or the first
   * text of a message. A run that anything else follows (a server-side tool
   * call, a message with no text, nothing) is dropped. A second message item
   * starts on a new paragraph, so narration between searches never runs into
   * the answer. Marks the span with the vendor's server-side tool counters.
   */
  finalOf(reply: any, model: string = this.model, opts: { skipThoughts?: boolean } = {}): ResponsesFinal {
    const output: WireItem[] = Array.isArray(reply?.output) ? reply.output : [];

    let thinking: PartialModelResponse | undefined;
    if (!opts.skipThoughts) {
      const summaries = output
        .filter((item) => item?.type === 'reasoning')
        .flatMap((item) => (Array.isArray(item.summary) ? item.summary : []))
        .map((s: any) => s?.text)
        .filter((t): t is string => typeof t === 'string' && t.length > 0);
      if (summaries.length > 0) thinking = { partial: true, parts: [{ type: 'thinking', text: summaries.join('\n\n') }] };
    }

    const parts: OutputPart[] = [];
    const citations: Citation[] = [];
    const searchQueries: SearchQuery[] = [];
    const carries = this.replaysReasoning(model);
    let run: WireItem[] = [];
    let offset = 0;
    let messageItems = 0;
    const state = (): ProviderState => ({ provider: this.provider, kind: REASONING_STATE_KIND, model, payload: run });
    const emit = (part: OutputPart) => {
      parts.push(run.length > 0 ? { ...part, providerState: state() } : part);
      run = [];
    };

    for (const [n, item] of output.entries()) {
      if (item?.type === 'reasoning') {
        if (carries && isReplayableReasoning(item)) run.push(item);
        continue;
      }
      searchQueries.push(...queriesOf(item));
      if (item?.type === 'message') {
        const sep = messageItems++ > 0 ? '\n\n' : '';
        let first = true;
        for (const c of Array.isArray(item.content) ? item.content : []) {
          if (c?.type !== 'output_text' || !c.text) continue;
          const text: string = first ? sep + c.text : c.text;
          const base = offset + (first ? sep.length : 0);
          for (const a of Array.isArray(c.annotations) ? c.annotations : []) {
            if (a?.type !== 'url_citation' || typeof a.url !== 'string') continue;
            const start = count(a.start_index);
            const end = count(a.end_index);
            citations.push({
              url: a.url,
              ...(typeof a.title === 'string' && a.title ? { title: a.title } : {}),
              ...(start !== undefined && end !== undefined ? { start: base + utf16Offset(c.text, start), end: base + utf16Offset(c.text, end) } : {}),
            });
          }
          if (first) emit({ type: 'text', text });
          else parts.push({ type: 'text', text });
          offset += text.length;
          first = false;
        }
      } else if (item?.type === 'function_call') {
        let args: unknown;
        try {
          args = JSON.parse(item.arguments ?? '{}');
        } catch {
          args = undefined;
        }
        emit({
          type: 'toolCall',
          id: typeof item.call_id === 'string' && item.call_id ? item.call_id : `call_${n}`,
          name: String(item.name ?? ''),
          args: isPlainObject(args) ? args : { raw: item.arguments },
        });
      }
      run = [];
    }

    const usage = responsesUsage(reply?.usage);
    const serverCalls = extractServerToolCalls(output);
    const serverUsage = serverToolUsage(reply?.usage);
    for (const [k, v] of Object.entries(serverUsage)) setLlmSpanAttribute(`llm.server_tools.${k}`, v);
    if (typeof reply?.usage?.cost_in_usd_ticks === 'number') setLlmSpanAttribute('llm.cost.vendor_usd_ticks', reply.usage.cost_in_usd_ticks);

    const grounding: Grounding = {
      ...(citations.length > 0 ? { citations } : {}),
      ...(searchQueries.length > 0 ? { searchQueries } : {}),
    };
    const final: FinalModelResponse = {
      partial: false,
      parts,
      finishReason: finishReasonOf(reply, parts),
      ...(usage ? { usage } : {}),
      ...(Object.keys(grounding).length > 0 ? { grounding } : {}),
    };
    if (serverCalls.length > 0 || Object.keys(serverUsage).length > 0) SERVER_TOOLS.set(final, { calls: serverCalls, usage: serverUsage });
    return { ...(thinking ? { thinking } : {}), final };
  }

  /** The final for a canceled call: never retryable, so no fallback answers a cancellation. */
  protected aborted(): FinalModelResponse {
    return failed(`${this.provider.toUpperCase()}_ERROR`, `The ${this.label} request was aborted.`);
  }

  // ── Transport ──────────────────────────────────────────────────────────────

  /**
   * The key (or token source) and base URL for the client, or why there is
   * none. Azure takes AZURE_OPENAI_API_KEY (or the credentials plug point's
   * key or token), else an Entra ID token from @azure/identity.
   */
  protected clientAuth(e: ProviderEndpoint): ClientAuth {
    if (e.platform === 'azure') {
      if (!e.baseURL) return { error: 'Azure OpenAI: AZURE_OPENAI_ENDPOINT is not set.' };
      const key = this.apiKey || e.apiKey;
      return { apiKey: key || e.token || entraTokenSource(), baseURL: e.baseURL };
    }
    const key = this.apiKey || e.apiKey || this.apiKeyFromEnv();
    if (!key) return { error: this.missingKeyMessage() };
    const baseURL = this.baseURL() ?? e.baseURL;
    return { apiKey: key, ...(baseURL ? { baseURL } : {}) };
  }

  /**
   * responses.create with the guarded reasoning retry: when the vendor
   * refuses a request that carries reasoning additions with a 400 (an id the
   * pattern wrongly calls a reasoning model, or a replayed item it refused),
   * the reasoning field, the encrypted-reasoning include and the replayed
   * items are dropped and the request is sent once more. `store: false` stays.
   */
  async #create(client: any, body: Record<string, unknown>, signal: AbortSignal | undefined): Promise<any> {
    const options = signal ? { signal } : undefined;
    try {
      return await client.responses.create(body, options);
    } catch (err: any) {
      if (err?.status === 400 && (body.reasoning || body.include) && !signal?.aborted) {
        delete body.reasoning;
        delete body.include;
        body.input = (body.input as WireItem[]).filter((i) => i?.type !== 'reasoning');
        setLlmSpanAttribute('llm.retry_without_reasoning', true);
        return await client.responses.create(body, options);
      }
      throw err;
    }
  }

  /**
   * SSE streaming: text and summary deltas as partials, then the reply that
   * `response.completed` carries as the final, through finalOf. Function
   * calls are never delta-streamed (both vendors deliver them whole).
   */
  async *#stream(
    client: any,
    body: Record<string, unknown>,
    model: string,
    signal: AbortSignal | undefined,
    secret: string | undefined,
  ): AsyncGenerator<ModelResponse, void> {
    const events: AsyncIterable<any> = await abortable(this.#create(client, { ...body, stream: true }, signal), signal);
    let completed: any;
    let streamedThoughts = false;
    const text: string[] = [];

    for await (const ev of untilAborted(events, signal)) {
      const delta = streamEventDelta(ev);
      if (delta) {
        if (delta.thought) streamedThoughts = true;
        else text.push(delta.text);
        yield { partial: true, parts: [delta.thought ? { type: 'thinking', text: delta.text } : { type: 'text', text: delta.text }] };
        continue;
      }
      if (ev?.type === 'response.completed' && ev.response) {
        completed = ev.response;
      } else if (ev?.type === 'response.failed' || ev?.type === 'error') {
        const message = ev?.response?.error?.message ?? ev?.message ?? 'response stream failed';
        yield failed(`${this.provider.toUpperCase()}_STREAM_ERROR`, scrub(errorText(message), secret), streamErrorDecision(ev));
        return;
      }
    }

    if (completed) {
      const { thinking, final } = this.finalOf(completed, model, { skipThoughts: streamedThoughts });
      if (thinking) yield thinking;
      yield final;
      return;
    }
    // The stream ended without response.completed: the streamed text is the
    // answer, so the turn still stores a complete event.
    const answer = text.join('');
    yield { partial: false, parts: answer ? [{ type: 'text', text: answer }] : [], finishReason: 'stop' };
  }

  /**
   * The final for a call that threw: `<PROVIDER>_ERROR`, with the retry
   * policy's verdict. The SDK throws an SSE frame named `error` as an APIError
   * with no HTTP status; its body then decides (streamErrorDecision).
   */
  #failure(err: unknown, secret: string | undefined): FinalModelResponse {
    let decision = errorDecision(err);
    const body = (err as { error?: unknown } | undefined)?.error;
    if (!decision.retryable && decision.status === undefined && (err as { name?: string })?.name !== 'AbortError' && isPlainObject(body)) {
      decision = streamErrorDecision(body);
    }
    return failed(`${this.provider.toUpperCase()}_ERROR`, scrub(errorText(err), secret), decision);
  }
}

/** Why the model stopped, in the contract's words. */
function finishReasonOf(reply: any, parts: OutputPart[]): FinishReason {
  if (parts.some((p) => p.type === 'toolCall')) return 'tool_call';
  if (reply?.status !== 'incomplete') return 'stop';
  const reason = reply?.incomplete_details?.reason;
  return reason === 'max_output_tokens' ? 'max_tokens' : reason === 'content_filter' ? 'content_filter' : 'other';
}
