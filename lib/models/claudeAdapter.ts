/**
 * lib/models/claudeAdapter.ts — Anthropic Claude behind the engine's own
 * model contract (lib/models/contract.ts, ADR 0048), on the Messages API.
 *
 * WHY this file exists:
 *   Claude's translation reads a ModelRequest and yields ModelResponses, so
 *   the native runtime (ADR 0045) can call it with no ADK in the path. On
 *   the ADK path, ClaudeLlm (lib/models/claudeLlm.ts) is this adapter behind
 *   the ADK shim (lib/models/adkShim.ts, ADR 0053): the shim charges the
 *   turn and opens the llm.request span, and this adapter only decorates
 *   that span with setLlmSpanAttribute.
 *
 * THE MAPPING is the Anthropic table of wiki/models/model-contract.md;
 * wiki/models/claude-adapter.md records the choices made inside it:
 *   - The request follows the model generation (lib/models/claudeModels.ts,
 *     ADR 0049): a thinking budget on Claude 4.6 and earlier; adaptive
 *     thinking with output_config.effort, a summarized display and each
 *     model's own off switch after; `drop_block` under its beta where
 *     thinking is bound to the conversation; output_config.format where
 *     forced tool use is gone; no sampling parameter on any generation.
 *   - Signed `thinking` and `redacted_thinking` blocks ride, verbatim, on
 *     the part they preceded as providerState (ADR 0046), and are replayed
 *     before that part within the current turn's tool loop, for this model
 *     only.
 *   - A tool result's content is the JSON of the result in the shape the ADK
 *     path stores it (`{ result }` for a value that is not an object,
 *     `{ error }` for a failure), so both runtimes send the same bytes
 *     (ADR 0055).
 *   - ClaudeLlm adds `claudeReasoning`, the older reasoning spelling read as
 *     ADR 0049 reads it, which this adapter reads in place of `reasoning`
 *     (ClaudeModelRequest, ADR 0055). The native runtime never sets it.
 *
 * THE ADAPTER RULES (contract.ts header) as this adapter keeps them:
 *   - Errors are finals, never throws: MISSING_API_KEY,
 *     ENDPOINT_MISCONFIGURED and SDK_NOT_INSTALLED before the call, and
 *     ANTHROPIC_ERROR for a failed call, with lib/models/retry.ts's verdict
 *     and the HTTP status.
 *   - The abort signal goes to the SDK (it aborts its fetch) and also ends
 *     the call at once, never retryable.
 *   - Transient failures are retried by the Anthropic SDK itself (its own
 *     two retries), before anything is yielded.
 */

import type {
  BlobPart,
  Citation,
  FinalModelResponse,
  FinishReason,
  JsonSchema,
  ModelAdapter,
  ModelError,
  ModelRequest,
  ModelResponse,
  NativeTool,
  OutputPart,
  Part,
  SearchQuery,
  ToolDeclaration,
  ToolResultPart,
  Usage,
} from './contract.ts';
import { setLlmSpanAttribute } from '../observability/tracer.ts';
import { currentTurnSignal } from '../runtime/turnControl.ts';
import { toContractJsonSchema } from './schemaNormalize.ts';
import { claudeClientSpec, endpointFromEnv, endpointLabel, instantiateClient, nativeSearchOn, platformModel, SdkMissingError } from './endpoints.ts';
import type { ProviderEndpoint } from './endpoints.ts';
import { currentTurnStart, providerStateOf, withProviderState } from './providerState.ts';
import { errorDecision, errorText } from './errorResponse.ts';
import { adaptiveThinkingFor, claudeGeneration, claudeReasoningOf, claudeUrlImagesOn, THINKING_BINDING_BETA } from './claudeModels.ts';
import type { ClaudeReasoning } from './claudeModels.ts';

/** The provider id this adapter reports and writes its state under (lib/models/providerMap.ts). */
export const ANTHROPIC_PROVIDER = 'anthropic';

/** The providerState kind this adapter writes: the signed blocks that preceded a part. */
export const THINKING_STATE_KIND = 'thinking_blocks';

/** Name of the tool that carries an outputSchema answer where output_config.format is not used. */
export const STRUCTURED_OUTPUT_TOOL = 'structured_output';

