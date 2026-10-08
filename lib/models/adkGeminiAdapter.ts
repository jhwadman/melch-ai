/**
 * lib/models/adkGeminiAdapter.ts — TEMPORARY: Gemini as a contract
 * ModelAdapter (ADR 0048) over ADK's own Gemini, the TracedGemini path of
 * lib/models/tracedGemini.ts, through the genai mapping (lib/models/genaiMapping.ts).
 *
 * WHY this file exists:
 *   The native loop (ADR 0045) calls ModelAdapters only. The engine's own
 *   Gemini adapter (lib/models/geminiAdapter.ts) calls @google/genai with no
 *   ADK, and waits for its live parity run at gate G3. Until it passes,
 *   Gemini on the native runtime goes through ADK's proven Gemini, wrapped
 *   here, so every provider has a contract adapter before gate G1. Delete
 *   this file once G3 is signed and GeminiAdapter serves every Gemini id
 *   (the plan's G3 risk: "The WS1-8 wrapper over ADK's Gemini stays until
 *   the cells pass"). resolveAdapter (lib/models/registry.ts) returns it for Gemini ids.
 *
 * THE CALL:
 *   1. The ModelRequest becomes an LlmRequest (modelRequestToLlmRequest),
 *      and then what ADK's path does to one before its Gemini sees it:
 *        - system messages joined onto the system prompt, in order, since
 *          Gemini takes no `system` content;
 *        - `adk-` call ids taken off calls and results, as ADK's flow does
 *          before every model call (ids the mapping minted are already off);
 *        - `includeServerSideToolInvocations`, which the compiler sends on
 *          every Gemini agent (lib/compile.ts);
 *        - `includeThoughts` under any reasoning but `none`, the contract's
 *          Gemini table, as GeminiAdapter sends it;
 *        - the platform's wire model (GEMINI_MODEL_MAP), as TracedGemini's own.
 *      The request is copied where ADK writes to it (a blob's display name),
 *      so the caller's history is never changed.
 *   2. TracedGemini.generateWithRetries runs it: ADK's Gemini with the
 *      shared retries, tagging the span that is open around this adapter
 *      (llm.web_search.native, llm.retries, llm.http_status), as it tags its
 *      own. `llm.capability.dropped` marks native tools Gemini has none for.
 *   3. Each LlmResponse comes back through llmResponseToModelResponse,
 *      folded into the contract's stream. A thought signature becomes
 *      providerState naming the request's model. A call Gemini returns
 *      without an id gets the mapping's `genai-noid-<position>-<part>`, or,
 *      streamed, ADK's own `adk-` id; neither goes back on the wire.
 *
 * REPLAY: every Gemini signature in the history goes back on its part, as
 * ADK sends a stored session's, whichever turn or model wrote it.
 * GeminiAdapter replays only the current turn's, for its own model.
 *
 * THE SPAN AND THE CHARGE are the caller's (ADR 0053): this adapter opens no
 * llm.request span and never charges the turn. Behind the ADK shim
 * (lib/models/adkShim.ts) it records the span TracedGemini records today for
 * the same exchange, but for a failed call's code (tests/telemetryLedger.test.ts).
 *
 * THE ADAPTER RULES (contract.ts header) as this adapter keeps them:
 *   - Partials: a streamed call's text and thinking deltas, as ADK's stream
 *     aggregator yields them. A call that does not stream yields its
 *     thinking as one partial before the final.
 *   - One final: every non-partial response ADK yields for the call (its
 *     aggregator flushes the text before each tool call) folds into it, with
 *     the last usage, grounding and finish reason.
 *   - Errors are finals, never throws. ADK's Gemini throws on a failed call:
 *     that is GEMINI_ERROR, `retryable` from lib/models/retry.ts's
 *     classifyError, `status` when the error had one. An error code ADK
 *     yields (a finish or block reason) is the code, not retryable; ADK's
 *     `STOP` is no error. Setup failures are MISSING_API_KEY and
 *     ENDPOINT_MISCONFIGURED, as GeminiAdapter's.
 *   - The abort: `request.signal` (the shim aborts it when the turn stops)
 *     goes on the request config. An aborted call is GEMINI_ERROR, never
 *     retryable, and the iteration ends at once whatever the transport does;
 *     a signal aborted before the call sends nothing.
 *   - Retries: TracedGemini's, only before the first chunk.
 *   - Messages never carry the key in use or anything shaped like a key.
 */

