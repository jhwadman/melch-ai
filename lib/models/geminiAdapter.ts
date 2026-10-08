/**
 * lib/models/geminiAdapter.ts — Gemini behind the engine's own model
 * contract (lib/models/contract.ts, ADR 0048), on @google/genai directly.
 *
 * WHY this file exists:
 *   Gemini runs today through ADK's own Gemini class, wrapped as
 *   TracedGemini (lib/models/tracedGemini.ts). The native runtime (ADR 0045)
 *   needs Gemini as a contract ModelAdapter that shapes its own requests,
 *   aggregates its own stream and reports its own failures, with no ADK in
 *   the path. This is that adapter. resolveAdapter (lib/models/registry.ts)
 *   returns it only when asked (GEMINI_ADAPTER=engine) until gate G3.
 *
 * THE MAPPING is the Gemini table of wiki/models/model-contract.md;
 * wiki/models/gemini-adapter.md records the choices made inside it:
 *   - Schemas go as written, lowercase JSON Schema, in `parametersJsonSchema`
 *     and `responseJsonSchema`. Nothing converts them to Gemini's uppercase
 *     Schema dialect.
 *   - `outputFormat: 'json'` without a schema is `responseMimeType:
 *     'application/json'` alone, Gemini's JSON mode (ADR 0061).
 *   - `reasoning` maps through lib/compile.ts's reasoningConfig (ADR 0047),
 *     for this adapter's model, with `includeThoughts` unless it is `none`.
 *   - A thought signature (ADR 0046) is written as providerState on the
 *     output part it arrived on. One on a thought or an empty text part
 *     moves to the next part. Signatures are replayed on the same part,
 *     within the current turn, for this model only.
 *   - Parts the contract has no type for (code execution's `executableCode`
 *     and `codeExecutionResult`, server-side `toolCall` and `toolResponse`)
 *     are carried whole as providerState of kind `carried_parts` on the next
 *     output part, and replayed before it within the current turn (ADR 0065).
 *   - A function call Gemini returns without an id gets
 *     `adk-<conversation length>-<call index>-<name>`. Ids that start with
 *     `adk-` (the engine's) or `genai-noid-` (the genai mapping's) never go
 *     on the wire.
 *   - `includeServerSideToolInvocations` goes with native tools beside
 *     function declarations, on the Gemini API only: the SDK refuses it for
 *     Vertex AI.
 *   - Grounding is the search queries, and the cited pages with the answer
 *     span each supports; urlContext's retrieved pages are cited too.
 *
 * THE ADAPTER RULES (contract.ts header) as this adapter keeps them:
 *   - Errors are finals, never throws: a thrown call is GEMINI_ERROR with its
 *     status and lib/models/retry.ts's `retryable`; a blocked prompt or an
 *     empty or withheld candidate carries Gemini's own reason as the code.
 *   - The abort signal is the request's alone (ADR 0053: the caller passes
 *     the turn's). It goes on the request config (the SDK aborts its fetch)
 *     and also ends the iteration at once, whatever the transport does.
 *   - Transient failures are retried here, only before the first chunk.
 */

import { FunctionCallingConfigMode, GoogleGenAI } from '@google/genai';
import type {
  Content,
  GenerateContentConfig,
  GenerateContentParameters,
  GenerateContentResponse,
  GenerateContentResponseUsageMetadata,
  GoogleGenAIOptions,
  GroundingMetadata,
  Part as WirePart,
  Segment,
  ThinkingConfig,
  Tool,
  ToolConfig,
  UrlContextMetadata,
} from '@google/genai';

import type {
  AssistantMessage,
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
  ReasoningSetting,
  TextPart,
  ThinkingPart,
  ToolResultPart,
  Usage,
} from './contract.ts';
import { endpointFromEnv, endpointProblems, platformModel } from './endpoints.ts';
import type { ProviderEndpoint } from './endpoints.ts';
import {
  CARRIED_PARTS_KIND,
  GEMINI_PROVIDER,
  GENAI_PART_KIND,
  MINTED_CALL_ID_PREFIX,
  PLACEHOLDER_THOUGHT_SIGNATURE,
  THOUGHT_SIGNATURE_KIND,
  isCarriedWirePart,
} from './geminiState.ts';
import { currentTurnStart, providerStateOf } from './providerState.ts';
import type { ProviderState } from './providerState.ts';
import { classifyError, errorStatus, retryUntilFirstYield } from './retry.ts';
import { reasoningConfig } from './reasoning.ts';
import { setLlmSpanAttribute } from '../observability/tracer.ts';

/**
 * The provider id this adapter reports and writes its state under, and the
 * providerState kind for a Gemini thought signature (ADR 0046). Defined once
 * in lib/models/geminiState.ts, so the genai mapping spells them the same.
 */
export { GEMINI_PROVIDER, THOUGHT_SIGNATURE_KIND };

/**
 * The prefix of a call id the engine made (this adapter, or ADK before it).
 * Such an id is the engine's own and is left off the wire.
 */
export const ENGINE_CALL_ID_PREFIX = 'adk-';