/**
 * A ModelRequest as the ADK path's ClaudeLlm hands it to this adapter
 * (ADR 0055). `claudeReasoning` is the agent's older reasoning spelling
 * (generateContentConfig.reasoningEffort and thinkingConfig.thinkingBudget)
 * read as ADR 0049 reads it, which `reasoning` cannot say in full: the effort
 * words `xhigh` and `max`, `minimal` as `low`, and the budget rows' reading
 * of the budget alone. When set it is read in place of `reasoning`. The
 * native runtime never sets it.
 */
export interface ClaudeModelRequest extends ModelRequest {
  claudeReasoning?: ClaudeReasoning;
}

// ── Wire types (the SDK is imported dynamically, so it may be absent) ────────

type AnthropicMessage = {
  role: 'user' | 'assistant';
  content: AnthropicContentBlock[];
};

type AnthropicContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; tool_use_id: string; content: string; is_error?: true }
  | AnthropicImageBlock
  | SignedThinkingBlock;

type AnthropicImageBlock = {
  type: 'image';
  source: { type: 'base64'; media_type: string; data: string } | { type: 'url'; url: string };
};

/** A `thinking` or `redacted_thinking` block exactly as the API returned it. */
type SignedThinkingBlock = { type: 'thinking' | 'redacted_thinking' } & Record<string, unknown>;

/** A tool definition as the Messages API takes it: a client tool, or Anthropic's web search server tool. */
export type AnthropicTool =
  | { name: string; description: string; input_schema: JsonSchema; strict?: true }
  | { type: 'web_search_20250305'; name: 'web_search'; max_uses: number };

/** Anthropic's server-side web search: it runs on Anthropic's side and grounds the reply. */
const WEB_SEARCH_TOOL: AnthropicTool = { type: 'web_search_20250305', name: 'web_search', max_uses: 5 };

/** Anthropic's minimum extended-thinking budget. */
const MIN_THINKING_BUDGET = 1024;

const isSignedThinking = (b: any): b is SignedThinkingBlock =>
  !!b && typeof b === 'object' && (b.type === 'thinking' || b.type === 'redacted_thinking');

// ── Images ───────────────────────────────────────────────────────────────────

/** The image media types the Messages API accepts. */
const ANTHROPIC_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);

/**
 * A blob type that names nothing: absent, or `application/octet-stream`,
 * which the genai mapping writes for a part that names no type.
 */
const UNTYPED = new Set(['', 'application/octet-stream']);

/** The type a file extension names, for a URL image that names none. */
const EXTENSION_TYPES: Readonly<Record<string, string>> = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp',
  svg: 'image/svg+xml', bmp: 'image/bmp', tif: 'image/tiff', tiff: 'image/tiff', ico: 'image/x-icon',
  heic: 'image/heic', heif: 'image/heif', avif: 'image/avif',
  pdf: 'application/pdf', txt: 'text/plain', md: 'text/markdown', csv: 'text/csv', json: 'application/json',
  html: 'text/html', htm: 'text/html', xml: 'application/xml', zip: 'application/zip',
  mp3: 'audio/mpeg', wav: 'audio/wav', mp4: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm',
};

/** The type the last path segment's extension names, or undefined (no extension, or one not listed). */
function typeFromUrl(uri: string): string | undefined {
  let path: string;
  try {
    path = new URL(uri).pathname;
  } catch {
    return undefined;
  }
  const ext = /\.([a-z0-9]+)$/i.exec(path)?.[1].toLowerCase();
  return ext ? EXTENSION_TYPES[ext] : undefined;
}

/** What llm.image.dropped says for a URL image on a platform that takes base64 only. */
const URL_SOURCE = 'URL source';

/**
 * A user-message blob → an Anthropic image block: inline data as a base64
 * source (image/png when it names no type), an https URL as a URL source. A
 * URL that names no type is typed by its extension; with no extension the
 * table knows, it is sent and Anthropic reads the type from the bytes. When
 * the blob would not be accepted, returns what is wrong with it instead (the
 * media type, the URL's scheme, or URL_SOURCE where the platform takes
 * base64 only; never the URL), for the span and the warning. Undefined for
 * a blob with nothing in it.
 */
