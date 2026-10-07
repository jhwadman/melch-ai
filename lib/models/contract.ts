/**
 * lib/models/contract.ts — the engine's own model contract: the message
 * format, request, response and adapter interface that every model adapter
 * implements and the native runtime calls (ADR 0045, ADR 0048).
 *
 * WHY this file exists:
 *   The ADK runtime speaks @google/genai `Content`, which is Gemini's wire
 *   format. It has no slot for another provider's reasoning state, spells
 *   schemas in Gemini's uppercase dialect, carries server-side tools as
 *   sentinel tool objects, and surfaces failures as a throw on one path and
 *   a yielded `errorCode` on another. The native runtime owns its loop, so it
 *   owns this format instead. Each adapter translates it to its provider's
 *   wire; wiki/models/model-contract.md is the field-by-field spec, with the
 *   mapping for every provider.
 *
 * A LEAF: types only, and the one import is ProviderState (ADR 0046).
 *   Nothing in this module's import graph names @google/*;
 *   tests/modelContract.test.ts asserts it. The loader imports
 *   ReasoningSetting from here, never the other way round.
 *
 * THE ADAPTER RULES (ModelAdapter.generate):
 *   1. Partial responses carry deltas: text, and thinking for display.
 *      With `stream: false` an adapter yields no text partials; it may
 *      yield the thinking as one partial before the final.
 *   2. Exactly one final response (`partial: false`) ends every call, and
 *      nothing follows it. It holds the complete answer: every text part in
 *      full (repeating what partials streamed, because the runtime stores
 *      only finals), every tool call, the usage. It never holds thinking.
 *   3. A failure is a final response with `error` set, never a throw, and
 *      never a rejected iterator: a missing key, an HTTP error, a dropped
 *      stream, a model that thought without answering (ADR 0027).
 *   4. `request.signal` stops the request in flight. An aborted call ends at
 *      once, with a final response carrying the adapter's ordinary failure
 *      code and `retryable: false`, so no fallback answers a cancellation.
 *      The runtime knows it was aborted from its own signal.
 *   5. Retries of transient failures happen inside generate()
 *      (lib/models/retry.ts), and only before the first partial is yielded.
 */

import type { ProviderState } from './providerState.ts';

export type { ProviderState } from './providerState.ts';

// ── Schemas ──────────────────────────────────────────────────────────────────

/**
 * A JSON Schema in the standard lowercase dialect (`type: 'object'`), never
 * Gemini's uppercase one (`'OBJECT'`). An adapter whose provider needs a
 * narrower dialect (OpenAI strict mode) derives it at request time.
 */
export type JsonSchema = Record<string, unknown>;

// ── Parts ────────────────────────────────────────────────────────────────────

interface PartBase {
  /**
   * Provider-opaque state for the next request of a tool loop (ADR 0046).
   * The adapter that produced the response writes it on the text, toolCall
   * or blob part it belongs before. Only an adapter of the same provider
   * replays it (`providerStateOf`); every other adapter ignores it. Every
   * part kind may carry it, so a mapping from stored history never loses it.
   */
  providerState?: ProviderState;
}

/** Text the model wrote, or text the person sent. */
export interface TextPart extends PartBase {
  type: 'text';
  text: string;
}

/**
 * The model's reasoning, as the provider shows it (a summary or the trace).
 * Display only: an adapter never sends a thinking part's text to a model.
 */
export interface ThinkingPart extends PartBase {
  type: 'thinking';
  text: string;
}

/** The model asks for a client-side tool to run. */
export interface ToolCallPart extends PartBase {
  type: 'toolCall';
  /**
   * Always set. The provider's call id, or one the adapter made when the
   * provider returns none (Gemini). The matching toolResult echoes it.
   */
  id: string;
  name: string;
  /**
   * The parsed arguments. Arguments the provider returned as text that does
   * not parse are kept as `{ raw: '<text>' }`.
   */
  args: Record<string, unknown>;
}

/** A tool's answer to one ToolCallPart. */
export interface ToolResultPart extends PartBase {
  type: 'toolResult';
  /** The id of the ToolCallPart this answers. */
  id: string;
  /** The tool's name: Gemini matches a result to its call by name. */
  name: string;
  /** JSON-serializable. */
  result: unknown;
  /** True when the tool failed and `result` describes the failure. Absent means false. */
  isError?: boolean;
}

/** Binary content: inline as base64, or by URL. Exactly one of `data` and `url`. */
export type BlobPart = PartBase & { type: 'blob'; mimeType: string } & (
    | { data: string; url?: never }
    | { url: string; data?: never }
  );