/**
 * The providerState kind for Gemini parts the contract has no type for
 * (code execution and server-side tool invocations), carried whole on the
 * next output part (ADR 0065). The payload is a `CarriedParts`. Defined in
 * lib/models/geminiState.ts, so the genai mapping writes them back out as
 * the parts they were when an event is stored (ADR 0100).
 */
export { CARRIED_PARTS_KIND };

/** The payload of a `carried_parts` state. */
export interface CarriedParts {
  /** The genai parts that came before the output part, as Gemini sent them. */
  before: WirePart[];
  /** The output part's own thought signature, when it has one. */
  signature?: string;
}

/**
 * The thought signature Gemini documents for a function call that has no
 * real one: a call another provider or model made earlier in the current
 * turn (a mid-turn fallback). Gemini 3 rejects such a call without a
 * signature. Sent only when the adapter is built with `placeholderSignatures`
 * (default PLACEHOLDER_SIGNATURES_BY_DEFAULT, off) until the G3 live run
 * confirms it (ADR 0065).
 */
export { PLACEHOLDER_THOUGHT_SIGNATURE };

/** Off: no placeholder signature is sent unless the adapter is built to send it. */
export const PLACEHOLDER_SIGNATURES_BY_DEFAULT = false;

// ── The client ───────────────────────────────────────────────────────────────

/** The part of the @google/genai client this adapter calls. `GoogleGenAI` satisfies it. */
export interface GeminiClient {
  models: {
    generateContent(params: GenerateContentParameters): Promise<GenerateContentResponse>;
    generateContentStream(params: GenerateContentParameters): Promise<AsyncIterable<GenerateContentResponse>>;
  };
}

/** Builds a client from the options this adapter derives from its endpoint. */
export type GeminiClientFactory = (options: GoogleGenAIOptions) => GeminiClient;

const defaultClientFactory: GeminiClientFactory = (options) => new GoogleGenAI(options);

export interface GeminiAdapterOptions {
  /** The model id as the YAML names it. */
  model: string;
  /**
   * A Gemini API (AI Studio) key: a caller's own, or one the credentials plug
   * point returned. It wins over the endpoint's and the environment's, and is
   * never sent to Vertex AI.
   */
  apiKey?: string;
  /** Where requests go (ADR 0023). Default: `endpointFromEnv('gemini')`, read on the first call. */
  endpoint?: ProviderEndpoint;
  /** Builds the client. Default: `new GoogleGenAI(options)`. Tests inject a fake. */
  clientFactory?: GeminiClientFactory;
  /**
   * Send PLACEHOLDER_THOUGHT_SIGNATURE on the first function call of a
   * current-turn step that has no signature of this model's. Default
   * PLACEHOLDER_SIGNATURES_BY_DEFAULT (off).
   */
  placeholderSignatures?: boolean;
}

interface Connection {
  client: GeminiClient;
  endpoint: ProviderEndpoint;
  /** The key in use, so no message this adapter writes can carry it. */
  secret?: string;
}

// ── The adapter ──────────────────────────────────────────────────────────────

export class GeminiAdapter implements ModelAdapter {
  readonly provider = GEMINI_PROVIDER;
  readonly model: string;
  readonly #apiKey: string | undefined;
  readonly #endpoint: ProviderEndpoint | undefined;
  readonly #clientFactory: GeminiClientFactory;
  #connection: Connection | undefined;
  readonly #warned = new Set<string>();
  readonly #placeholderSignatures: boolean;

  constructor(options: GeminiAdapterOptions) {
    this.model = options.model;
    this.#apiKey = nonEmpty(options.apiKey);
    this.#endpoint = options.endpoint;
    this.#clientFactory = options.clientFactory ?? defaultClientFactory;
    this.#placeholderSignatures = options.placeholderSignatures ?? PLACEHOLDER_SIGNATURES_BY_DEFAULT;
  }

  async *generate(request: ModelRequest): AsyncGenerator<ModelResponse, void> {
    // The request's signal alone: the caller (the ADK shim, the native loop)
    // passes the turn's (ADR 0053).
    const signal = request.signal;
    const model = request.model || this.model;
    const reply = new ReplyBuilder(model, request.messages.length);
    if (signal?.aborted) {
      yield reply.aborted();
      return;
    }
    const connection = this.#connect();
    if ('code' in connection) {
      yield { partial: false, parts: [], finishReason: 'error', error: connection };
      return;
    }
    const stream = request.stream === true;
    try {
      const built = buildRequest(request, {
        model,
        wireModel: platformModel(connection.endpoint, model),
        signal,
        geminiApi: connection.endpoint.platform === 'direct',
        placeholderSignatures: this.#placeholderSignatures,
      });
      this.#report(built);
      const { client } = connection;
      const start = () => (stream ? streamOf(client, built.params) : responseOf(client, built.params));
      const chunks = retryUntilFirstYield(start, {
        signal,
        onRetry: ({ retries }) => setLlmSpanAttribute('llm.retries', retries),
      });
      for await (const chunk of untilAborted(chunks, signal)) {
        const deltas = reply.add(chunk);
        if (stream && deltas.length) yield { partial: true, parts: deltas };
      }
      if (!stream && reply.thinking.length) yield { partial: true, parts: reply.thinking };
      const final = reply.final(built.searchTool);
      if (reply.finishReason) setLlmSpanAttribute('llm.finish_reason', reply.finishReason);
      yield final;
    } catch (err) {
      if (signal?.aborted) {
        yield reply.aborted();
        return;
      }
      const status = errorStatus(err);
      if (status !== undefined) setLlmSpanAttribute('llm.http_status', status);
      yield reply.failed(err, connection.secret);
    }
  }