import type { LlmRequest, LlmResponse } from '@google/adk';
import type { Content, GroundingMetadata, GenerateContentResponseUsageMetadata, Part as GenaiPart } from '@google/genai';

import type {
  FinalModelResponse,
  ModelAdapter,
  ModelError,
  ModelRequest,
  ModelResponse,
  NativeTool,
  PartialModelResponse,
  ThinkingPart,
} from './contract.ts';
import { endpointFromEnv, endpointProblems, platformModel } from './endpoints.ts';
import type { ProviderEndpoint } from './endpoints.ts';
import { errorText } from './errorResponse.ts';
import { GEMINI_PROVIDER } from './geminiState.ts';
import { llmResponseToModelResponse, modelRequestToLlmRequest, nativeToolsWithoutGeminiTool } from './genaiMapping.ts';
import { TracedGemini } from './tracedGemini.ts';
import { classifyError, errorStatus } from './retry.ts';
import { setLlmSpanAttribute } from '../observability/tracer.ts';

/** The prefix of a call id ADK (or the engine after it) made: such an id never goes on the wire. */
const ADK_CALL_ID_PREFIX = 'adk-';

export interface AdkGeminiAdapterOptions {
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
}

interface Connection {
  gemini: TracedGemini;
  endpoint: ProviderEndpoint;
  /** The key in use, so no message this adapter writes can carry it. */
  secret?: string;
}

// ── The adapter ──────────────────────────────────────────────────────────────

/** Temporary: ADK's Gemini behind the model contract, until GeminiAdapter passes gate G3. */
export class AdkGeminiAdapter implements ModelAdapter {
  readonly provider = GEMINI_PROVIDER;
  readonly model: string;
  readonly #apiKey: string | undefined;
  readonly #endpoint: ProviderEndpoint | undefined;
  #connection: Connection | undefined;
  readonly #warned = new Set<string>();

  constructor(options: AdkGeminiAdapterOptions) {
    this.model = options.model;
    this.#apiKey = nonEmpty(options.apiKey);
    this.#endpoint = options.endpoint;
  }

  async *generate(request: ModelRequest): AsyncGenerator<ModelResponse, void> {
    const { signal } = request;
    const model = request.model || this.model;
    const stream = request.stream === true;
    const named = request.nativeTools ?? [];
    const searchTool: NativeTool = named.includes('web_search') || !named.includes('google_search') ? 'web_search' : 'google_search';
    const reply = new Reply({ model, position: request.messages.length, searchTool, stream });
    if (signal?.aborted) {
      yield reply.aborted();
      return;
    }
    const connection = this.#connect();
    if ('code' in connection) {
      yield { partial: false, parts: [], finishReason: 'error', error: connection };
      return;
    }
    const { gemini, endpoint, secret } = connection;
    try {
      const llmRequest = adkRequest(request, model, platformModel(endpoint, model));
      this.#report(nativeToolsWithoutGeminiTool(named));
      for await (const response of untilAborted(gemini.generateWithRetries(llmRequest, stream, signal), signal)) {
        const delta = reply.add(response);
        if (delta) yield delta;
      }
      const thinking = reply.thinking();
      if (thinking) yield thinking;
      yield reply.final();
    } catch (err) {
      if (signal?.aborted) {
        yield reply.aborted();
        return;
      }
      yield reply.failed(err, secret);
    }
  }

  /** Marks the open span with the native tools Gemini has none for, and warns once per tool. */
  #report(dropped: NativeTool[]): void {
    if (dropped.length === 0) return;
    setLlmSpanAttribute('llm.capability.dropped', dropped.join(','));
    for (const tool of dropped) {
      if (this.#warned.has(tool)) continue;
      this.#warned.add(tool);
      console.warn(`⚠ ${tool} is not a Gemini tool; ${this.model} runs without it.`);
    }
  }