export type Part = TextPart | ThinkingPart | ToolCallPart | ToolResultPart | BlobPart;

/** What a model may produce in a final response. */
export type OutputPart = TextPart | ToolCallPart | BlobPart;

// ── Messages ─────────────────────────────────────────────────────────────────

/**
 * An instruction inside the history (a compaction summary, a turn-scoped
 * note). An adapter whose provider has no system role there appends its
 * text to the system prompt, after `ModelRequest.system`, in order.
 */
export interface SystemMessage {
  role: 'system';
  parts: TextPart[];
}

export interface UserMessage {
  role: 'user';
  parts: Array<TextPart | BlobPart>;
}

/** A model's earlier turn: a final response's parts, plus any thinking stored with them. */
export interface AssistantMessage {
  role: 'assistant';
  parts: Array<OutputPart | ThinkingPart>;
}

/** The results of one assistant message's tool calls, one part per call. */
export interface ToolMessage {
  role: 'tool';
  parts: ToolResultPart[];
}

export type Message = SystemMessage | UserMessage | AssistantMessage | ToolMessage;

export type Role = Message['role'];

// ── Tools ────────────────────────────────────────────────────────────────────

/** A client-side tool the model may call; the runtime runs it. */
export interface ToolDeclaration {
  name: string;
  description: string;
  /** The arguments' schema, lowercase JSON Schema. */
  parameters: JsonSchema;
  /**
   * Ask the provider to enforce `parameters` on the arguments it generates.
   * Where the provider has no such switch the declaration is sent without it.
   */
  strict?: boolean;
}

/**
 * A tool the provider runs on its own side. The request names it; the
 * adapter adds the provider's own tool object, or drops it when the path
 * cannot run it (lib/models/capabilities.ts states which). Options such as
 * xAI's domain filters and collection ids stay deployment configuration the
 * adapter reads, never request fields.
 */
export type NativeTool =
  /** The provider's own web search: Gemini grounding, Anthropic, OpenAI, xAI. */
  | 'web_search'
  /** Gemini grounding, kept for YAMLs that name it. */
  | 'google_search'
  /** Gemini reads the URLs in the conversation. */
  | 'url_context'
  /** xAI's search over X posts. */
  | 'x_search'
  /** xAI's search over hosted document collections. */
  | 'collections_search'
  /** Gemini runs code it writes (the agent's `code_execution: gemini`). */
  | 'code_execution';

/**
 * Which tools the model may call. A preference: an adapter sends it as
 * asked where the provider allows it and weakens it where the provider
 * rejects forcing (Anthropic's Fable 5.1, Opus 5.5 and Sonnet 5.5 reject a
 * forced tool choice, as do Claude models with thinking on). A weakened
 * `required` or named choice becomes `auto`, and the span carries
 * `llm.tool_choice.weakened`. `none` is always honoured, if need be by
 * sending no tools.
 */
export type ToolChoice = 'auto' | 'none' | 'required' | { name: string };

// ── Reasoning ────────────────────────────────────────────────────────────────

/**
 * How hard an agent reasons, on any provider (ADR 0047): a level, or a token
 * budget. A budget of 0 is `none`, and `none` means as little reasoning as
 * the model allows.
 */
export type ReasoningLevel = 'none' | 'low' | 'medium' | 'high';
export type ReasoningSetting = ReasoningLevel | { budget_tokens: number };

// ── Request ──────────────────────────────────────────────────────────────────

export interface Sampling {
  temperature?: number;
  topP?: number;
  /** The answer's token ceiling. Where thinking counts against it, the adapter raises it to fit (ADR 0047). */
  maxOutputTokens?: number;
  /** Stop sequences. */
  stop?: string[];
}

export interface ModelRequest {
  /**
   * The model id as the YAML names it (`claude-sonnet-4-6`,
   * `ollama/qwen3:8b`). The adapter maps it to the wire name (a platform's
   * model map, a gateway's id, the `ollama/` prefix stripped). It equals the
   * adapter's own `model`; a fallback wrapper rewrites it when it hands the
   * request on.
   */
  model: string;
  /** The system prompt. */
  system?: string;
  /** The conversation, oldest first. */
  messages: Message[];
  /** Client-side tools. */
  tools?: ToolDeclaration[];
  /** Provider-side tools, by name. */
  nativeTools?: NativeTool[];
  /** Default `auto`. */
  toolChoice?: ToolChoice;
  /**
   * The answer must be one JSON object matching this lowercase JSON Schema.
   * The answer arrives as the text of the final response. It may sit beside
   * tools: the model calls tools, then answers in the schema.
   */
  outputSchema?: JsonSchema;
  /**
   * Each adapter maps the setting to its own provider's field, so a
   * fallback model gets its own mapping, never the primary's. Absent means
   * the provider's or the adapter's default.
   */
  reasoning?: ReasoningSetting;
  sampling?: Sampling;
  /** Stream text and thinking deltas as partial responses. */
  stream?: boolean;
  /** Aborts the request in flight (the turn's signal, lib/runtime/turnControl.ts). */
  signal?: AbortSignal;
}

