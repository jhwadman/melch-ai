/**
 * lib/models/chatCompletionsAdapter.ts — the OpenAI chat-completions wire
 * behind the engine's own model contract (lib/models/contract.ts, ADR 0048):
 * the base every /chat/completions provider adapter extends.
 *
 * WHY this file exists:
 *   Moonshot (Kimi), Ollama and the hosted gateways all speak chat
 *   completions, so they share one translation: a ModelRequest becomes chat
 *   messages, function tools and body fields, and a completion (JSON or SSE)
 *   becomes the contract's partial and final responses. A provider adapter
 *   is a small subclass supplying the endpoint, the auth headers, the wire
 *   model name, its reasoning field, the tool choices it honours and its
 *   error wording (lib/models/ollamaAdapter.ts, kimiAdapter.ts,
 *   gatewayAdapter.ts). There is no ADK here: under ADK each adapter runs
 *   behind its shim class (OllamaLlm, KimiLlm, GatewayLlm, through
 *   OpenAiCompatibleLlm in lib/models/openAiCompatibleLlm.ts, ADR 0057).
 *   wiki/models/model-contract.md ("Chat completions") is the mapping spec.
 *
 * WHAT THE BASE PROVIDES (uniformly, for every subclass):
 *   - Messages: the system prompt and the system messages as one system
 *     message first; user text and inline images (data URIs; a URL blob is
 *     not sent); assistant text and tool_calls; one `tool` message per tool
 *     result, its content the result's JSON in the genai envelope ({ result }
 *     for a non-object, { error } for a failure), so the wire is what the ADK
 *     path sent. Thinking is never sent.
 *   - Tools as function tools, the schema as written (lowercase JSON Schema),
 *     its strict form with `strict: true` when the declaration asks.
 *     `toolChoice: 'none'` sends no tools; `required` and a named tool go as
 *     `tool_choice` where the subclass says the provider honours them (per
 *     model and the request's reasoning), and are otherwise weakened, with
 *     `llm.tool_choice.weakened` on the span: a named tool to `required` where
 *     that holds, else to auto.
 *   - Native tools: none run here. web_search is sent only where the subclass
 *     names body fields for it; every other one is dropped, marked on the span
 *     (`llm.capability.dropped`) with a one-time warning.
 *   - Reasoning: `<think>` blocks, `reasoning_content` and `reasoning` fields
 *     become a thinking partial, never history. An adapter that opts in
 *     (replaysReasoningContent: Kimi) writes the response's reasoning_content
 *     as providerState on the part it preceded and sends it back on that
 *     assistant message within the current turn's tool loop, for the same
 *     provider and model only (ADR 0046).
 *   - A turn that thought, or ran out of tokens, without a reply or a tool
 *     call is an error final (`<ID>_MAX_TOKENS`, `<ID>_EMPTY_RESPONSE`, ADR
 *     0027), carrying its usage. An adapter that opts in
 *     (retriesWithoutThinking: Ollama) asks once more with `reasoning: none`,
 *     holding the first error back and summing both attempts' usage.
 *   - Usage in the contract's meaning: inputTokens `prompt_tokens`,
 *     outputTokens `completion_tokens` (thinking included), thinkingTokens
 *     `completion_tokens_details.reasoning_tokens`, cacheReadTokens
 *     `prompt_tokens_details.cached_tokens`.
 *   - Retries of transient failures (lib/models/retry.ts) on the request,
 *     before any byte is read; failures as error finals with the retry
 *     verdict and the HTTP status; the abort signal on the fetch and the
 *     stream, so an aborted call ends at once and is never retryable.
 *   - Span attributes on the open llm.request span (the caller opens it,
 *     ADR 0053): llm.transport, llm.finish_reason, llm.http_status,
 *     llm.retries, llm.retry_without_thinking, and the search and drop marks.
 */

import type {
  FinalModelResponse,
  FinishReason,
  ModelAdapter,
  ModelError,
  ModelRequest,
  ModelResponse,
  NativeTool,
  OutputPart,
  ReasoningSetting,
  ToolCallPart,
  ToolChoice,
  ToolChoiceMode,
  ToolDeclaration,
  ToolResultPart,
  Usage,
} from './contract.ts';
import { errorDecision, errorText, statusDecision } from './errorResponse.ts';
import { currentTurnStart, providerStateOf } from './providerState.ts';
import { reasoningConfig } from './reasoning.ts';
import { fetchWithRetry } from './retry.ts';
import { toStrictJsonSchema } from './schemaNormalize.ts';
import { setLlmSpanAttribute } from '../observability/tracer.ts';
import { currentTurnSignal } from '../runtime/turnControl.ts';

// ── The request ──────────────────────────────────────────────────────────────

/**
 * What an agent's older generateContentConfig spelling asks of a
 * chat-completions provider that the contract has no field for (ADR 0047;
 * "What the contract leaves out" in wiki/models/model-contract.md). Only the
 * ADK shim around these adapters sets it, from the LlmRequest, so an agent
 * keeps it on the ADK runtime; the native runtime never sets it.
 */