  /** The client for this adapter's endpoint, built once; or why it cannot be built. */
  #connect(): Connection | ModelError {
    if (this.#connection) return this.#connection;
    let endpoint: ProviderEndpoint;
    try {
      endpoint = this.#endpoint ?? endpointFromEnv('gemini');
    } catch (err) {
      return setupError('ENDPOINT_MISCONFIGURED', messageOf(err));
    }
    let options: GoogleGenAIOptions;
    let secret: string | undefined;
    if (endpoint.platform === 'vertex') {
      const problems = endpointProblems('gemini', endpoint);
      if (problems.length) return setupError('ENDPOINT_MISCONFIGURED', `Gemini on Vertex AI: ${problems.join('; ')}.`);
      // Google Application Default Credentials for the project and location.
      // No AI Studio key goes to Vertex AI, the caller's included.
      options = { vertexai: true, project: endpoint.project, location: endpoint.location };
    } else if (endpoint.platform === 'direct') {
      secret = this.#apiKey ?? nonEmpty(endpoint.apiKey) ?? envApiKey();
      if (!secret) {
        return setupError(
          'MISSING_API_KEY',
          'No Gemini API key: set GOOGLE_GENAI_API_KEY (or GEMINI_API_KEY), or GEMINI_PLATFORM=vertex for Vertex AI.',
        );
      }
      // vertexai: false keeps the SDK from switching to Vertex AI on its own
      // environment variables once the endpoint has chosen the Gemini API.
      options = { vertexai: false, apiKey: secret };
    } else {
      return setupError('ENDPOINT_MISCONFIGURED', `Gemini has no ${endpoint.platform} platform; use direct or vertex.`);
    }
    try {
      this.#connection = { client: this.#clientFactory(options), endpoint, secret };
    } catch (err) {
      return setupError('ENDPOINT_MISCONFIGURED', `The Gemini client failed to build: ${scrub(messageOf(err), secret)}`);
    }
    return this.#connection;
  }

  /** Marks the span with what the request carries and drops, and warns once per dropped tool. */
  #report(built: BuiltRequest): void {
    if (built.grounded) setLlmSpanAttribute('llm.web_search.native', true);
    if (!built.dropped.length) return;
    setLlmSpanAttribute('llm.capability.dropped', built.dropped.join(','));
    for (const tool of built.dropped) {
      if (this.#warned.has(tool)) continue;
      this.#warned.add(tool);
      console.warn(`⚠ ${tool} is not a Gemini tool; ${this.model} runs without it.`);
    }
  }
}

// ── Request ──────────────────────────────────────────────────────────────────

interface BuiltRequest {
  params: GenerateContentParameters;
  /** Native tools the request named that Gemini has no tool for. */
  dropped: NativeTool[];
  /** True when the request carries Google Search grounding. */
  grounded: boolean;
  /** The native tool a grounded answer's search queries are attributed to. */
  searchTool: NativeTool;
}

/** The native tools this adapter sends, and the Gemini tool each becomes. */
const NATIVE_TOOLS: Partial<Record<NativeTool, Tool>> = {
  web_search: { googleSearch: {} },
  google_search: { googleSearch: {} },
  url_context: { urlContext: {} },
  code_execution: { codeExecution: {} },
};

interface BuildOptions {
  /** The model id as the YAML names it: replay and reasoning are this model's. */
  model: string;
  /** The model id on the wire (`GEMINI_MODEL_MAP` applied). */
  wireModel: string;
  signal: AbortSignal | undefined;
  /** True on the Gemini API, false on Vertex AI. */
  geminiApi: boolean;
  placeholderSignatures: boolean;
}