// ── Response ─────────────────────────────────────────────────────────────────

/**
 * Why the model stopped. `tool_call` whenever the final carries a toolCall
 * part, whatever the provider reported. `content_filter` covers a provider
 * withholding or refusing an answer on policy grounds. `error` when the call
 * failed before the model stopped on its own.
 */
export type FinishReason = 'stop' | 'tool_call' | 'max_tokens' | 'content_filter' | 'error' | 'other';

/**
 * Token counts for the call, retries included. `inputTokens` counts every
 * input token, cached ones too; the cache counts are parts of it.
 * `outputTokens` counts every generated token, thinking too;
 * `thinkingTokens` is the part of it spent thinking.
 */
export interface Usage {
  inputTokens: number;
  outputTokens: number;
  thinkingTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

/** A source the answer cites. */
export interface Citation {
  url: string;
  title?: string;
  /** The passage of the source that supports the answer. */
  citedText?: string;
  /**
   * The answer span this citation supports: UTF-16 offsets into the
   * concatenated text parts of the final response, end exclusive. Absent
   * when the provider gives no span.
   */
  start?: number;
  end?: number;
}

/** One query a native tool ran on the provider's side. */
export interface SearchQuery {
  tool: NativeTool;
  query: string;
}

/** What the answer rests on, when the provider searched or cited. */
export interface Grounding {
  citations?: Citation[];
  /** In the order they ran. The ledger counts them as server-side tool calls. */
  searchQueries?: SearchQuery[];
}

/** Configuration and installation failures any adapter reports before it calls. */
type SetupErrorCode = 'MISSING_API_KEY' | 'ENDPOINT_MISCONFIGURED' | 'SDK_NOT_INSTALLED';

/** The chat-completions failures, under the provider's id (the gateway names the upstream provider). */
type ChatErrorCode =
  | `${'MOONSHOT' | 'OLLAMA' | 'GEMINI' | 'ANTHROPIC' | 'OPENAI' | 'XAI'}_${'MAX_TOKENS' | 'EMPTY_RESPONSE' | 'UNREACHABLE'}`
  | 'MOONSHOT_MISSING_KEY'
  | 'MOONSHOT_HTTP_ERROR'
  | 'OLLAMA_HTTP_ERROR'
  | 'GATEWAY_NOT_CONFIGURED'
  | 'GATEWAY_KEY_MISSING'
  | 'GATEWAY_HTTP_ERROR';

/**
 * Gemini's codes: ADK's adapter reports a candidate's finish reason, or the
 * prompt's block reason, as the code itself. GEMINI_ERROR is a failed call,
 * which ADK throws and the contract reports.
 */
type GeminiErrorCode =
  | 'GEMINI_ERROR'
  | 'MAX_TOKENS'
  | 'SAFETY'
  | 'RECITATION'
  | 'LANGUAGE'
  | 'OTHER'
  | 'BLOCKLIST'
  | 'PROHIBITED_CONTENT'
  | 'SPII'
  | 'MALFORMED_FUNCTION_CALL'
  | 'IMAGE_SAFETY'
  | 'UNEXPECTED_TOOL_CALL'
  | 'TOO_MANY_TOOL_CALLS'
  | 'IMAGE_PROHIBITED_CONTENT'
  | 'NO_IMAGE'
  | 'IMAGE_RECITATION'
  | 'IMAGE_OTHER'
  | 'MODEL_ARMOR'
  | 'JAILBREAK'
  | 'UNKNOWN_ERROR';

/**
 * The turn's controls (lib/runtime/turnControl.ts): the shared choke point
 * every adapter's calls pass through answers with one of these, in place of
 * the call, once the turn's step budget is spent or the turn has stopped.
 */
type TurnControlErrorCode = 'STEP_LIMIT' | 'DEADLINE_EXCEEDED' | 'CANCELED';

/**
 * The codes the engine's adapters report, kept verbatim from what they emit
 * under ADK so a caller matching on a code keeps working. An adapter the
 * engine does not ship may report its own; the engine's adapters use only
 * these, and adding one is a change to wiki/models/model-contract.md.
 */
export type KnownModelErrorCode =
  | SetupErrorCode
  | TurnControlErrorCode
  | 'ANTHROPIC_ERROR'
  | `${'OPENAI' | 'XAI'}_${'ERROR' | 'STREAM_ERROR'}`
  | ChatErrorCode
  | GeminiErrorCode;

export type ModelErrorCode = KnownModelErrorCode | (string & {});

export interface ModelError {
  code: ModelErrorCode;
  /** For a person: what failed, and the fix when there is one. Never a key. */
  message: string;
  /**
   * True when a later attempt, or another model, may succeed: a rate limit,
   * an overloaded or unreachable provider (lib/models/retry.ts classifies
   * it). The fallback model (ADR 0044) answers only retryable failures.
   */
  retryable: boolean;
  /** The provider's HTTP status, when the failure had one. */
  status?: number;
}

/** A delta while the model writes. */
export interface PartialModelResponse {
  partial: true;
  parts: Array<TextPart | ThinkingPart>;
}

/** The one response that ends a call. */
export interface FinalModelResponse {
  partial: false;
  parts: OutputPart[];
  /** When `error` is set: how the model stopped, if it did (`max_tokens`), else `error`. */
  finishReason: FinishReason;
  usage?: Usage;
  grounding?: Grounding;
  /** Set when the call failed. The parts are then whatever was produced before it failed. */
  error?: ModelError;
}

export type ModelResponse = PartialModelResponse | FinalModelResponse;

// ── Adapter ──────────────────────────────────────────────────────────────────

/** One provider's model behind the contract. The rules are in this file's header. */
export interface ModelAdapter {
  /**
   * The provider id (lib/models/providerMap.ts) that telemetry attributes the
   * call to, and that ProviderState carries. A gateway adapter reports the
   * upstream provider of its id, never `gateway`.
   */
  readonly provider: string;
  /** The model id this adapter serves, as the YAML names it. */
  readonly model: string;
  generate(request: ModelRequest): AsyncIterable<ModelResponse>;
}

// ── Capabilities ─────────────────────────────────────────────────────────────

export type CapabilitySupport = 'supported' | 'degraded' | 'unsupported';

export interface CapabilityClaim {
  support: CapabilitySupport;
  /** What is lost, or what happens instead. Present unless `supported` is the whole story. */
  note?: string;
}

export type ToolChoiceMode = 'auto' | 'none' | 'required' | 'named';

/**
 * What an adapter sends for one model on one platform, so the capability
 * matrix (lib/models/capabilities.ts, ADR 0019) can be derived from the
 * adapters instead of written beside them. Models within one provider
 * differ (Claude 4.6 takes sampling fields that Claude 5.5 rejects), so an
 * adapter states this per model. Each field names the matrix column it
 * feeds.
 */
export interface ProviderCapabilities {
  /** Client-side tools reach the model. Feeds `delegation` and `memory_tools`. */
  tools: CapabilityClaim;
  /** `outputSchema` is enforced by the provider. Feeds `structured_output`. */
  outputSchema: CapabilityClaim;
  /** providerState is replayed across tool steps. Feeds `thinking_with_tools`. */
  reasoningState: CapabilityClaim;
  /** Text arrives as deltas. Feeds `streaming`. */
  streaming: CapabilityClaim;
  /** Blob parts reach the model. Feeds `vision`. */
  blobs: CapabilityClaim & {
    /** The MIME types sent, e.g. `image/*`. */
    mimeTypes: string[];
    /** Whether a URL blob is sent as a URL; otherwise the adapter must inline it. */
    urls: boolean;
    /** Whether blobs are sent outside user messages. */
    outsideUserTurns: boolean;
  };
  /** Native tools sent on this path; a tool not listed is dropped. Feeds `native_search` (its `web_search`). */
  nativeTools: Partial<Record<NativeTool, CapabilityClaim>>;
  /** The toolChoice modes sent as asked; the rest are weakened to `auto`. */
  toolChoice: ToolChoiceMode[];
  /** The wire form a ReasoningSetting takes: a level, a token budget, an effort word, or nothing. */
  reasoning: 'level' | 'budget' | 'effort' | 'none';
  /** The sampling fields sent; the rest are dropped. */
  sampling: Array<keyof Sampling>;
}