  /** ADK's Gemini for this adapter's endpoint, built once; or why it cannot be built. */
  #connect(): Connection | ModelError {
    if (this.#connection) return this.#connection;
    let endpoint: ProviderEndpoint;
    try {
      endpoint = this.#endpoint ?? endpointFromEnv('gemini');
    } catch (err) {
      return setupError('ENDPOINT_MISCONFIGURED', errorText(err));
    }
    let secret: string | undefined;
    if (endpoint.platform === 'vertex') {
      const problems = endpointProblems('gemini', endpoint);
      if (problems.length > 0) return setupError('ENDPOINT_MISCONFIGURED', `Gemini on Vertex AI: ${problems.join('; ')}.`);
    } else if (endpoint.platform === 'direct') {
      secret = this.#apiKey ?? nonEmpty(endpoint.apiKey) ?? envApiKey();
      if (!secret) {
        return setupError(
          'MISSING_API_KEY',
          'No Gemini API key: set GOOGLE_GENAI_API_KEY (or GEMINI_API_KEY), or GEMINI_PLATFORM=vertex for Vertex AI.',
        );
      }
    } else {
      return setupError('ENDPOINT_MISCONFIGURED', `Gemini has no ${endpoint.platform} platform; use direct or vertex.`);
    }
    try {
      // TracedGemini applies the platform (ADR 0023): on Vertex AI, Google
      // Application Default Credentials and no AI Studio key.
      const gemini = new TracedGemini({ model: this.model, ...(secret ? { apiKey: secret } : {}), endpoint });
      this.#connection = { gemini, endpoint, secret };
    } catch (err) {
      return setupError('ENDPOINT_MISCONFIGURED', `ADK's Gemini failed to build: ${scrub(err, secret)}`);
    }
    return this.#connection;
  }
}

// ── The request ──────────────────────────────────────────────────────────────

/** The LlmRequest ADK's Gemini is handed for this ModelRequest (see the header, THE CALL). */
function adkRequest(request: ModelRequest, model: string, wireModel: string): LlmRequest {
  const extra: string[] = [];
  for (const message of request.messages) {
    if (message.role === 'system') for (const part of message.parts) if (part.text) extra.push(part.text);
  }
  const llmRequest = modelRequestToLlmRequest({ ...request, model, messages: request.messages.filter((m) => m.role !== 'system') });
  const config = llmRequest.config ?? {};
  if (extra.length > 0) {
    config.systemInstruction = { parts: [...(request.system ? [request.system] : []), ...extra].map((text) => ({ text })) };
  }
  config.toolConfig = { ...config.toolConfig, includeServerSideToolInvocations: true };
  const thinking = config.thinkingConfig;
  const none = request.reasoning === 'none' || (typeof request.reasoning === 'object' && request.reasoning.budget_tokens <= 0);
  if (thinking && !none) config.thinkingConfig = { ...thinking, includeThoughts: true };
  return { ...llmRequest, model: wireModel, contents: llmRequest.contents.map(forAdk), config };
}

/**
 * A content as ADK's Gemini may take it: `adk-` ids off calls and results,
 * and every part copied where ADK writes (it clears a blob's display name in
 * place), so a part the history shares (a carried genai part) is never changed.
 */
function forAdk(content: Content): Content {
  return {
    ...content,
    parts: (content.parts ?? []).map((part) => {
      const out: GenaiPart = { ...part };
      if (part.inlineData) out.inlineData = { ...part.inlineData };
      if (part.fileData) out.fileData = { ...part.fileData };
      if (part.functionCall) out.functionCall = withoutAdkId(part.functionCall);
      if (part.functionResponse) out.functionResponse = withoutAdkId(part.functionResponse);
      return out;
    }),
  };
}

function withoutAdkId<T extends { id?: string }>(value: T): T {
  if (typeof value.id !== 'string' || !value.id.startsWith(ADK_CALL_ID_PREFIX)) return { ...value };
  const { id: _id, ...rest } = value;
  return rest as T;
}

// ── The response ─────────────────────────────────────────────────────────────

/** Folds the LlmResponses ADK yields for one call into the contract's deltas and its one final. */
class Reply {
  readonly #model: string;
  readonly #position: number;
  readonly #searchTool: NativeTool;
  readonly #stream: boolean;
  readonly #parts: GenaiPart[] = [];
  readonly #thinking: ThinkingPart[] = [];
  #usage: GenerateContentResponseUsageMetadata | undefined;
  #grounding: GroundingMetadata | undefined;
  #finishReason: LlmResponse['finishReason'];
  #error: Pick<LlmResponse, 'errorCode' | 'errorMessage' | 'customMetadata'> | undefined;

  constructor(options: { model: string; position: number; searchTool: NativeTool; stream: boolean }) {
    this.#model = options.model;
    this.#position = options.position;
    this.#searchTool = options.searchTool;
    this.#stream = options.stream;
  }