export interface OlderSpelling {
  /**
   * An effort word that is not a contract level, such as Kimi K3's `max`,
   * sent as `reasoning_effort` as written, in place of `reasoning`'s word.
   */
  reasoningEffort?: string;
}

/** A ModelRequest, plus what the ADK path carries beside the contract. */
export interface ChatCompletionsRequest extends ModelRequest {
  olderSpelling?: OlderSpelling;
}

// ── Wire types (the subset these providers implement) ────────────────────────

type ChatContentPart = { type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } };

type ChatToolCall = { id: string; type: 'function'; function: { name: string; arguments: string } };

export type ChatMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string | ChatContentPart[] }
  | { role: 'assistant'; content: string | null; reasoning_content?: string; tool_calls?: ChatToolCall[] }
  | { role: 'tool'; tool_call_id: string; content: string };

/** What an adapter words for a failure: the code and the message for a person. */
export interface ChatFailure {
  code: string;
  message: string;
}

/** The providerState kind an opted-in adapter writes: an assistant message's reasoning_content. */
export const REASONING_CONTENT_KIND = 'reasoning_content';

/**
 * The prefix of a call id the engine made when the provider returned none.
 * ADK uses it for its own ids and leaves such ids out of the requests it
 * builds, so on the ADK path the stored history reads as it did.
 */
export const ENGINE_CALL_ID_PREFIX = 'adk-';

// ── <think> blocks ───────────────────────────────────────────────────────────

const OPEN_THINK = '<think>';
const CLOSE_THINK = '</think>';

/**
 * Splits "<think>…</think>" scratchpad from the reply.
 *
 * A block the model never closed is scratchpad too: it means the model ran
 * out of budget mid-thought, so everything after the opening tag is
 * reasoning — never reply text with a raw "<think>" in it.
 */
export function splitThinkBlocks(text: string): {
  reasoning: string;
  answer: string;
} {
  const blocks: string[] = [];
  let answer = text.replace(/<think>([\s\S]*?)<\/think>/g, (_, inner: string) => {
    blocks.push(inner.trim());
    return '';
  });
  const unclosed = answer.indexOf(OPEN_THINK);
  if (unclosed !== -1) {
    const inner = answer.slice(unclosed + OPEN_THINK.length).trim();
    if (inner) blocks.push(inner);
    answer = answer.slice(0, unclosed).trimEnd();
  }
  return { reasoning: blocks.join('\n\n'), answer: answer.trimStart() };
}

/** Length of the longest suffix of `s` that is a proper prefix of `tag`. */
function partialTagSuffix(s: string, tag: string): number {
  const max = Math.min(s.length, tag.length - 1);
  for (let n = max; n > 0; n--) {
    if (s.endsWith(tag.slice(0, n))) return n;
  }
  return 0;
}

/**
 * Incremental counterpart to splitThinkBlocks, for the SSE path.
 *
 * WHY a state machine rather than the regex: on a stream the closing
 * `</think>` has usually NOT arrived yet, so the regex matches nothing and
 * the whole scratchpad would be printed as the reply. A tag can also be
 * split mid-delta ("<thi" + "nk>"), so any tail that could still grow into
 * a tag is held back instead of being emitted as answer text.
 *
 * Providers that report reasoning in a discrete field (Ollama's
 * `delta.reasoning`, others' `reasoning_content`) never open a think block
 * and pass straight through this untouched.
 */
export class ThinkStreamSplitter {
  private inThink = false;
  private held = '';

  /** Routes one content delta into reasoning/answer text. */
  push(chunk: string): { reasoning: string; answer: string } {
    let buf = this.held + chunk;
    let reasoning = '';
    let answer = '';

    for (;;) {
      const tag = this.inThink ? CLOSE_THINK : OPEN_THINK;
      const at = buf.indexOf(tag);
      if (at === -1) break;
      if (this.inThink) reasoning += buf.slice(0, at);
      else answer += buf.slice(0, at);
      buf = buf.slice(at + tag.length);
      this.inThink = !this.inThink;
    }

    // Hold back only what could still become the tag we're watching for.
    const pending = this.inThink ? CLOSE_THINK : OPEN_THINK;
    const keep = partialTagSuffix(buf, pending);
    this.held = keep > 0 ? buf.slice(buf.length - keep) : '';
    const emit = keep > 0 ? buf.slice(0, buf.length - keep) : buf;
    if (this.inThink) reasoning += emit;
    else answer += emit;

    return { reasoning, answer };
  }

  /** Releases the held tail; the stream ended, so it was never a tag. */
  flush(): { reasoning: string; answer: string } {
    const rest = this.held;
    this.held = '';
    return this.inThink ? { reasoning: rest, answer: '' } : { reasoning: '', answer: rest };
  }
}