function buildRequest(request: ModelRequest, options: BuildOptions): BuiltRequest {
  const { model, wireModel, signal } = options;
  const system = request.system ? [request.system] : [];
  const contents: Content[] = [];
  const turnStart = currentTurnStart(request.messages);
  request.messages.forEach((message, index) => {
    let parts: WirePart[];
    switch (message.role) {
      case 'system':
        for (const part of message.parts) if (part.text) system.push(part.text);
        return;
      case 'user':
        parts = message.parts.map((part) => (part.type === 'text' ? { text: part.text } : blobToWire(part)));
        break;
      case 'assistant': {
        const replay = index > turnStart;
        parts = assistantToWire(message, replay, model);
        if (replay && options.placeholderSignatures) withPlaceholderSignature(parts);
        break;
      }
      case 'tool':
        parts = message.parts.map(resultToWire);
        break;
    }
    // A content with no parts fails the whole request on Vertex AI.
    if (parts.length) contents.push({ role: message.role === 'assistant' ? 'model' : 'user', parts });
  });

  const config: GenerateContentConfig = {};
  if (system.length) config.systemInstruction = { parts: system.map((text) => ({ text })) };

  const tools: Tool[] = [];
  const declared = !!request.tools?.length;
  if (request.tools?.length) {
    tools.push({
      functionDeclarations: request.tools.map((t) => ({
        name: t.name,
        description: t.description,
        parametersJsonSchema: t.parameters,
      })),
    });
  }
  const named = [...new Set(request.nativeTools ?? [])];
  const dropped = named.filter((t) => !NATIVE_TOOLS[t]);
  const grounded = named.includes('web_search') || named.includes('google_search');
  if (grounded) tools.push({ googleSearch: {} });
  if (named.includes('url_context')) tools.push({ urlContext: {} });
  if (named.includes('code_execution')) tools.push({ codeExecution: {} });
  if (tools.length) config.tools = tools;
  const native = tools.length > (declared ? 1 : 0);

  let toolConfig = toolConfigFor(request);
  // Native tools beside function declarations: the response carries the
  // server-side invocations, as the ADK path asks on every Gemini agent
  // (lib/compile.ts). The SDK refuses the flag for Vertex AI.
  if (declared && native && options.geminiApi) toolConfig = { ...toolConfig, includeServerSideToolInvocations: true };
  if (toolConfig) config.toolConfig = toolConfig;

  if (request.outputSchema) {
    config.responseMimeType = 'application/json';
    config.responseJsonSchema = request.outputSchema;
  } else if (request.outputFormat === 'json') {
    // JSON mode: the MIME type alone (ADR 0061).
    config.responseMimeType = 'application/json';
  }

  if (request.reasoning !== undefined) {
    const thinking = thinkingConfigFor(model, request.reasoning);
    if (thinking) config.thinkingConfig = thinking;
  }

  const sampling = request.sampling;
  if (sampling?.temperature !== undefined) config.temperature = sampling.temperature;
  if (sampling?.topP !== undefined) config.topP = sampling.topP;
  if (sampling?.maxOutputTokens !== undefined) config.maxOutputTokens = sampling.maxOutputTokens;
  if (sampling?.stop?.length) config.stopSequences = [...sampling.stop];

  if (signal) config.abortSignal = signal;

  return {
    params: { model: wireModel, contents, config },
    dropped,
    grounded,
    searchTool: named.includes('web_search') || !named.includes('google_search') ? 'web_search' : 'google_search',
  };
}

/**
 * An assistant message's parts on the wire. Thinking is never sent. With
 * `replay` (the message belongs to the current turn), this model's thought
 * signatures go back on the part they were written on; a signature stored on
 * a thinking part goes on the next part sent, as it did when it was received.
 * Carried parts (code execution, server-side invocations) go back before the
 * part that carries them, as they arrived; another Gemini model's go back
 * without their signatures. Outside the current turn neither is sent.
 */
function assistantToWire(message: AssistantMessage, replay: boolean, model: string): WirePart[] {
  const out: WirePart[] = [];
  let carried: string | undefined;
  for (const part of message.parts) {
    const signature = replay ? signatureOf(part, model) : undefined;
    if (part.type === 'thinking') {
      carried = signature ?? carried;
      continue;
    }
    // A carried part read back from a stored event (the mapping's genai_part):
    // itself, verbatim, within its turn; outside it, nothing (ADR 0065, ADR 0100).
    const stored = storedCarriedPart(part);
    if (stored) {
      if (!replay) continue;
      if (carried && !stored.thoughtSignature) stored.thoughtSignature = carried;
      carried = undefined;
      out.push(stored);
      continue;
    }
    const before = replay ? carriedPartsOf(part, model) : [];
    if (before.length && carried) {
      if (!before[0].thoughtSignature) before[0].thoughtSignature = carried;
      carried = undefined;
    }
    out.push(...before);
    const sent = signature ?? carried;
    carried = undefined;
    let wire: WirePart;
    if (part.type === 'text') {
      // An empty text part is sent only to carry a signature.
      if (!part.text && !sent) continue;
      wire = { text: part.text };
    } else if (part.type === 'toolCall') {
      wire = { functionCall: { ...wireId(part.id), name: part.name, args: part.args } };
    } else {
      wire = blobToWire(part);
    }
    if (sent) wire.thoughtSignature = sent;
    out.push(wire);
  }
  return out;
}

/** This model's signature on a part: a thought signature, or the one a carried_parts state holds. */
function signatureOf(part: unknown, model: string): string | undefined {
  const payload = providerStateOf(part, GEMINI_PROVIDER, THOUGHT_SIGNATURE_KIND, model)?.payload;
  if (typeof payload === 'string' && payload) return payload;
  const carried = providerStateOf(part, GEMINI_PROVIDER, CARRIED_PARTS_KIND, model)?.payload as Partial<CarriedParts> | undefined;
  return typeof carried?.signature === 'string' && carried.signature ? carried.signature : undefined;
}

/**
 * The genai parts a part carries, as copies. Another Gemini model's go
 * without their signatures, which bind to the model that wrote them.
 */
