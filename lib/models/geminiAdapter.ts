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
 *     output part it arrived on. One on a part the final does not carry (a
 *     thought, an empty text part, a code-execution part) moves to the next
 *     output part. Signatures are replayed on the same part, within the
 *     current turn, for this model only.
 *   - A function call Gemini returns without an id gets
 *     `adk-<conversation length>-<call index>-<name>`. Ids that start with
 *     `adk-` are the engine's own and never go on the wire.
 *   - The response's code execution parts, server-side tool invocations and
 *     full grounding (citation spans) are WS3-1b's; here the first two are
 *     not carried, and grounding is the search queries and the cited pages.
 *
 * THE ADAPTER RULES (contract.ts header) as this adapter keeps them:
 *   - Errors are finals, never throws: a thrown call is GEMINI_ERROR with its
 *     status and lib/models/retry.ts's `retryable`; a blocked prompt or an
 *     empty or withheld candidate carries Gemini's own reason as the code.
 *   - The abort signal goes on the request config (the SDK aborts its fetch)
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
  ThinkingConfig,
  Tool,
  ToolConfig,
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
import { GEMINI_PROVIDER, THOUGHT_SIGNATURE_KIND } from './geminiState.ts';
import { currentTurnStart, providerStateOf } from './providerState.ts';
import { classifyError, errorStatus, retryUntilFirstYield } from './retry.ts';
import { reasoningConfig } from './reasoning.ts';
import { setLlmSpanAttribute } from '../observability/tracer.ts';
import { currentTurnSignal } from '../runtime/turnControl.ts';

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

  constructor(options: GeminiAdapterOptions) {
    this.model = options.model;
    this.#apiKey = nonEmpty(options.apiKey);
    this.#endpoint = options.endpoint;
    this.#clientFactory = options.clientFactory ?? defaultClientFactory;
  }

  async *generate(request: ModelRequest): AsyncGenerator<ModelResponse, void> {
    const signal = request.signal ?? currentTurnSignal();
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
      const built = buildRequest(request, model, platformModel(connection.endpoint, model), signal);
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

function buildRequest(request: ModelRequest, model: string, wireModel: string, signal: AbortSignal | undefined): BuiltRequest {
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
      case 'assistant':
        parts = assistantToWire(message, index > turnStart, model);
        break;
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

  const toolConfig = toolConfigFor(request);
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

function signatureOf(part: unknown, model: string): string | undefined {
  const payload = providerStateOf(part, GEMINI_PROVIDER, THOUGHT_SIGNATURE_KIND, model)?.payload;
  return typeof payload === 'string' && payload ? payload : undefined;
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

/** The id for the wire: Gemini's own ids go back; ids the engine made stay home. */
function wireId(id: string): { id?: string } {
  return id && !id.startsWith(ENGINE_CALL_ID_PREFIX) ? { id } : {};
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
  /** A signature whose own part the final does not carry, waiting for the next output part. */
  #carried: string | undefined;
  #calls = 0;
  #usage: GenerateContentResponseUsageMetadata | undefined;
  #finishMessage: string | undefined;
  #grounding: GroundingMetadata | undefined;
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
      } else if (signature) {
        // An empty text part carrying a signature closes the text before it.
        // Any other part the final does not carry (code execution, a
        // server-side tool call: WS3-1b) hands its signature on.
        const last = this.#parts.at(-1);
        if (typeof part.text === 'string' && last?.part.type === 'text' && !last.signature && !this.#carried) last.signature = signature;
        else this.#carried = signature;
      }
    }
    return deltas;
  }

  /** The one final for a call that ran to its end. */
  final(searchTool: NativeTool): FinalModelResponse {
    const base = this.#base();
    const grounding = this.#grounding ? groundingOf(this.#grounding, searchTool) : undefined;
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
    if (!base.parts.length && reason && reason !== 'STOP') {
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
    this.#parts.push({ part, signature: signature ?? this.#carried });
    this.#carried = undefined;
  }

  /** Streamed text joins the text part before it until a signature closes that part. */
  #addText(text: string, signature: string | undefined): void {
    const last = this.#parts.at(-1);
    if (last?.part.type === 'text' && !last.signature && !this.#carried) {
      last.part = { type: 'text', text: last.part.text + text };
      if (signature) last.signature = signature;
      return;
    }
    this.#push({ type: 'text', text }, signature);
  }

  #outputParts(): OutputPart[] {
    // A signature with no output part after it stays with the last part
    // that has none of its own.
    const last = this.#parts.at(-1);
    const trailing = this.#carried && last && !last.signature ? this.#carried : undefined;
    return this.#parts.map(({ part, signature }, i) => {
      const s = signature ?? (i === this.#parts.length - 1 ? trailing : undefined);
      return s ? { ...part, providerState: { provider: GEMINI_PROVIDER, kind: THOUGHT_SIGNATURE_KIND, model: this.#model, payload: s } } : part;
    });
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

/** The minimal grounding: the pages searched and cited, and the queries run. Citation spans are WS3-1b's. */
function groundingOf(meta: GroundingMetadata, tool: NativeTool): Grounding | undefined {
  const citations: Citation[] = [];
  const seen = new Set<string>();
  for (const chunk of meta.groundingChunks ?? []) {
    const url = chunk.web?.uri;
    if (!url || seen.has(url)) continue;
    seen.add(url);
    citations.push(chunk.web?.title ? { url, title: chunk.web.title } : { url });
  }
  const searchQueries = (meta.webSearchQueries ?? []).filter((q) => typeof q === 'string' && q).map((query) => ({ tool, query }));
  if (!citations.length && !searchQueries.length) return undefined;
  return { ...(citations.length ? { citations } : {}), ...(searchQueries.length ? { searchQueries } : {}) };
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