// ── Usage ────────────────────────────────────────────────────────────────────

function count(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/**
 * A chat completion's `usage` in the contract's meaning (contract.ts Usage):
 * `completion_tokens` already counts the reasoning, which
 * `completion_tokens_details.reasoning_tokens` breaks out. Undefined when the
 * provider reported neither prompt nor completion tokens.
 */
export function chatUsage(usage: unknown): Usage | undefined {
  if (!isPlainObject(usage)) return undefined;
  const input = count(usage.prompt_tokens);
  const output = count(usage.completion_tokens);
  if (input === undefined && output === undefined) return undefined;
  const thinking = count((usage.completion_tokens_details as Record<string, unknown> | undefined)?.reasoning_tokens);
  const cached = count((usage.prompt_tokens_details as Record<string, unknown> | undefined)?.cached_tokens);
  return {
    inputTokens: input ?? 0,
    outputTokens: output ?? 0,
    ...(thinking !== undefined ? { thinkingTokens: thinking } : {}),
    ...(cached !== undefined ? { cacheReadTokens: cached } : {}),
  };
}

/** Two attempts' usage as one call's: each field summed, an optional one where either had it. */
export function sumUsage(a: Usage | undefined, b: Usage | undefined): Usage | undefined {
  if (!a) return b;
  if (!b) return a;
  const out: Usage = { inputTokens: a.inputTokens + b.inputTokens, outputTokens: a.outputTokens + b.outputTokens };
  for (const k of ['thinkingTokens', 'cacheReadTokens', 'cacheWriteTokens'] as const) {
    if (a[k] !== undefined || b[k] !== undefined) out[k] = (a[k] ?? 0) + (b[k] ?? 0);
  }
  return out;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/** True for the setting that asks for as little reasoning as the model allows. */
export function reasonsNotAtAll(setting: ReasoningSetting | undefined): boolean {
  return setting === 'none' || (typeof setting === 'object' && setting !== null && setting.budget_tokens <= 0);
}

/** A tool result as the tool message's content: the genai envelope, so the wire is what the ADK path sent. */
function resultContent(part: ToolResultPart): string {
  const response = part.isError ? { error: part.result } : isPlainObject(part.result) ? part.result : { result: part.result };
  return JSON.stringify(response);
}

/** A call's arguments: parsed JSON when it is an object, else `{ raw }` (contract.ts ToolCallPart). */
function parseArguments(raw: unknown): Record<string, unknown> {
  if (isPlainObject(raw)) return raw;
  try {
    const parsed: unknown = JSON.parse(String(raw));
    if (isPlainObject(parsed)) return parsed;
  } catch {
    /* kept as raw below */
  }
  return { raw };
}

function finishReasonOf(reason: string | undefined, parts: OutputPart[]): FinishReason {
  if (parts.some((p) => p.type === 'toolCall')) return 'tool_call';
  switch (reason) {
    case undefined:
    case 'stop':
      return 'stop';
    case 'length':
      return 'max_tokens';
    case 'content_filter':
      return 'content_filter';
    default:
      return 'other';
  }
}

function abortError(): Error {
  return Object.assign(new Error('the request was aborted'), { name: 'AbortError' });
}

/**
 * Yields parsed `data:` payloads from an SSE response body. An abort cancels
 * the read, so the stream ends at once whatever the transport does.
 */
async function* sseChunks(res: Response, signal: AbortSignal | undefined): AsyncGenerator<any> {
  const reader = (res.body as any)?.getReader?.();
  if (!reader) return;
  const onAbort = () => {
    reader.cancel().catch(() => {});
  };
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    const decoder = new TextDecoder();
    let buf = '';
    for (;;) {
      if (signal?.aborted) throw abortError();
      const { value, done } = await reader.read();
      if (signal?.aborted) throw abortError();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        // Blank separators and ":" keep-alive comments carry no payload.
        if (!line.startsWith('data:')) continue;
        const payload = line.slice('data:'.length).trim();
        if (payload === '[DONE]') return;
        try {
          yield JSON.parse(payload);
        } catch {
          /* a chunk that isn't valid JSON is not worth killing the turn for */
        }
      }
    }
  } finally {
    signal?.removeEventListener('abort', onAbort);
  }
}

/** Finals built by noAnswerError: the ones a retry without thinking may replace. */
const NO_ANSWER = new WeakSet<FinalModelResponse>();

// ── ChatCompletionsAdapter ───────────────────────────────────────────────────

export interface ChatCompletionsAdapterOptions {
  /** The model id as the YAML names it. */
  model: string;
}

export abstract class ChatCompletionsAdapter implements ModelAdapter {
  /** The provider id telemetry attributes the call to (lib/models/providerMap.ts). */
  abstract readonly provider: string;
  readonly model: string;
  #warned = new Set<string>();

  constructor(options: ChatCompletionsAdapterOptions) {
    this.model = options.model;
  }