function carriedPartsOf(part: unknown, model: string): WirePart[] {
  const state = providerStateOf(part, GEMINI_PROVIDER, CARRIED_PARTS_KIND);
  const before = (state?.payload as Partial<CarriedParts> | undefined)?.before;
  if (!Array.isArray(before)) return [];
  const own = state?.model === undefined || state.model === model;
  return before.filter(isPlainObject).map((raw) => {
    const { thoughtSignature, ...rest } = raw as WirePart;
    return own && typeof thoughtSignature === 'string' && thoughtSignature ? { ...rest, thoughtSignature } : { ...rest };
  });
}

/**
 * A copy of the code execution or server-side invocation part a stored
 * event held, as the genai mapping reads it back (`genai_part` state on its
 * text projection), or undefined for any other part.
 */
function storedCarriedPart(part: unknown): WirePart | undefined {
  const payload = providerStateOf(part, GEMINI_PROVIDER, GENAI_PART_KIND)?.payload;
  return isPlainObject(payload) && isCarriedWirePart(payload) ? ({ ...payload } as WirePart) : undefined;
}

/**
 * Gemini 3 rejects a current-turn step whose first function call has no
 * signature (a call another provider or model made). With placeholder
 * signatures on, that call gets PLACEHOLDER_THOUGHT_SIGNATURE.
 */
function withPlaceholderSignature(parts: WirePart[]): void {
  const first = parts.find((p) => p.functionCall);
  if (first && !first.thoughtSignature) first.thoughtSignature = PLACEHOLDER_THOUGHT_SIGNATURE;
}

function resultToWire(part: ToolResultPart): WirePart {
  const { result } = part;
  const response = part.isError ? { error: result } : isPlainObject(result) ? result : { result };
  return { functionResponse: { ...wireId(part.id), name: part.name, response } };
}

function blobToWire(part: BlobPart): WirePart {
  return part.url !== undefined
    ? { fileData: { mimeType: part.mimeType, fileUri: part.url } }
    : { inlineData: { mimeType: part.mimeType, data: part.data } };
}

/** The id for the wire: Gemini's own ids go back; ids the engine or the genai mapping made stay home. */
function wireId(id: string): { id?: string } {
  return id && !id.startsWith(ENGINE_CALL_ID_PREFIX) && !id.startsWith(MINTED_CALL_ID_PREFIX) ? { id } : {};
}