  /** Takes one LlmResponse. A streamed partial's deltas come back to be yielded; everything else folds into the final. */
  add(response: LlmResponse): PartialModelResponse | undefined {
    if (response.usageMetadata) this.#usage = response.usageMetadata;
    if (response.groundingMetadata) this.#grounding = response.groundingMetadata;
    if (response.finishReason) this.#finishReason = response.finishReason;
    if (response.partial === true) {
      if (!this.#stream) return undefined;
      const delta = llmResponseToModelResponse(response) as PartialModelResponse;
      return delta.parts.length > 0 ? delta : undefined;
    }
    if (response.errorCode) {
      this.#error = { errorCode: response.errorCode, errorMessage: response.errorMessage, customMetadata: response.customMetadata };
    }
    for (const part of response.content?.parts ?? []) {
      this.#parts.push(part);
      if (part.thought === true && part.text) this.#thinking.push({ type: 'thinking', text: part.text });
    }
    return undefined;
  }

  /** The thinking of a call that did not stream, as one partial before its final. */
  thinking(): PartialModelResponse | undefined {
    return !this.#stream && this.#thinking.length > 0 ? { partial: true, parts: this.#thinking } : undefined;
  }

  /** The one final for a call that ran to its end. */
  final(): FinalModelResponse {
    return this.#fold(true);
  }

  /** The final for a call ADK's Gemini threw on: GEMINI_ERROR, with what arrived before it. */
  failed(err: unknown, secret: string | undefined): FinalModelResponse {
    const status = errorStatus(err);
    return {
      ...this.#fold(false),
      finishReason: 'error',
      error: {
        code: 'GEMINI_ERROR',
        message: scrub(err, secret),
        retryable: classifyError(err).retryable,
        ...(status !== undefined ? { status } : {}),
      },
    };
  }

  /** The final for a canceled call: never retryable, so no fallback answers it. */
  aborted(): FinalModelResponse {
    return { ...this.#fold(false), finishReason: 'error', error: { code: 'GEMINI_ERROR', message: 'The Gemini request was aborted.', retryable: false } };
  }

  /** Everything ADK yielded as one LlmResponse, mapped; with the error it yielded, or (for a throw) without. */
  #fold(withError: boolean): FinalModelResponse {
    const folded: LlmResponse = {
      ...(this.#parts.length > 0 ? { content: { role: 'model', parts: this.#parts } } : {}),
      ...(this.#usage ? { usageMetadata: this.#usage } : {}),
      ...(this.#grounding ? { groundingMetadata: this.#grounding } : {}),
      ...(this.#finishReason ? { finishReason: this.#finishReason } : {}),
      ...(withError ? this.#error : {}),
    };
    return llmResponseToModelResponse(folded, { model: this.#model, index: this.#position, searchTool: this.#searchTool }) as FinalModelResponse;
  }
}

// ── Transport ────────────────────────────────────────────────────────────────

function abortError(): Error {
  return Object.assign(new Error('The Gemini request was aborted.'), { name: 'AbortError' });
}

/**
 * Iterates `source` until `signal` aborts, and then throws an AbortError at
 * once: the SDK aborts its fetch on the same signal, but a stalled stream or
 * a backoff sleep must not hold the caller. The source is closed in the
 * background.
 */
async function* untilAborted<T>(source: AsyncGenerator<T, void>, signal: AbortSignal | undefined): AsyncGenerator<T, void> {
  if (!signal) {
    yield* source;
    return;
  }
  let onAbort = () => {};
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(abortError());
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

function setupError(code: 'MISSING_API_KEY' | 'ENDPOINT_MISCONFIGURED', message: string): ModelError {
  return { code, message, retryable: false };
}

function nonEmpty(value: string | undefined): string | undefined {
  return value?.trim() || undefined;
}

/** The Gemini API key from the environment, in ADK's order. */
function envApiKey(): string | undefined {
  return nonEmpty(process.env.GOOGLE_GENAI_API_KEY) ?? nonEmpty(process.env.GOOGLE_API_KEY) ?? nonEmpty(process.env.GEMINI_API_KEY);
}

/** An error's text without the key in use, or anything shaped like a key. */
function scrub(err: unknown, secret: string | undefined): string {
  const message = err instanceof Error ? err.message : String(err);
  return errorText(secret ? message.split(secret).join('[redacted]') : message);
}