  // ── Subclass surface ───────────────────────────────────────────────────────

  /** Full chat-completions URL, e.g. "https://api.moonshot.ai/v1/chat/completions". */
  protected abstract endpointUrl(): string;

  /** Auth and extra headers. Content-Type is added by the base. */
  protected abstract headers(): Record<string, string>;

  /** Model id as the wire expects it (e.g. strip the "ollama/" namespace). */
  protected wireModelName(model: string): string {
    return model;
  }

  /**
   * How the request reaches the provider: 'direct' (the provider's own
   * endpoint) or 'gateway:<id>' (lib/models/gatewayAdapter.ts). Recorded on
   * the llm.request span as llm.transport, so the ledger can tell a native
   * call from a proxied one while llm.provider keeps the upstream attribution.
   */
  transport(): string {
    return 'direct';
  }

  /**
   * Whether the endpoint honours stream_options.include_usage. Without it an
   * SSE call reports no token counts at all.
   */
  protected supportsStreamUsage(): boolean {
    return true;
  }

  /**
   * The tool choices sent as asked (contract.ts ToolChoice), for this model
   * and the request's reasoning (a provider may refuse forcing only while
   * the model thinks). `auto` and `none` always hold (`none` by sending no
   * tools); a mode left out is weakened and marked on the span: a named
   * choice to `required` where `required` holds, anything else to auto.
   * Default: auto and none.
   */
  protected toolChoiceModes(_model: string, _reasoning: ReasoningSetting | undefined): readonly ToolChoiceMode[] {
    return ['auto', 'none'];
  }

  /**
   * The body fields for the request's reasoning. Default: `reasoning_effort`
   * as the effort word ADR 0047 gives this model (lib/models/reasoning.ts),
   * the field every chat-completions provider and gateway reads; the older
   * spelling's word as written when the ADK path carries one; nothing when
   * neither is set.
   */
  protected reasoningFields(model: string, setting: ReasoningSetting | undefined, olderWord: string | undefined): Record<string, unknown> {
    const word = olderWord ?? (setting !== undefined ? (reasoningConfig(model, setting).reasoningEffort as string) : undefined);
    return word !== undefined ? { reasoning_effort: word } : {};
  }

  /** Provider-specific body fields, merged last. */
  protected extraBodyFields(_request: ChatCompletionsRequest): Record<string, unknown> {
    return {};
  }

  /**
   * Body fields enabling the provider's NATIVE web search, or null when the
   * provider has none (the base then drops the tool, marks the span and
   * warns once).
   */
  protected webSearchBodyFields(): Record<string, unknown> | null {
    return null;
  }

  /**
   * Extracts reasoning from the response message. Default: "<think>" blocks
   * in content plus the reasoning_content / reasoning fields emitted by
   * OpenAI-compatible reasoning models.
   */
  protected extractReasoning(message: {
    content?: string | null;
    reasoning_content?: string;
    reasoning?: string;
  }): { reasoning: string; answer: string } {
    const { reasoning: thinkReasoning, answer } = splitThinkBlocks(message.content ?? '');
    const fieldReasoning = message.reasoning_content ?? message.reasoning ?? '';
    return {
      reasoning: [fieldReasoning, thinkReasoning].filter(Boolean).join('\n\n'),
      answer,
    };
  }

  /**
   * Whether an assistant message's `reasoning_content` is carried to the
   * next step of the tool loop (ADR 0046). Default: never — the scratchpad
   * stays display-only, as Ollama and the gateway keep it. An adapter whose
   * provider asks for the field back on a tool loop turns it on (Kimi).
   */
  protected replaysReasoningContent(_model: string): boolean {
    return false;
  }

  /** A precondition the call cannot be made without (e.g. no API key), or undefined when ready. */
  protected missingRequirement(): ChatFailure | undefined {
    return undefined;
  }

  /** The failure for a non-2xx HTTP status. */
  protected httpError(status: number, detail: string, _model: string): ChatFailure {
    return {
      code: `${this.provider.toUpperCase()}_HTTP_ERROR`,
      message: `${this.provider} returned ${status}: ${detail.slice(0, 4000)}`,
    };
  }

  /**
   * Whether a call that ended with no answer after thinking (noAnswerError)
   * is sent once more with `reasoning: none`. Default: never. An adapter for
   * local reasoning models turns it on (Ollama).
   */
  protected retriesWithoutThinking(): boolean {
    return false;
  }

  /**
   * The failure for a call that produced reasoning or ran out of tokens but
   * no reply and no tool call. `truncated` is true when the provider
   * reported finish_reason "length" (the token budget or context window
   * filled up); false when it stopped after thinking with nothing to say.
   */
  protected noAnswerError(truncated: boolean, model: string): ChatFailure {
    const id = this.provider.toUpperCase();
    return truncated
      ? {
          code: `${id}_MAX_TOKENS`,
          message:
            `${model} ran out of tokens before it wrote a reply (finish_reason "length"). ` +
            "Raise maxOutputTokens, or lower the agent's reasoning: setting so less goes to thinking.",
        }
      : { code: `${id}_EMPTY_RESPONSE`, message: `${model} finished thinking but returned no reply.` };
  }