function toolConfigFor(request: ModelRequest): ToolConfig | undefined {
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

/** ADR 0047's mapping for this model, with the thoughts asked for unless the setting is `none`. */
function thinkingConfigFor(model: string, setting: ReasoningSetting): ThinkingConfig | undefined {
  const mapped = reasoningConfig(model, setting).thinkingConfig as ThinkingConfig | undefined;
  if (!mapped) return undefined;
  const none = setting === 'none' || (typeof setting === 'object' && setting.budget_tokens <= 0);
  return none ? { ...mapped } : { ...mapped, includeThoughts: true };
}

// ── Response ─────────────────────────────────────────────────────────────────

interface Pending {
  part: OutputPart;
  signature?: string;
  /** Carried genai parts that arrived before this part. */
  before?: WirePart[];
}

/** Finish reasons Gemini gives for withholding an answer on policy grounds. */
const CONTENT_FILTER = new Set(['SAFETY', 'RECITATION', 'BLOCKLIST', 'PROHIBITED_CONTENT', 'SPII']);

/** The finish reasons kept verbatim as an error code (contract.ts, GeminiErrorCode). */
const FINISH_CODES = new Set([
  'MAX_TOKENS', 'SAFETY', 'RECITATION', 'LANGUAGE', 'OTHER', 'BLOCKLIST', 'PROHIBITED_CONTENT', 'SPII',
  'MALFORMED_FUNCTION_CALL', 'IMAGE_SAFETY', 'UNEXPECTED_TOOL_CALL', 'TOO_MANY_TOOL_CALLS',
  'IMAGE_PROHIBITED_CONTENT', 'NO_IMAGE', 'IMAGE_RECITATION', 'IMAGE_OTHER',
]);

/** The prompt block reasons kept verbatim as an error code. */
const BLOCK_CODES = new Set(['SAFETY', 'OTHER', 'BLOCKLIST', 'PROHIBITED_CONTENT', 'IMAGE_SAFETY', 'MODEL_ARMOR', 'JAILBREAK']);

function isContentFilter(reason: string): boolean {
  return CONTENT_FILTER.has(reason) || reason.startsWith('IMAGE_');
}

function finishReasonOf(reason: string | undefined): FinishReason {
  if (!reason || reason === 'STOP') return 'stop';
  if (reason === 'MAX_TOKENS') return 'max_tokens';
  return isContentFilter(reason) ? 'content_filter' : 'other';
}

/**
 * A part the contract has no type for, which Gemini wants back within the
 * turn: code execution, and a server-side tool invocation.
 */
function isCarried(part: WirePart): boolean {
  return isCarriedWirePart(part);
}

/**
 * Folds Gemini's responses (one, or a stream's chunks) into the contract's
 * deltas and its one final. The first candidate is the answer.
 */
class ReplyBuilder {
  /** The thought parts seen, for the one thinking partial of a non-streamed call. */
  readonly thinking: ThinkingPart[] = [];
  /** Gemini's last finish reason, as it sent it. */
  finishReason: string | undefined;
  readonly #model: string;
  readonly #position: number;
  readonly #parts: Pending[] = [];
  /** A signature whose own part the final does not carry, waiting for the next part. */
  #carried: string | undefined;
  /** Carried genai parts waiting for the next output part. */
  #wire: WirePart[] = [];
  #calls = 0;
  #usage: GenerateContentResponseUsageMetadata | undefined;
  #finishMessage: string | undefined;
  #grounding: GroundingMetadata | undefined;
  #urlContext: UrlContextMetadata | undefined;
  #blockReason: string | undefined;
  #blockMessage: string | undefined;
  #sawCandidate = false;

  /** `position` is the conversation's length: the index the answer will take in it. */
  constructor(model: string, position: number) {
    this.#model = model;
    this.#position = position;
  }

  /** Takes one response or chunk; returns its text and thinking deltas, in order. */
  add(response: GenerateContentResponse): Array<TextPart | ThinkingPart> {
    if (response.usageMetadata) this.#usage = response.usageMetadata;
    if (response.promptFeedback?.blockReason) {
      this.#blockReason = response.promptFeedback.blockReason;
      this.#blockMessage = response.promptFeedback.blockReasonMessage;
    }
    const candidate = response.candidates?.[0];
    if (!candidate) return [];
    this.#sawCandidate = true;
    if (candidate.finishReason) this.finishReason = candidate.finishReason;
    if (candidate.finishMessage) this.#finishMessage = candidate.finishMessage;
    if (candidate.groundingMetadata) this.#grounding = candidate.groundingMetadata;
    if (candidate.urlContextMetadata) this.#urlContext = candidate.urlContextMetadata;

    const deltas: Array<TextPart | ThinkingPart> = [];
    for (const part of candidate.content?.parts ?? []) {
      const signature = typeof part.thoughtSignature === 'string' && part.thoughtSignature ? part.thoughtSignature : undefined;
      if (part.thought) {
        if (part.text) {
          const delta: ThinkingPart = { type: 'thinking', text: part.text };
          deltas.push(delta);
          this.thinking.push(delta);
        }
        if (signature) this.#carried = signature;
      } else if (part.functionCall?.name) {
        const { id, name, args } = part.functionCall;
        const index = this.#calls++;
        this.#push(
          {
            type: 'toolCall',
            id: id || `${ENGINE_CALL_ID_PREFIX}${this.#position}-${index}-${name}`,
            name,
            args: isPlainObject(args) ? args : {},
          },
          signature,
        );
      } else if (part.inlineData?.data !== undefined && part.inlineData.mimeType) {
        this.#push({ type: 'blob', mimeType: part.inlineData.mimeType, data: part.inlineData.data }, signature);
      } else if (part.fileData?.fileUri && part.fileData.mimeType) {
        this.#push({ type: 'blob', mimeType: part.fileData.mimeType, url: part.fileData.fileUri }, signature);
      } else if (part.text) {
        deltas.push({ type: 'text', text: part.text });
        this.#addText(part.text, signature);
      } else if (isCarried(part)) {
        // Kept whole, its own signature with it; a thought's signature
        // waiting for a part goes on this one, the next part Gemini sent.
        const wire: WirePart = { ...part };
        if (!signature && this.#carried) wire.thoughtSignature = this.#carried;
        this.#carried = undefined;
        this.#wire.push(wire);
      } else if (signature) {
        // An empty text part carrying a signature closes the text before it.
        const last = this.#parts.at(-1);
        if (typeof part.text === 'string' && last?.part.type === 'text' && !last.signature && !this.#carried && !this.#wire.length) {
          last.signature = signature;
        } else {
          this.#carried = signature;
        }
      }
    }
    return deltas;
  }

  /** The one final for a call that ran to its end. */
  final(searchTool: NativeTool): FinalModelResponse {
    const base = this.#base();
    const answer = base.parts.map((p) => (p.type === 'text' ? p.text : '')).join('');
    const grounding = groundingOf(this.#grounding, this.#urlContext, searchTool, answer);
    const response: FinalModelResponse = { ...base, ...(grounding ? { grounding } : {}) };
    if (!this.#sawCandidate) {
      if (this.#blockReason) {
        const code = BLOCK_CODES.has(this.#blockReason) ? this.#blockReason : 'OTHER';
        const why = code === this.#blockReason ? '' : `, reported as ${this.#blockReason}`;
        return {
          ...response,
          finishReason: 'content_filter',
          error: geminiError(code, `Gemini blocked the prompt (${code}${why})${detail(this.#blockMessage)}.`),
        };
      }
      return { ...response, finishReason: 'error', error: geminiError('UNKNOWN_ERROR', 'Gemini returned neither a candidate nor prompt feedback.') };
    }
    const reason = this.finishReason;
    if (reason && isContentFilter(reason)) {
      // Withheld on policy grounds: an error even when some text came first.
      return { ...response, error: geminiError(codeOf(reason), `Gemini withheld the answer (${reason})${detail(this.#finishMessage)}.`) };
    }
    const answered = base.parts.some((p) => p.type !== 'text' || p.text);
    if (!answered && reason && reason !== 'STOP') {
      const message =
        reason === 'MAX_TOKENS'
          ? 'Gemini ran out of output tokens before it answered (MAX_TOKENS). Raise sampling.maxOutputTokens or lower reasoning.'
          : `Gemini stopped without an answer (${reason})${detail(this.#finishMessage)}.`;
      return { ...response, error: geminiError(codeOf(reason), message) };
    }
    return response;
  }

  /** The final for a call that threw: GEMINI_ERROR, with what arrived before it. */
  failed(err: unknown, secret: string | undefined): FinalModelResponse {
    const status = errorStatus(err);
    return {
      ...this.#base(),
      finishReason: 'error',
      error: {
        code: 'GEMINI_ERROR',
        message: scrub(messageOf(err), secret),
        retryable: classifyError(err).retryable,
        ...(status !== undefined ? { status } : {}),
      },
    };
  }

  /** The final for a canceled call: never retryable, so no fallback answers it. */
  aborted(): FinalModelResponse {
    return { ...this.#base(), finishReason: 'error', error: geminiError('GEMINI_ERROR', 'The Gemini request was aborted.') };
  }

  #base(): FinalModelResponse {
    const parts = this.#outputParts();
    const usage = usageOf(this.#usage);
    const finishReason = parts.some((p) => p.type === 'toolCall') ? 'tool_call' : finishReasonOf(this.finishReason);
    return { partial: false, parts, finishReason, ...(usage ? { usage } : {}) };
  }

  #push(part: OutputPart, signature: string | undefined): void {
    this.#parts.push({ part, signature: signature ?? this.#carried, ...(this.#wire.length ? { before: this.#wire } : {}) });
    this.#carried = undefined;
    this.#wire = [];
  }

  /** Streamed text joins the text part before it until a signature or a carried part closes that part. */
  #addText(text: string, signature: string | undefined): void {
    const last = this.#parts.at(-1);
    if (last?.part.type === 'text' && !last.signature && !this.#carried && !this.#wire.length) {
      last.part = { type: 'text', text: last.part.text + text };
      if (signature) last.signature = signature;
      return;
    }
    this.#push({ type: 'text', text }, signature);
  }

  #outputParts(): OutputPart[] {
    let pending = this.#parts;
    let trailing: string | undefined;
    if (this.#wire.length) {
      // Carried parts with no output part after them ride on an empty text
      // part of their own, with any signature that came after them.
      pending = [...pending, { part: { type: 'text', text: '' }, before: this.#wire, ...(this.#carried ? { signature: this.#carried } : {}) }];
    } else {
      // A signature with no output part after it stays with the last part
      // that has none of its own.
      const last = pending.at(-1);
      trailing = this.#carried && last && !last.signature ? this.#carried : undefined;
    }
    return pending.map(({ part, signature, before }, i) => {
      const s = signature ?? (i === pending.length - 1 ? trailing : undefined);
      const state = this.#stateOf(s, before);
      return state ? { ...part, providerState: state } : part;
    });
  }

  #stateOf(signature: string | undefined, before: WirePart[] | undefined): ProviderState | undefined {
    if (before?.length) {
      const payload: CarriedParts = { before, ...(signature ? { signature } : {}) };
      return { provider: GEMINI_PROVIDER, kind: CARRIED_PARTS_KIND, model: this.#model, payload };
    }
    return signature ? { provider: GEMINI_PROVIDER, kind: THOUGHT_SIGNATURE_KIND, model: this.#model, payload: signature } : undefined;
  }
}

/** Gemini's usage under the contract's meanings: cached tokens inside the input, thinking inside the output. */
function usageOf(meta: GenerateContentResponseUsageMetadata | undefined): Usage | undefined {
  if (!meta) return undefined;
  const usage: Usage = {
    inputTokens: (meta.promptTokenCount ?? 0) + (meta.toolUsePromptTokenCount ?? 0),
    outputTokens: (meta.candidatesTokenCount ?? 0) + (meta.thoughtsTokenCount ?? 0),
  };
  if (meta.thoughtsTokenCount !== undefined) usage.thinkingTokens = meta.thoughtsTokenCount;
  if (meta.cachedContentTokenCount !== undefined) usage.cacheReadTokens = meta.cachedContentTokenCount;
  return usage;
}

/**
 * The grounding: the queries run, each page a grounding support cites with
 * the span of the answer it supports, each other searched page once without
 * a span, and each page urlContext retrieved without a span. `answer` is the
 * final's text parts joined, which the spans index.
 */
function groundingOf(
  meta: GroundingMetadata | undefined,
  urls: UrlContextMetadata | undefined,
  tool: NativeTool,
  answer: string,
): Grounding | undefined {
  const citations: Citation[] = [];
  const chunks = meta?.groundingChunks ?? [];
  const spanned = new Set<string>();
  for (const support of meta?.groundingSupports ?? []) {
    const span = spanOf(support.segment, answer);
    if (!span) continue;
    for (const index of new Set(support.groundingChunkIndices ?? [])) {
      const web = chunks[index]?.web;
      if (!web?.uri) continue;
      spanned.add(web.uri);
      citations.push({ url: web.uri, ...(web.title ? { title: web.title } : {}), ...span });
    }
  }
  const seen = new Set(spanned);
  for (const chunk of chunks) {
    const url = chunk.web?.uri;
    if (!url || seen.has(url)) continue;
    seen.add(url);
    citations.push(chunk.web?.title ? { url, title: chunk.web.title } : { url });
  }
  for (const entry of urls?.urlMetadata ?? []) {
    const url = entry.retrievedUrl;
    // A page urlContext could not read (an error, a paywall, an unsafe page) supports nothing.
    if (!url || seen.has(url) || entry.urlRetrievalStatus !== 'URL_RETRIEVAL_STATUS_SUCCESS') continue;
    seen.add(url);
    citations.push({ url });
  }
  const searchQueries = (meta?.webSearchQueries ?? []).filter((q) => typeof q === 'string' && q).map((query) => ({ tool, query }));
  if (!citations.length && !searchQueries.length) return undefined;
  return { ...(citations.length ? { citations } : {}), ...(searchQueries.length ? { searchQueries } : {}) };
}

/**
 * A segment's span in `answer` as UTF-16 offsets, end exclusive. Gemini
 * gives UTF-8 byte offsets (a start of 0 is left out of the JSON) and the
 * segment's text. When the offsets do not land on that text (they are
 * relative to one part, or the stream was joined differently), the text's
 * first place in the answer is the span; when it is not in the answer,
 * there is none.
 */
function spanOf(segment: Segment | undefined, answer: string): { start: number; end: number } | undefined {
  if (!segment) return undefined;
  const text = typeof segment.text === 'string' && segment.text ? segment.text : undefined;
  if (typeof segment.endIndex === 'number') {
    const start = utf16Offset(answer, segment.startIndex ?? 0);
    const end = utf16Offset(answer, segment.endIndex);
    if (start !== undefined && end !== undefined && start < end && (text === undefined || answer.slice(start, end) === text)) return { start, end };
  }
  if (text === undefined) return undefined;
  const at = answer.indexOf(text);
  return at < 0 ? undefined : { start: at, end: at + text.length };
}

/** The UTF-16 offset in `text` of a UTF-8 byte offset; undefined when it falls inside a character or past the end. */
function utf16Offset(text: string, bytes: number): number | undefined {
  if (!Number.isInteger(bytes) || bytes < 0) return undefined;
  let seen = 0;
  let i = 0;
  while (seen < bytes && i < text.length) {
    const code = text.codePointAt(i) ?? 0;
    seen += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
    i += code >= 0x10000 ? 2 : 1;
  }
  return seen === bytes ? i : undefined;
}

function codeOf(reason: string): ModelErrorCode {
  return FINISH_CODES.has(reason) ? reason : 'OTHER';
}

function geminiError(code: ModelErrorCode, message: string): ModelError {
  return { code, message, retryable: false };
}

function setupError(code: 'MISSING_API_KEY' | 'ENDPOINT_MISCONFIGURED', message: string): ModelError {
  return { code, message, retryable: false };
}

function detail(message: string | undefined): string {
  return message ? `: ${message}` : '';
}

// ── Transport ────────────────────────────────────────────────────────────────

async function* streamOf(client: GeminiClient, params: GenerateContentParameters): AsyncGenerator<GenerateContentResponse, void> {
  yield* await client.models.generateContentStream(params);
}

async function* responseOf(client: GeminiClient, params: GenerateContentParameters): AsyncGenerator<GenerateContentResponse, void> {
  yield await client.models.generateContent(params);
}

/**
 * Iterates `source` until `signal` aborts, and then stops at once: the SDK
 * aborts its fetch on the same signal, but a stalled stream or a backoff
 * sleep must not hold the caller.
 */
async function* untilAborted<T>(source: AsyncGenerator<T, void>, signal: AbortSignal | undefined): AsyncGenerator<T, void> {
  if (!signal) {
    yield* source;
    return;
  }
  let onAbort = () => {};
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(new Error('aborted'));
  });
  aborted.catch(() => {});
  if (signal.aborted) onAbort();
  else signal.addEventListener('abort', onAbort, { once: true });
  let done = false;
  try {
    for (;;) {
      const next = await Promise.race([source.next(), aborted]);
      if (next.done) {
        done = true;
        return;
      }
      yield next.value;
    }
  } finally {
    signal.removeEventListener('abort', onAbort);
    if (!done) source.return(undefined).catch(() => {});
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonEmpty(value: string | undefined): string | undefined {
  return value?.trim() || undefined;
}

/** The Gemini API key from the environment, in ADK's order. */
function envApiKey(): string | undefined {
  return nonEmpty(process.env.GOOGLE_GENAI_API_KEY) ?? nonEmpty(process.env.GOOGLE_API_KEY) ?? nonEmpty(process.env.GEMINI_API_KEY);
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** A Google API key's shape, so a key in a provider message never reaches a person or a model. */
const GOOGLE_API_KEY_SHAPE = /AIza[0-9A-Za-z_-]{35}/g;

function scrub(message: string, secret: string | undefined): string {
  const out = secret ? message.split(secret).join('[redacted]') : message;
  return out.replace(GOOGLE_API_KEY_SHAPE, '[redacted]');
}