function imageBlockFor(part: BlobPart, urlImages: boolean): AnthropicImageBlock | string | undefined {
  // The caller's type string reaches a log line and the ledger: printable, short.
  const named = (type: string) => type.replace(/[^\x20-\x7e]/g, '?').slice(0, 64);
  const declared = String(part.mimeType ?? '').toLowerCase();
  const untyped = UNTYPED.has(declared);
  if (part.data !== undefined) {
    if (!part.data) return undefined;
    const mediaType = untyped ? 'image/png' : declared;
    if (!ANTHROPIC_IMAGE_TYPES.has(mediaType)) return named(mediaType);
    return { type: 'image', source: { type: 'base64', media_type: mediaType, data: part.data } };
  }
  const uri = String(part.url ?? '');
  if (!uri) return undefined;
  const mediaType = untyped ? typeFromUrl(uri) : declared;
  if (mediaType && !ANTHROPIC_IMAGE_TYPES.has(mediaType)) return named(mediaType);
  if (!/^https:\/\//i.test(uri)) return `non-https URL (${/^[a-z][a-z0-9+.-]*:/i.exec(uri)?.[0] ?? 'no scheme'})`;
  if (!urlImages) return URL_SOURCE;
  return { type: 'image', source: { type: 'url', url: uri } };
}

// ── Tools ────────────────────────────────────────────────────────────────────

/**
 * A client tool as the Messages API takes it. A strict declaration sends the
 * strict form of its schema (every property required, no others), which
 * Anthropic's strict tool use demands.
 */
function toolDefinition(tool: ToolDeclaration): AnthropicTool {
  return tool.strict
    ? { name: tool.name, description: tool.description, input_schema: toContractJsonSchema(tool.parameters, { strict: true }), strict: true }
    : { name: tool.name, description: tool.description, input_schema: tool.parameters };
}

/**
 * The tool definitions a request names, before the platform is known: its
 * client tools, then Anthropic's web search server tool when `web_search`
 * is among its native tools. The adapter then leaves the server tool off a
 * platform that does not take it.
 */
export function anthropicTools(request: Pick<ModelRequest, 'tools' | 'nativeTools'>): AnthropicTool[] {
  const tools = (request.tools ?? []).map(toolDefinition);
  if (request.nativeTools?.includes('web_search')) tools.push(WEB_SEARCH_TOOL);
  return tools;
}

/** A tool result's content: the JSON of the result in the shape the ADK path stores it. */
function toolResultBlock(part: ToolResultPart): AnthropicContentBlock {
  const response = part.isError ? { error: part.result } : isPlainObject(part.result) ? part.result : { result: part.result };
  return {
    type: 'tool_result',
    tool_use_id: part.id,
    content: JSON.stringify(response) ?? '{}',
    ...(part.isError ? { is_error: true as const } : {}),
  };
}

/**
 * True when the request answers tool calls whose assistant message does not
 * open with a signed thinking block: with thinking on, Anthropic rejects it
 * ("a final assistant message must start with a thinking block").
 */
function continuesUnsignedToolLoop(messages: AnthropicMessage[]): boolean {
  const last = messages[messages.length - 1];
  const prev = messages[messages.length - 2];
  if (last?.role !== 'user' || prev?.role !== 'assistant') return false;
  if (!last.content.some((b) => b.type === 'tool_result')) return false;
  if (!prev.content.some((b) => b.type === 'tool_use')) return false;
  return !isSignedThinking(prev.content[0]);
}

/**
 * An outputSchema as `output_config.format`, through the SDK's own strict-
 * schema transform (`additionalProperties: false` on every object; what
 * structured outputs cannot express moves into the description). When the
 * transform refuses the schema (a root that is not an object, a node with no
 * type), returns why instead.
 */
async function outputFormatFor(schema: JsonSchema): Promise<{ type: 'json_schema'; schema: unknown } | { refused: string }> {
  try {
    const { jsonSchemaOutputFormat } = await import('@anthropic-ai/sdk/helpers/json-schema');
    return { type: 'json_schema', schema: jsonSchemaOutputFormat(schema as any).schema };
  } catch (err) {
    return { refused: err instanceof Error ? err.message : String(err) };
  }
}

// ── The adapter ──────────────────────────────────────────────────────────────

export interface ClaudeAdapterOptions {
  /** The model id as the YAML names it. */
  model: string;
  /** An Anthropic API key: a caller's own, or one the credentials plug point returned. Wins over the endpoint's and ANTHROPIC_API_KEY. */
  apiKey?: string;
  /**
   * Where requests go (ADR 0023): Anthropic's API (or a proxy at its base
   * URL), Bedrock, or Vertex AI. Default: the environment's
   * (`ANTHROPIC_PLATFORM`), read on every call.
   */
  endpoint?: ProviderEndpoint;
}

/** The request body and what the response mapping needs to know about it. */
interface BuiltRequest {
  body: Record<string, unknown>;
  /** The request goes through the SDK's beta namespace, for drop_block's beta. */
  beta: boolean;
  /** The structured-output tool was offered, so its tool_use is the answer's text. */
  structuredTool: boolean;
}

export class ClaudeAdapter implements ModelAdapter {
  readonly provider = ANTHROPIC_PROVIDER;
  readonly model: string;
  readonly #apiKey: string | undefined;
  readonly #endpoint: ProviderEndpoint | undefined;
  #searchDropWarned = false;
  readonly #imageDropWarned = new Set<string>();
  #schemaFallbackWarned = false;

  constructor({ model, apiKey, endpoint }: ClaudeAdapterOptions) {
    this.model = model;
    this.#apiKey = apiKey;
    this.#endpoint = endpoint;
  }

  async *generate(request: ModelRequest): AsyncGenerator<ModelResponse, void> {
    const model = request.model || this.model;
    const signal = request.signal ?? currentTurnSignal();
    if (signal?.aborted) {
      yield failed(Object.assign(new Error('The Anthropic request was aborted.'), { name: 'AbortError' }), signal);
      return;
    }

    let endpoint: ProviderEndpoint;
    try {
      endpoint = this.#endpoint ?? endpointFromEnv('anthropic');
    } catch (err) {
      yield setupFailure('ENDPOINT_MISCONFIGURED', messageOf(err));
      return;
    }
    const spec = claudeClientSpec(endpoint, this.#apiKey || endpoint.apiKey || process.env.ANTHROPIC_API_KEY);
    if ('error' in spec) {
      yield setupFailure(endpoint.platform === 'direct' ? 'MISSING_API_KEY' : 'ENDPOINT_MISCONFIGURED', spec.error);
      return;
    }
    // Loads the SDK (Anthropic's, or its Bedrock or Vertex AI client) only
    // when called, so the framework boots without it for users of other
    // providers. All three share the Messages API. A client per call, so a
    // changed environment takes effect on the next call.
    let client: any;
    try {
      client = await instantiateClient(spec);
    } catch (err) {
      yield setupFailure(err instanceof SdkMissingError ? 'SDK_NOT_INSTALLED' : 'ENDPOINT_MISCONFIGURED', messageOf(err));
      return;
    }

    const built = await this.#build(request, model, endpoint);
    // drop_block needs its beta, which the SDK's beta namespace sends the way
    // each platform takes it (a header; on Bedrock, the anthropic_beta field).
    const api = built.beta ? client.beta.messages : client.messages;
    const options = signal ? { signal } : {};
    try {
      if (request.stream === true) {
        const stream = await api.stream(built.body, options);
        for await (const event of untilAborted(stream as AsyncIterable<any>, signal)) {
          if (event?.type !== 'content_block_delta') continue;
          if (event.delta?.type === 'text_delta' && event.delta.text) {
            yield { partial: true, parts: [{ type: 'text', text: event.delta.text }] };
          } else if (event.delta?.type === 'thinking_delta' && event.delta.thinking) {
            yield { partial: true, parts: [{ type: 'thinking', text: event.delta.thinking }] };
          }
        }
        // The final repeats the streamed text in full: the runtime stores only finals.
        yield finalOf(await untilSettled(stream.finalMessage(), signal), model, built.structuredTool);
      } else {
        const message: any = await untilSettled(api.create(built.body, options), signal);
        // Thinking first, as one display-only partial.
        const thinking = (message?.content ?? [])
          .filter((b: any) => b?.type === 'thinking' && b.thinking)
          .map((b: any) => b.thinking)
          .join('\n\n');
        if (thinking) yield { partial: true, parts: [{ type: 'thinking', text: thinking }] };
        yield finalOf(message, model, built.structuredTool);
      }
    } catch (err) {
      yield failed(err, signal);
    }
  }

  /** The Messages API request for `request` on `endpoint`; marks the span with what it sends and drops. */
  async #build(request: ModelRequest, model: string, endpoint: ProviderEndpoint): Promise<BuiltRequest> {
    // ── The request surface this model takes (ADR 0049) ──────────────────────
    const gen = claudeGeneration(model);
    const reasoning = (request as ClaudeModelRequest).claudeReasoning ?? claudeReasoningOf(request.reasoning);
    // Adaptive generations: thinking, effort and drop_block from the table.
    // Budget generations keep the budget path below.
    const plan = gen.thinking === 'adaptive' ? adaptiveThinkingFor(gen, reasoning) : undefined;

    // ── Messages ─────────────────────────────────────────────────────────────
    const system: string[] = request.system ? [request.system] : [];
    const messages: AnthropicMessage[] = [];
    // Signed thinking is replayed only inside the current turn's tool loop,
    // which is where Anthropic requires it. Earlier turns' blocks are left
    // out: removing them from the front of the history is allowed, and their
    // stored prefix may differ from what the model saw (tool payloads are
    // elided before storage), which would invalidate them (ADR 0046). On a
    // model that binds blocks to the conversation they are replayed only
    // under drop_block, which a request with thinking off cannot carry.
    const turnStart = currentTurnStart(request.messages);
    const replaySigned = plan?.replaySigned ?? true;
    const urlImages = claudeUrlImagesOn(endpoint.platform);
    const droppedImages = new Set<string>();

    request.messages.forEach((message, index) => {
      if (message.role === 'system') {
        // No system role in the history: appended to the system prompt, in order.
        const text = message.parts.filter((p) => p.text).map((p) => p.text).join('\n');
        if (text) system.push(text);
        return;
      }
      const role = message.role === 'assistant' ? 'assistant' : 'user';
      const replay = replaySigned && role === 'assistant' && index > turnStart;
      const blocks: AnthropicContentBlock[] = [];
      for (const part of message.parts as Part[]) {
        // The signed blocks that preceded this part, verbatim. Another
        // provider's state, or another Claude model's (signed thinking is
        // bound to the model that produced it), is skipped.
        const state = replay ? providerStateOf(part, ANTHROPIC_PROVIDER, THINKING_STATE_KIND, model) : undefined;
        if (state && Array.isArray(state.payload)) blocks.push(...state.payload.filter(isSignedThinking));
        switch (part.type) {
          case 'thinking':
            break; // display only: never sent back as text
          case 'text':
            if (part.text) blocks.push({ type: 'text', text: part.text });
            break;
          case 'blob': {
            // A user-message image, in place. Images elsewhere stay out.
            if (message.role !== 'user') break;
            const image = imageBlockFor(part, urlImages);
            if (typeof image === 'string') droppedImages.add(image);
            else if (image) blocks.push(image);
            break;
          }
          case 'toolCall':
            blocks.push({ type: 'tool_use', id: part.id, name: part.name, input: part.args });
            break;
          case 'toolResult':
            blocks.push(toolResultBlock(part));
            break;
        }
      }
      if (blocks.length > 0) messages.push({ role, content: blocks });
    });
    if (droppedImages.size > 0) {
      setLlmSpanAttribute('llm.image.dropped', [...droppedImages].join(','));
      for (const what of droppedImages) {
        if (this.#imageDropWarned.has(what)) continue;
        this.#imageDropWarned.add(what);
        console.warn(
          what === URL_SOURCE
            ? `⚠ An image part given by URL is not sent to ${endpointLabel('anthropic', endpoint)}, which takes inline (base64) images only.`
            : `⚠ An image part (${what}) is not sent to Claude, which takes JPEG, PNG, GIF or WebP, inline or by https URL.`,
        );
      }
    }

    // ── Tools ────────────────────────────────────────────────────────────────
    const clientTools = (request.tools ?? []).map(toolDefinition);
    const serverTools: AnthropicTool[] = [];
    const dropped: NativeTool[] = [];
    for (const tool of new Set(request.nativeTools ?? [])) {
      if (tool !== 'web_search') {
        // No Anthropic tool for it; lib/models/capabilities.ts states this in advance.
        dropped.push(tool);
      } else if (nativeSearchOn('anthropic', endpoint.platform)) {
        serverTools.push(WEB_SEARCH_TOOL);
        setLlmSpanAttribute('llm.web_search.native', true);
      } else {
        // Not sent off Anthropic's own API (lib/models/endpoints.ts); the
        // doctor and the capability matrix state this before any request.
        dropped.push(tool);
        setLlmSpanAttribute('llm.web_search.omitted', true);
        if (!this.#searchDropWarned) {
          this.#searchDropWarned = true;
          console.warn(`⚠ web_search is not sent to Claude on ${endpoint.platform}; the agent answers without it (use web_extract).`);
        }
      }
    }
    if (dropped.length > 0) setLlmSpanAttribute('llm.capability.dropped', dropped.join(','));

    // ── Thinking ─────────────────────────────────────────────────────────────
    let maxTokens: number = request.sampling?.maxOutputTokens ?? 4096;
    let thinking: Record<string, unknown> | undefined;
    // The agent's setting thinks: a forced tool choice is weakened to auto
    // (also on a step that omits thinking, so the rule follows the setting).
    let thinkingConfigured: boolean;
    if (plan) {
      // Adaptive generations (ADR 0049). Thinking still counts toward
      // max_tokens, so the effort's budget sets the same floor as below.
      thinking = plan.thinking;
      thinkingConfigured = plan.thinkingOn;
      if (plan.minMaxTokens) maxTokens = Math.max(maxTokens, plan.minMaxTokens);
    } else {
      const requestedBudget = reasoning.budget;
      thinkingConfigured = typeof requestedBudget === 'number' && requestedBudget > 0;
      if (thinkingConfigured && continuesUnsignedToolLoop(messages)) {
        // The tool call this step answers carries no signed thinking (another
        // provider or model made it, or its state was lost), and Anthropic
        // rejects a thinking request whose tool loop does not start with one.
        // This step runs without thinking instead of failing.
        setLlmSpanAttribute('llm.thinking.omitted', 'unsigned_tool_loop');
      } else if (thinkingConfigured) {
        const budget = Math.max(requestedBudget as number, MIN_THINKING_BUDGET);
        thinking = { type: 'enabled', budget_tokens: budget };
        // Anthropic requires max_tokens to exceed the thinking budget.
        maxTokens = Math.max(maxTokens, budget + 2048);
      }
    }

    // ── Structured output ────────────────────────────────────────────────────
    // Left to prose, Claude returns JSON whose KEYS drift from the schema
    // ("grade" for "correctness"), which silently breaks any consumer that
    // reads fields by name. Current generations take the schema as
    // output_config.format and answer in text, with thinking on (ADR 0049).
    // The others, and a schema the structured-outputs transform refuses, get
    // a tool whose input_schema IS the output schema: forced with tool_choice
    // where the model accepts that, thinking is off and no other tool is
    // offered, offered under auto otherwise; finalOf() turns its tool_use
    // block back into text.
    const schema = request.outputSchema;
    const formatted = schema && gen.structuredOutput === 'output_format' ? await outputFormatFor(schema) : undefined;
    const format = formatted && !('refused' in formatted) ? formatted : undefined;
    if (formatted && 'refused' in formatted && !this.#schemaFallbackWarned) {
      this.#schemaFallbackWarned = true;
      // The SDK's message names what it refused; the schema is the agent's own, kept printable and short.
      const why = formatted.refused.replace(/[^\x20-\x7e]/g, '?').slice(0, 160);
      console.warn(`⚠ ${model}: the outputSchema cannot be sent as structured output (${why}); it is offered as a tool, which the model may not call.`);
    }
    const structuredTool: AnthropicTool | undefined =
      schema && !format
        ? {
            name: STRUCTURED_OUTPUT_TOOL,
            description: 'Return the final answer as a JSON object matching this schema. Call this exactly once.',
            input_schema: schema,
          }
        : undefined;
    const otherTools = [...clientTools, ...serverTools];
    const allTools = structuredTool ? [...otherTools, structuredTool] : otherTools;

    // ── Tool choice: a preference, weakened where forcing is refused ─────────
    const canForce = gen.forcedToolChoice && !thinkingConfigured;
    const asked = request.toolChoice;
    let toolChoice: Record<string, unknown> | undefined;
    if (allTools.length > 0) {
      if (asked === 'none') {
        toolChoice = { type: 'none' };
      } else if (asked === 'required' || (typeof asked === 'object' && asked !== null)) {
        if (canForce) toolChoice = asked === 'required' ? { type: 'any' } : { type: 'tool', name: asked.name };
        else setLlmSpanAttribute('llm.tool_choice.weakened', asked === 'required' ? 'required' : 'named');
      } else if (structuredTool && otherTools.length === 0 && canForce) {
        toolChoice = { type: 'tool', name: STRUCTURED_OUTPUT_TOOL };
      }
    }
    const forcedStructured = toolChoice?.type === 'tool' && toolChoice.name === STRUCTURED_OUTPUT_TOOL;
    if (schema) setLlmSpanAttribute('llm.structured_output', format ? 'output_format' : forcedStructured ? 'forced_tool' : 'tool_auto');
    const outputConfig = { ...(plan?.effort ? { effort: plan.effort } : {}), ...(format ? { format } : {}) };

    // No sampling parameter (temperature, top_p, top_k, stop_sequences) is
    // sent on any generation: the current models reject them (ADR 0049).
    const body: Record<string, unknown> = {
      model: platformModel(endpoint, model),
      max_tokens: maxTokens,
      system: system.join('\n\n') || undefined,
      messages,
      tools: allTools.length > 0 ? allTools : undefined,
      ...(toolChoice ? { tool_choice: toolChoice } : {}),
      ...(thinking ? { thinking } : {}),
      ...(Object.keys(outputConfig).length > 0 ? { output_config: outputConfig } : {}),
      ...(plan?.dropBlock ? { betas: [THINKING_BINDING_BETA] } : {}),
    };
    return { body, beta: plan?.dropBlock === true, structuredTool: structuredTool !== undefined };
  }
}

// ── The response ─────────────────────────────────────────────────────────────

/** The reasons for a drop_block drop this adapter reports (ADR 0049); others are ignored. */
const DROP_REASONS = new Set(['prefix_binding_mismatch', 'model_binding_mismatch']);

/** Anthropic's stop_reason as the contract's, when the final carries no tool call. */
const STOP_REASONS: Readonly<Record<string, FinishReason>> = {
  end_turn: 'stop',
  stop_sequence: 'stop',
  // A tool_use stop with no client tool call is the structured-output tool's answer.
  tool_use: 'stop',
  max_tokens: 'max_tokens',
  model_context_window_exceeded: 'max_tokens',
  refusal: 'content_filter',
  // The paused turn's content so far; the adapter does not continue it.
  pause_turn: 'other',
};

/**
 * A complete Messages API message → the final. Both the streamed and the
 * non-streamed path end here, so both carry the signed thinking blocks: each
 * run of them rides, verbatim, on the part that follows it (providerState,
 * ADR 0046), which keeps their order relative to the text and tool_use
 * blocks when they are replayed. Blocks with no part after them are not
 * needed for a replay and are dropped.
 */
function finalOf(message: any, model: string, structuredTool: boolean): FinalModelResponse {
  const parts: OutputPart[] = [];
  const citations: Citation[] = [];
  const searchQueries: SearchQuery[] = [];
  let signed: SignedThinkingBlock[] = [];
  let offset = 0;
  const emit = (part: OutputPart) => {
    parts.push(signed.length > 0 ? withProviderState(part, { provider: ANTHROPIC_PROVIDER, kind: THINKING_STATE_KIND, model, payload: signed }) : part);
    signed = [];
  };
  for (const block of message?.content ?? []) {
    if (isSignedThinking(block)) {
      signed.push(block);
    } else if (block?.type === 'text' && typeof block.text === 'string' && block.text) {
      // Web search citations cover the whole text block they arrive on.
      for (const c of Array.isArray(block.citations) ? block.citations : []) {
        if (c?.type !== 'web_search_result_location' || typeof c.url !== 'string' || !c.url) continue;
        citations.push({
          url: c.url,
          ...(typeof c.title === 'string' && c.title ? { title: c.title } : {}),
          ...(typeof c.cited_text === 'string' && c.cited_text ? { citedText: c.cited_text } : {}),
          start: offset,
          end: offset + block.text.length,
        });
      }
      emit({ type: 'text', text: block.text });
      offset += block.text.length;
    } else if (block?.type === 'tool_use' && structuredTool && block.name === STRUCTURED_OUTPUT_TOOL) {
      // The schema-validated answer, as the JSON text every consumer expects.
      const text = JSON.stringify(block.input ?? {});
      emit({ type: 'text', text });
      offset += text.length;
    } else if (block?.type === 'tool_use') {
      emit({ type: 'toolCall', id: String(block.id), name: String(block.name), args: isPlainObject(block.input) ? block.input : {} });
    } else if (block?.type === 'server_tool_use' && block.name === 'web_search' && typeof block.input?.query === 'string' && block.input.query) {
      searchQueries.push({ tool: 'web_search', query: block.input.query });
    }
  }

  // Signed blocks the API dropped under drop_block (ADR 0049): their
  // history changed since they were made (a resumed turn read back from
  // storage), or another model made them. Only the reasons named in
  // DROP_REASONS reach the span.
  const droppedBlocks = new Set<string>();
  for (const t of Array.isArray(message?.input_transformations) ? message.input_transformations : []) {
    if (t?.type === 'thinking_dropped' && DROP_REASONS.has(t.reason)) droppedBlocks.add(t.reason);
  }
  if (droppedBlocks.size > 0) setLlmSpanAttribute('llm.thinking.dropped', [...droppedBlocks].join(','));

  const stop = message?.stop_reason;
  const finishReason: FinishReason = parts.some((p) => p.type === 'toolCall')
    ? 'tool_call'
    : stop === undefined || stop === null
      ? 'stop'
      : (STOP_REASONS[String(stop)] ?? 'other');
  const usage = usageOf(message?.usage);
  return {
    partial: false,
    parts,
    finishReason,
    ...(usage ? { usage } : {}),
    ...(citations.length || searchQueries.length
      ? { grounding: { ...(citations.length ? { citations } : {}), ...(searchQueries.length ? { searchQueries } : {}) } }
      : {}),
  };
}

/** Anthropic's usage under the contract's meanings: both cache counts inside the input. Thinking is not reported apart. */
function usageOf(u: any): Usage | undefined {
  if (!u || typeof u !== 'object') return undefined;
  const count = (n: unknown) => (typeof n === 'number' && Number.isFinite(n) ? n : 0);
  const read = count(u.cache_read_input_tokens);
  const write = count(u.cache_creation_input_tokens);
  return {
    inputTokens: count(u.input_tokens) + read + write,
    outputTokens: count(u.output_tokens),
    ...(read > 0 ? { cacheReadTokens: read } : {}),
    ...(write > 0 ? { cacheWriteTokens: write } : {}),
  };
}

// ── Failures ─────────────────────────────────────────────────────────────────

/** A configuration or installation failure before any call: never retryable. */
function setupFailure(code: 'MISSING_API_KEY' | 'ENDPOINT_MISCONFIGURED' | 'SDK_NOT_INSTALLED', message: string): FinalModelResponse {
  return { partial: false, parts: [], finishReason: 'error', error: { code, message, retryable: false } };
}

/**
 * A failed call: ANTHROPIC_ERROR with the SDK's wording (key-shaped text
 * removed) and the retry policy's verdict, so a fallback model answers a
 * provider-side failure (ADR 0044). A canceled call is never retryable.
 */
function failed(err: unknown, signal: AbortSignal | undefined): FinalModelResponse {
  const decision = errorDecision(err);
  const error: ModelError = {
    code: 'ANTHROPIC_ERROR',
    message: errorText(err),
    retryable: decision.retryable && signal?.aborted !== true,
    ...(decision.status !== undefined ? { status: decision.status } : {}),
  };
  return { partial: false, parts: [], finishReason: 'error', error };
}

// ── Transport ────────────────────────────────────────────────────────────────

/** A promise that rejects, as an AbortError, once `signal` aborts; and its cleanup. */
function abortion(signal: AbortSignal): { promise: Promise<never>; dispose: () => void } {
  let onAbort = () => {};
  const promise = new Promise<never>((_, reject) => {
    onAbort = () => reject(Object.assign(new Error('The Anthropic request was aborted.'), { name: 'AbortError' }));
  });
  promise.catch(() => {});
  if (signal.aborted) onAbort();
  else signal.addEventListener('abort', onAbort, { once: true });
  return { promise, dispose: () => signal.removeEventListener('abort', onAbort) };
}

/** `promise`, or an AbortError as soon as `signal` aborts, whatever the SDK does. */
async function untilSettled<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return promise;
  const abort = abortion(signal);
  try {
    return await Promise.race([promise, abort.promise]);
  } finally {
    abort.dispose();
  }
}

/**
 * Iterates `source` until `signal` aborts, and then stops at once: the SDK
 * aborts its fetch on the same signal, but a stalled stream must not hold
 * the caller.
 */
async function* untilAborted<T>(source: AsyncIterable<T>, signal: AbortSignal | undefined): AsyncGenerator<T, void> {
  if (!signal) {
    yield* source;
    return;
  }
  const iterator = source[Symbol.asyncIterator]();
  const abort = abortion(signal);
  let done = false;
  try {
    for (;;) {
      const next = await Promise.race([iterator.next(), abort.promise]);
      if (next.done) {
        done = true;
        return;
      }
      yield next.value;
    }
  } finally {
    abort.dispose();
    if (!done) iterator.return?.(undefined)?.catch?.(() => {});
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