  /** The failure when the endpoint can't be reached at all. */
  protected unreachable(message: string): ChatFailure {
    return {
      code: `${this.provider.toUpperCase()}_UNREACHABLE`,
      message: `Could not reach ${this.endpointUrl()} (${message}).`,
    };
  }

  // ── Generation ─────────────────────────────────────────────────────────────

  /**
   * One call, retried once without thinking when the adapter opts in and the
   * model thought its way to no answer (ADR 0027): a local reasoning model can
   * spend its whole context window on the scratchpad. The first attempt's
   * error is held back, never yielded; what it spent is added to the retry's
   * usage, so budgets and the ledger still count it. A request that already
   * asks for no reasoning is not retried.
   */
  async *generate(request: ChatCompletionsRequest): AsyncGenerator<ModelResponse, void> {
    const model = request.model || this.model;
    const mayRetry = this.retriesWithoutThinking() && !reasonsNotAtAll(request.reasoning);
    let held: FinalModelResponse | undefined;
    for await (const response of this.#attempt(request, model)) {
      if (mayRetry && !response.partial && NO_ANSWER.has(response)) {
        held = response;
        continue;
      }
      yield response;
    }
    if (!held) return;

    setLlmSpanAttribute('llm.retry_without_thinking', held.error?.code ?? true);
    this.#warnOnce('retry', `⚠ ${model} thought without answering (${held.error?.code}); retrying once with thinking off.`);
    // The older spelling's effort word would ask for thinking again.
    const { olderSpelling: _older, ...rest } = request;
    const retry: ChatCompletionsRequest = { ...rest, reasoning: 'none' };
    for await (const response of this.#attempt(retry, model)) {
      if (response.partial) {
        yield response;
        continue;
      }
      const usage = sumUsage(held.usage, response.usage);
      yield { ...response, ...(usage ? { usage } : {}) };
    }
  }

  async *#attempt(request: ChatCompletionsRequest, model: string): AsyncGenerator<ModelResponse, void> {
    const missing = this.missingRequirement();
    if (missing) {
      yield failure(missing, false);
      return;
    }

    setLlmSpanAttribute('llm.transport', this.transport());
    const stream = request.stream === true;
    const body = this.#body(request, model, stream);
    const signal = request.signal ?? currentTurnSignal();
    if (signal?.aborted) {
      yield failure(this.unreachable('the request was aborted'), false);
      return;
    }

    try {
      // Transient failures (429/5xx, connection resets) are retried here, on
      // the REQUEST only — the body is read after, so a stream that dies
      // half-way is reported, never replayed (lib/models/retry.ts).
      const { response: res } = await fetchWithRetry(
        this.endpointUrl(),
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...this.headers() },
          body: JSON.stringify(body),
          signal,
        },
        {
          signal,
          onRetry: ({ retries }) => setLlmSpanAttribute('llm.retries', retries),
        },
      );

      if (!res.ok) {
        const detail = await res.text().catch(() => '');
        setLlmSpanAttribute('llm.http_status', res.status);
        // A cancelled call is never retryable, whatever the status said.
        const retryable = statusDecision(res.status).retryable && !signal?.aborted;
        yield failure(this.httpError(res.status, detail, model), retryable, res.status);
        return;
      }

      if (stream) {
        yield* this.#streamed(res, request, model, signal);
        return;
      }

      const data: any = await res.json();
      if (signal?.aborted) throw abortError();
      const choice = data?.choices?.[0] ?? {};
      const message = choice.message ?? {};

      const { reasoning, answer } = this.extractReasoning(message);
      // Scratchpad, not reply: one display-only partial before the final.
      if (reasoning) yield { partial: true, parts: [{ type: 'thinking', text: reasoning }] };

      const parts: OutputPart[] = [];
      if (answer) parts.push({ type: 'text', text: answer });
      (Array.isArray(message.tool_calls) ? message.tool_calls : []).forEach((call: any, index: number) => {
        parts.push(this.#toolCall(call?.id, call?.function?.name, parseArguments(call?.function?.arguments ?? '{}'), request, index));
      });

      yield this.#final(this.#withReasoningState(parts, message.reasoning_content, model), choice.finish_reason, Boolean(reasoning), chatUsage(data?.usage), model);
    } catch (err: unknown) {
      // The adapter's own wording, plus whether another model may succeed:
      // a reset after the retries is retryable, a refused connection is not,
      // and an aborted call never is.
      const decision = errorDecision(err);
      yield failure(this.unreachable(errorText(err)), decision.retryable && !signal?.aborted, decision.status);
    }
  }

  /**
   * SSE: display-only partials as the tokens land, then ONE final carrying
   * the complete text, the tool calls and the usage. The final repeats text
   * already streamed, because only finals are stored (contract.ts rule 2);
   * it never carries the thinking.
   */
  async *#streamed(res: Response, request: ChatCompletionsRequest, model: string, signal: AbortSignal | undefined): AsyncGenerator<ModelResponse, void> {
    const splitter = new ThinkStreamSplitter();
    const toolCalls = new Map<number, { id?: string; name?: string; args: string }>();
    let answer = '';
    let answerStarted = false;
    let sawReasoning = false;
    // The reasoning_content field alone, whole, for replaysReasoningContent.
    let reasoningContent = '';
    let finishReason: string | undefined;
    let usage: unknown;

    const thinking = (text: string): ModelResponse => {
      sawReasoning = true;
      return { partial: true, parts: [{ type: 'thinking', text }] };
    };
    const delta = (text: string): ModelResponse => ({ partial: true, parts: [{ type: 'text', text }] });

    // The scratchpad is usually trailed by blank lines; the reply must not
    // open with them, but only the FIRST answer text may be trimmed.
    const openAnswer = (text: string): string => (answerStarted ? text : text.trimStart());

    for await (const chunk of sseChunks(res, signal)) {
      if (chunk?.usage) usage = chunk.usage;
      const finish = chunk?.choices?.[0]?.finish_reason;
      if (finish) finishReason = finish;
      const d = chunk?.choices?.[0]?.delta;
      if (!d) continue;

      // Reasoning as a discrete field (Ollama `reasoning`, others
      // `reasoning_content`) — already separated, no tag parsing needed.
      const fieldReasoning: string = d.reasoning ?? d.reasoning_content ?? '';
      if (fieldReasoning) yield thinking(fieldReasoning);
      if (typeof d.reasoning_content === 'string') reasoningContent += d.reasoning_content;

      if (typeof d.content === 'string' && d.content) {
        const split = splitter.push(d.content);
        if (split.reasoning) yield thinking(split.reasoning);
        if (split.answer) {
          const text = openAnswer(split.answer);
          if (text) {
            answerStarted = true;
            answer += text;
            yield delta(text);
          }
        }
      }

      // Tool arguments arrive as fragments keyed by index, not whole.
      for (const call of Array.isArray(d.tool_calls) ? d.tool_calls : []) {
        const index = call.index ?? 0;
        const acc = toolCalls.get(index) ?? { args: '' };
        if (call.id) acc.id = call.id;
        if (call.function?.name) acc.name = call.function.name;
        if (call.function?.arguments) acc.args += call.function.arguments;
        toolCalls.set(index, acc);
      }
    }

    const tail = splitter.flush();
    if (tail.reasoning) yield thinking(tail.reasoning);
    if (tail.answer) {
      const text = openAnswer(tail.answer);
      if (text) {
        answer += text;
        yield delta(text);
      }
    }

    const parts: OutputPart[] = [];
    if (answer) parts.push({ type: 'text', text: answer });
    [...toolCalls.entries()]
      .sort((a, b) => a[0] - b[0])
      .forEach(([, acc], index) => parts.push(this.#toolCall(acc.id, acc.name, parseArguments(acc.args || '{}'), request, index)));

    yield this.#final(this.#withReasoningState(parts, reasoningContent, model), finishReason, sawReasoning, chatUsage(usage), model);
  }

  /**
   * The one final that closes a call that got a completion, on both paths.
   *
   * An empty reply after thinking is an error (ADR 0027): the model thought
   * its way out of its budget ("length") or stopped with nothing to say,
   * and naming it lets the caller see why. It still carries the usage, so
   * the tokens spent thinking are counted. A bare empty final (no reasoning,
   * no truncation: a model with nothing to add after a tool result) passes
   * through. A reply cut short but started keeps its text, as `max_tokens`.
   */
  #final(parts: OutputPart[], finishReason: string | undefined, sawReasoning: boolean, usage: Usage | undefined, model: string): FinalModelResponse {
    if (finishReason) setLlmSpanAttribute('llm.finish_reason', finishReason);
    const truncated = finishReason === 'length';
    if (parts.length === 0 && (truncated || sawReasoning)) {
      const noAnswer: FinalModelResponse = {
        partial: false,
        parts: [],
        finishReason: truncated ? 'max_tokens' : 'stop',
        ...(usage ? { usage } : {}),
        error: { ...scrubbed(this.noAnswerError(truncated, model)), retryable: false },
      };
      NO_ANSWER.add(noAnswer);
      return noAnswer;
    }
    return { partial: false, parts, finishReason: finishReasonOf(finishReason, parts), ...(usage ? { usage } : {}) };
  }

  /**
   * A call the provider made. Its own id, else one the engine makes from the
   * conversation's length and the call's index, under ADK's prefix.
   */
  #toolCall(id: unknown, name: unknown, args: Record<string, unknown>, request: ModelRequest, index: number): ToolCallPart {
    const callName = typeof name === 'string' ? name : '';
    return {
      type: 'toolCall',
      id: typeof id === 'string' && id ? id : `${ENGINE_CALL_ID_PREFIX}${request.messages.length}-${index}-${callName}`,
      name: callName,
      args,
    };
  }

  /**
   * `parts` with the response's reasoning_content as providerState on the
   * first one, the part it preceded (ADR 0046), when this adapter replays it.
   * A response with no part has nothing to carry it and nothing to replay.
   */
  #withReasoningState(parts: OutputPart[], reasoningContent: unknown, model: string): OutputPart[] {
    if (!this.replaysReasoningContent(model) || typeof reasoningContent !== 'string' || !reasoningContent || parts.length === 0) {
      return parts;
    }
    const [first, ...rest] = parts;
    return [{ ...first, providerState: { provider: this.provider, kind: REASONING_CONTENT_KIND, model, payload: reasoningContent } }, ...rest];
  }

  // ── The request body ───────────────────────────────────────────────────────

  /** The chat messages this adapter sends for a request, the system message first. */
  messagesFor(request: ChatCompletionsRequest): ChatMessage[] {
    return this.#messages(request, request.model || this.model);
  }

  /** The function tools this adapter sends for a request: none under `toolChoice: 'none'`. */
  toolsFor(request: ModelRequest): Array<Record<string, unknown>> {
    return request.toolChoice === 'none' ? [] : (request.tools ?? []).map(functionTool);
  }

  #body(request: ChatCompletionsRequest, model: string, stream: boolean): Record<string, unknown> {
    const choice: ToolChoice = request.toolChoice ?? 'auto';
    const tools = this.toolsFor(request);
    const sampling = request.sampling ?? {};
    const body: Record<string, unknown> = {
      model: this.wireModelName(model),
      messages: this.#messages(request, model),
      stream,
      // SSE reports token usage only if asked, in a final choices-less chunk.
      ...(stream && this.supportsStreamUsage() ? { stream_options: { include_usage: true } } : {}),
      ...(sampling.temperature !== undefined ? { temperature: sampling.temperature } : {}),
      ...(sampling.topP !== undefined ? { top_p: sampling.topP } : {}),
      ...(sampling.maxOutputTokens !== undefined ? { max_tokens: sampling.maxOutputTokens } : {}),
      ...(sampling.stop?.length ? { stop: [...sampling.stop] } : {}),
      ...this.reasoningFields(model, request.reasoning, request.olderSpelling?.reasoningEffort),
      ...(tools.length > 0 ? { tools } : {}),
      ...(tools.length > 0 ? this.#toolChoice(choice, model, request.reasoning) : {}),
      ...this.#responseFormat(request),
      ...this.extraBodyFields(request),
    };
    this.#nativeTools(request.nativeTools ?? [], body, model);
    return body;
  }

  /**
   * `tool_choice` for a forced choice the provider honours. Otherwise the span
   * says it was weakened, and a named choice goes as `required` where that
   * holds (still a forced call, of some declared tool), anything else as auto.
   */
  #toolChoice(choice: ToolChoice, model: string, reasoning: ReasoningSetting | undefined): Record<string, unknown> {
    if (choice === 'auto' || choice === 'none') return {};
    const mode: ToolChoiceMode = choice === 'required' ? 'required' : 'named';
    const modes = this.toolChoiceModes(model, reasoning);
    if (!modes.includes(mode)) {
      setLlmSpanAttribute('llm.tool_choice.weakened', mode);
      return mode === 'named' && modes.includes('required') ? { tool_choice: 'required' } : {};
    }
    return { tool_choice: choice === 'required' ? 'required' : { type: 'function', function: { name: choice.name } } };
  }

  /**
   * Structured output: a strict json_schema response_format, the schema in
   * its strict form, on every chat-completions provider (Ollama from 0.5.0
   * enforces it with grammar-constrained decoding, ADR 0096).
   * `outputFormat: 'json'` without a schema is JSON mode (ADR 0061); each
   * of Ollama, Kimi and the gateway takes it.
   */
  #responseFormat(request: ChatCompletionsRequest): Record<string, unknown> {
    if (request.outputSchema) {
      return { response_format: { type: 'json_schema', json_schema: { name: 'response', strict: true, schema: toStrictJsonSchema(request.outputSchema) } } };
    }
    return request.outputFormat === 'json' ? { response_format: { type: 'json_object' } } : {};
  }

  /** web_search through the provider's own fields where it has them; every other native tool is dropped, and said so. */
  #nativeTools(named: readonly NativeTool[], body: Record<string, unknown>, model: string): void {
    const tools = [...new Set(named)];
    if (!tools.length) return;
    const search = tools.includes('web_search') ? this.webSearchBodyFields() : null;
    if (search) {
      Object.assign(body, search);
      setLlmSpanAttribute('llm.web_search.native', true);
    }
    const dropped = tools.filter((t) => !(t === 'web_search' && search));
    if (!dropped.length) return;
    if (dropped.includes('web_search')) setLlmSpanAttribute('llm.web_search.omitted', true);
    setLlmSpanAttribute('llm.capability.dropped', dropped.join(','));
    const via = this.transport().startsWith('gateway')
      ? ` through ${this.transport()} (a gateway cannot enable upstream native search)`
      : '';
    for (const tool of dropped) {
      this.#warnOnce(
        `tool:${tool}`,
        tool === 'web_search'
          ? `⚠ web_search requested but ${model}${via} has no native web search — tool omitted (the agent runs without search).`
          : `⚠ ${tool} requested but ${model}${via} cannot run it — tool omitted (the agent runs without it).`,
      );
    }
  }

  /** The conversation as chat messages: see the header. */
  #messages(request: ChatCompletionsRequest, model: string): ChatMessage[] {
    const system: string[] = request.system ? [request.system] : [];
    const messages: ChatMessage[] = [];
    // reasoning_content goes back only on the current turn's tool loop, the
    // span providers ask for it on. Earlier turns' state is left out: the
    // stored history is not what the model saw (tool payloads are elided
    // before storage), and replaying it bills it again as input (ADR 0046).
    const turnStart = this.replaysReasoningContent(model) ? currentTurnStart(request.messages) : Infinity;

    request.messages.forEach((message, index) => {
      switch (message.role) {
        case 'system': {
          const text = message.parts
            .map((p) => p.text)
            .filter(Boolean)
            .join('\n');
          if (text) system.push(text);
          return;
        }
        case 'user': {
          const texts: string[] = [];
          const images: ChatContentPart[] = [];
          for (const part of message.parts) {
            if (part.type === 'text') {
              if (part.text) texts.push(part.text);
            } else if (part.data) {
              // Inline only: a data URI for vision models. A URL blob is not
              // sent (Moonshot takes no public image URLs).
              images.push({ type: 'image_url', image_url: { url: `data:${part.mimeType || 'image/png'};base64,${part.data}` } });
            }
          }
          const text = texts.join('\n');
          if (text || images.length > 0) {
            messages.push({
              role: 'user',
              content: images.length > 0 ? [...(text ? [{ type: 'text', text } as const] : []), ...images] : text,
            });
          }
          return;
        }
        case 'assistant': {
          const replay = index > turnStart;
          const texts: string[] = [];
          const reasoning: string[] = [];
          const calls: ChatToolCall[] = [];
          for (const part of message.parts) {
            // This adapter's own reasoning_content for this message, verbatim.
            // Another provider's state, or another model's, is skipped.
            const state = replay ? providerStateOf(part, this.provider, REASONING_CONTENT_KIND, model) : undefined;
            if (typeof state?.payload === 'string') reasoning.push(state.payload);
            if (part.type === 'thinking') continue; // display-only; never replayed
            if (part.type === 'text') {
              if (part.text) texts.push(part.text);
            } else if (part.type === 'toolCall') {
              calls.push({
                id: part.id || `call_${calls.length}`,
                type: 'function',
                function: { name: part.name, arguments: JSON.stringify(part.args ?? {}) },
              });
            }
          }
          const text = texts.join('\n');
          if (text || calls.length > 0) {
            messages.push({
              role: 'assistant',
              content: text || null,
              ...(reasoning.length > 0 ? { reasoning_content: reasoning.join('') } : {}),
              ...(calls.length > 0 ? { tool_calls: calls } : {}),
            });
          }
          return;
        }
        case 'tool':
          for (const part of message.parts) messages.push({ role: 'tool', tool_call_id: part.id, content: resultContent(part) });
          return;
      }
    });

    if (system.length > 0) messages.unshift({ role: 'system', content: system.join('\n\n') });
    return messages;
  }

  #warnOnce(key: string, message: string): void {
    if (this.#warned.has(key)) return;
    this.#warned.add(key);
    console.warn(message);
  }
}

/** A tool declaration as a function tool: the schema as written, or its strict form with `strict: true`. */
function functionTool(tool: ToolDeclaration): Record<string, unknown> {
  return {
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.strict ? toStrictJsonSchema(tool.parameters) : tool.parameters,
      ...(tool.strict ? { strict: true } : {}),
    },
  };
}

/** The message with key-shaped text removed: an error never carries a key. */
function scrubbed(failure: ChatFailure): ChatFailure {
  return { code: failure.code, message: errorText(failure.message) };
}

/** An error final: no parts, the code and message, the retry verdict and the status. */
function failure(f: ChatFailure, retryable: boolean, status?: number): FinalModelResponse {
  const error: ModelError = { ...scrubbed(f), retryable, ...(status !== undefined ? { status } : {}) };
  return { partial: false, parts: [], finishReason: 'error', error };
}
