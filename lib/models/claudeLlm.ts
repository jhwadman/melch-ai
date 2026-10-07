/**
 * lib/models/claudeLlm.ts — Anthropic Claude provider for the ADK LLMRegistry.
 *
 * WHY this file exists:
 *   The ADK JS package (@google/adk v1.x) is Gemini-native. It does not ship a
 *   Claude adapter the way the ADK Java SDK does. However, the ADK exposes a
 *   clean extension point: subclass BaseLlm, implement generateContentAsync(),
 *   and register the class via LLMRegistry.register(). The registry maps model
 *   name patterns to provider classes, so once registered, any LlmAgent with
 *   model: "claude-*" will automatically route through this class.
 *
 * HOW TO ENABLE:
 *   1. Install the Anthropic SDK:
 *        npm install @anthropic-ai/sdk
 *   2. Add your API key to .env:
 *        ANTHROPIC_API_KEY=sk-ant-...
 *   3. registerAvailableProviders() (lib/models/registry.ts) registers this
 *      adapter automatically when the key is set.
 *   4. Set model: "claude-sonnet-4-6" (or any claude-* id) in your YAML.
 *
 * CAPABILITIES:
 *   - Tools: FunctionTools AND MCP-discovered tools work. Tool schemas are
 *     normalized from the ADK/Gemini UPPERCASE dialect to the lowercase
 *     JSON-Schema types Anthropic requires (lib/models/schemaNormalize.ts).
 *   - web_search: declaring the `web_search` tool in YAML enables Anthropic's
 *     native web_search server tool — searches run on Anthropic's side.
 *   - Thinking, by model generation (lib/models/claudeModels.ts, ADR 0049):
 *     Claude 4.6 and earlier take generateContentConfig.thinkingConfig.
 *     thinkingBudget as a thinking budget; later models take adaptive
 *     thinking with output_config.effort from reasoningEffort, a `summarized`
 *     display, and each model's own off switch for `none`. Thinking text is
 *     surfaced as { text, thought: true } partials (display-only; never sent
 *     back). The raw signed `thinking` / `redacted_thinking` blocks ride on
 *     the part they preceded as providerState (lib/models/providerState.ts,
 *     ADR 0046) and are replayed verbatim before that part within the current
 *     turn's tool loop, which Anthropic requires for thinking with tool use;
 *     on a model that binds them to the conversation, under `drop_block`.
 *   - Structured output: output_config.format on current models, a forced
 *     (or offered) tool on the others (ADR 0049).
 *   - Vision: user-turn inlineData parts become base64 image blocks and https
 *     fileData parts URL image blocks (typed by their extension when they
 *     name no type; not sent on Bedrock or Vertex AI, which take base64
 *     only); a type Anthropic rejects is dropped with llm.image.dropped on
 *     the span and a one-time warning.
 *   - Token usage: response.usage is mapped to LlmResponse.usageMetadata, so
 *     traceAgentRun / llm.request spans count Claude tokens like Gemini's.
 *
 * LIMITATIONS vs Gemini:
 *   - generate_image tool uses the Gemini image model directly and is not
 *     affected by the inference model choice.
 *   - Live/bidirectional streaming (connect) is not supported.
 *
 * CONTENT FORMAT TRANSLATION:
 *   The ADK uses Google GenAI Content/Part objects internally. This adapter
 *   translates them to Anthropic MessageParam format and maps the response back
 *   to LlmResponse. Tool calls (function_call / function_response parts) are
 *   translated to Anthropic's tool_use / tool_result blocks.
 */

import { BaseLlm, LLMRegistry } from '@google/adk';
import type { LlmRequest, LlmResponse } from '@google/adk';
import type { BaseLlmConnection } from '@google/adk';

import {
  traceLlmGeneration,
  setLlmSpanAttribute,
} from '../observability/tracer.ts';
import {
  wantsWebSearch,
  isWebSearchSentinel,
} from '../tools/webSearchTool.ts';
import { providerRequestOptions } from '../runtime/turnControl.ts';
import { toLowercaseJsonSchema, toolDeclarationFor } from './schemaNormalize.ts';
import { claudeClientSpec, endpointFromEnv, endpointLabel, instantiateClient, nativeSearchOn, platformModel, SdkMissingError } from './endpoints.ts';
import type { ProviderEndpoint } from './endpoints.ts';
import { providerStateOf, withProviderState } from './providerState.ts';
import { adaptiveThinking, claudeGeneration, claudeUrlImagesOn, THINKING_BINDING_BETA } from './claudeModels.ts';

// ── Type aliases to avoid @anthropic-ai/sdk import errors when not installed ─
// We use dynamic import inside the methods so the rest of the framework still
// boots correctly even when the Anthropic SDK is absent.

type AnthropicMessage = {
  role: 'user' | 'assistant';
  content: string | AnthropicContentBlock[];
};

type AnthropicContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; tool_use_id: string; content: string }
  | AnthropicImageBlock
  | SignedThinkingBlock;

type AnthropicImageBlock = {
  type: 'image';
  source: { type: 'base64'; media_type: string; data: string } | { type: 'url'; url: string };
};

/** A `thinking` or `redacted_thinking` block exactly as the API returned it. */
type SignedThinkingBlock = { type: 'thinking' | 'redacted_thinking' } & Record<string, unknown>;

/** Name of the synthetic tool that carries an ADK outputSchema answer. */
const STRUCTURED_OUTPUT_TOOL = 'structured_output';

/** Anthropic's minimum extended-thinking budget. */
const MIN_THINKING_BUDGET = 1024;

/** The providerState kind this adapter writes: the signed blocks that preceded a part. */
export const THINKING_STATE_KIND = 'thinking_blocks';

const isSignedThinking = (b: any): b is SignedThinkingBlock =>
  !!b && typeof b === 'object' && (b.type === 'thinking' || b.type === 'redacted_thinking');

/** The image media types the Messages API accepts. */
const ANTHROPIC_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);

/** The type a file extension names, for a URL image part that names none. */
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
 * A user-turn image part → an Anthropic image block: inlineData as a base64
 * source (image/png when it names no type), an https fileData URI as a URL
 * source. A fileData part that names no type is typed by its URL's
 * extension; with no extension the table knows, it is sent and Anthropic
 * reads the type from the bytes. When the part would not be accepted,
 * returns what is wrong with it instead (the media type, the URL's scheme,
 * or URL_SOURCE where the platform takes base64 only; never the URL), for
 * the span and the warning.
 */
function imageBlockFor(p: any, urlImages: boolean): AnthropicImageBlock | string {
  // The caller's type string reaches a log line and the ledger: printable, short.
  const named = (type: string) => type.replace(/[^\x20-\x7e]/g, '?').slice(0, 64);
  if (p.inlineData?.data) {
    const mediaType = String(p.inlineData.mimeType ?? 'image/png').toLowerCase();
    if (!ANTHROPIC_IMAGE_TYPES.has(mediaType)) return named(mediaType);
    return { type: 'image', source: { type: 'base64', media_type: mediaType, data: p.inlineData.data } };
  }
  const uri = String(p.fileData.fileUri);
  const mediaType = p.fileData.mimeType ? String(p.fileData.mimeType).toLowerCase() : typeFromUrl(uri);
  if (mediaType && !ANTHROPIC_IMAGE_TYPES.has(mediaType)) return named(mediaType);
  if (!/^https:\/\//i.test(uri)) return `non-https URL (${/^[a-z][a-z0-9+.-]*:/i.exec(uri)?.[0] ?? 'no scheme'})`;
  if (!urlImages) return URL_SOURCE;
  return { type: 'image', source: { type: 'url', url: uri } };
}

/** The reasons for a drop_block drop this adapter reports (ADR 0049); others are ignored. */
const DROP_REASONS = new Set(['prefix_binding_mismatch', 'model_binding_mismatch']);

/**
 * An outputSchema as `output_config.format`, through the SDK's own strict-
 * schema transform (`additionalProperties: false` on every object; what
 * structured outputs cannot express moves into the description). When the
 * transform refuses the schema (a root that is not an object, a node with no
 * type), returns why instead.
 */
async function outputFormatFor(schema: Record<string, unknown>): Promise<{ type: 'json_schema'; schema: unknown } | { refused: string }> {
  try {
    const { jsonSchemaOutputFormat } = await import('@anthropic-ai/sdk/helpers/json-schema');
    return { type: 'json_schema', schema: jsonSchemaOutputFormat(schema as any).schema };
  } catch (err) {
    return { refused: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Where the current turn starts in `contents`: the last user content that is
 * not purely tool results. Everything after it is this turn's tool loop.
 */
function currentTurnStart(contents: LlmRequest['contents']): number {
  for (let i = contents.length - 1; i >= 0; i--) {
    const c = contents[i];
    if (c.role === 'user' && (c.parts ?? []).some((p: any) => !p.functionResponse)) return i;
  }
  return 0;
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
  if (typeof last.content === 'string' || !last.content.some((b) => b.type === 'tool_result')) return false;
  if (typeof prev.content === 'string' || !prev.content.some((b) => b.type === 'tool_use')) return false;
  return !isSignedThinking(prev.content[0]);
}

// ── Request building (exported for offline tests) ────────────────────────────

/** ADK toolsDict → Anthropic tool definitions (lowercase schemas; the
 *  web_search sentinel becomes Anthropic's native server tool). */
export function buildAnthropicTools(llmRequest: LlmRequest): any[] {
  const anthropicTools: any[] = [];
  for (const [, tool] of Object.entries(llmRequest.toolsDict ?? {})) {
    if (isWebSearchSentinel(tool)) continue; // added as a server tool below
    const decl = toolDeclarationFor(tool);
    if (decl) {
      anthropicTools.push({
        name: decl.name,
        description: decl.description,
        input_schema: decl.parameters,
      });
    }
  }
  if (wantsWebSearch(llmRequest)) {
    // Anthropic-native server tool: search runs on Anthropic's side, results
    // are grounded into the reply — no client-side execution.
    anthropicTools.push({
      type: 'web_search_20250305',
      name: 'web_search',
      max_uses: 5,
    });
  }
  return anthropicTools;
}

// ── ClaudeLlm ─────────────────────────────────────────────────────────────────

export class ClaudeLlm extends BaseLlm {
  /**
   * Regex patterns that map model name strings to this provider.
   * Any model: "claude-*" in a YAML config will route here after registration.
   */
  static readonly supportedModels: Array<string | RegExp> = [/^claude-.+/];

  private apiKey?: string;
  private endpoint?: ProviderEndpoint;
  private searchDropWarned = false;
  private imageDropWarned = new Set<string>();
  private schemaFallbackWarned = false;

  /**
   * `endpoint` (ADR 0023): where the request goes — Anthropic's API (or a
   * proxy at its base URL), Bedrock, or Vertex AI. Default: the environment's
   * (`ANTHROPIC_PLATFORM`).
   */
  constructor({ model, apiKey, endpoint }: { model: string; apiKey?: string; endpoint?: ProviderEndpoint }) {
    super({ model });
    this.apiKey = apiKey;
    this.endpoint = endpoint;
  }

  /**
   * Main generation method called by the ADK Runner for every turn.
   *
   * We translate ADK's LlmRequest (Google Content format) → Anthropic
   * MessageParam format, call the Anthropic Messages API, then translate
   * the response back to LlmResponse. The whole call is wrapped in an
   * llm.request OpenTelemetry span (provider/model/tokens/latency).
   */
  async *generateContentAsync(
    llmRequest: LlmRequest,
    stream = false,
  ): AsyncGenerator<LlmResponse, void> {
    yield* traceLlmGeneration(
      { provider: 'anthropic', model: this.model, llmRequest },
      this.generateInner(llmRequest, stream),
    );
  }

  private async *generateInner(
    llmRequest: LlmRequest,
    stream: boolean,
  ): AsyncGenerator<LlmResponse, void> {
    let endpoint: ProviderEndpoint;
    try {
      endpoint = this.endpoint ?? endpointFromEnv('anthropic');
    } catch (err) {
      yield { errorCode: 'ENDPOINT_MISCONFIGURED', errorMessage: (err as Error).message };
      return;
    }
    const spec = claudeClientSpec(endpoint, this.apiKey || endpoint.apiKey || process.env.ANTHROPIC_API_KEY);
    if ('error' in spec) {
      yield {
        errorCode: endpoint.platform === 'direct' ? 'MISSING_API_KEY' : 'ENDPOINT_MISCONFIGURED',
        errorMessage: spec.error,
      };
      return;
    }

    // Dynamic import — only loads the SDK (Anthropic's, or its Bedrock or
    // Vertex AI client) when actually called, so the framework boots without
    // it for users of other providers. All three share the Messages API.
    let client: any;
    try {
      client = await instantiateClient(spec);
    } catch (err) {
      yield {
        errorCode: err instanceof SdkMissingError ? 'SDK_NOT_INSTALLED' : 'ENDPOINT_MISCONFIGURED',
        errorMessage: (err as Error).message,
      };
      return;
    }

    // ── The request surface this model takes (ADR 0049) ──────────────────────
    const cfg = (llmRequest.config as any) ?? {};
    const gen = claudeGeneration(this.model);
    // Adaptive generations: thinking, effort and drop_block from the table.
    // Budget generations keep the thinkingBudget path below.
    const plan = gen.thinking === 'adaptive' ? adaptiveThinking(gen, cfg) : undefined;

    // ── Translate ADK Contents → Anthropic messages ──────────────────────────
    const systemParts: string[] = [];
    const messages: AnthropicMessage[] = [];
    // Signed thinking is replayed only inside the current turn's tool loop,
    // which is where Anthropic requires it. Earlier turns' blocks are left
    // out: removing them from the front of the history is allowed, and their
    // stored prefix may differ from what the model saw (tool payloads are
    // elided before storage), which would invalidate them (ADR 0046). On a
    // model that binds blocks to the conversation they are replayed only
    // under drop_block, which a request with thinking off cannot carry.
    const turnStart = currentTurnStart(llmRequest.contents);
    const replaySigned = plan?.replaySigned ?? true;
    const urlImages = claudeUrlImagesOn(endpoint.platform);
    const droppedImages = new Set<string>();

    for (const [index, content] of llmRequest.contents.entries()) {
      // System instruction lives in config.systemInstruction, not contents.
      // But ADK also injects it as a 'system' role content — extract it.
      if ((content as any).role === 'system') {
        const text = content.parts
          ?.filter((p: any) => p.text)
          .map((p: any) => p.text)
          .join('\n');
        if (text) systemParts.push(text);
        continue;
      }

      const role: 'user' | 'assistant' =
        content.role === 'model' ? 'assistant' : 'user';

      const blocks: AnthropicContentBlock[] = [];
      const replay = replaySigned && role === 'assistant' && index > turnStart;
      for (const part of content.parts ?? []) {
        const p = part as any;
        // The signed blocks that preceded this part, verbatim. Another
        // provider's state, or another Claude model's (signed thinking is
        // bound to the model that produced it), is skipped.
        const state = replay ? providerStateOf(p, 'anthropic', THINKING_STATE_KIND, this.model) : undefined;
        if (state && Array.isArray(state.payload)) {
          blocks.push(...state.payload.filter(isSignedThinking));
        }
        if (p.thought) {
          // Prior-turn scratchpad is display-only; never replay it as text.
          continue;
        }
        if (p.text) {
          blocks.push({ type: 'text', text: p.text });
        } else if (role === 'user' && (p.inlineData?.data || p.fileData?.fileUri)) {
          // A user-turn image, in place. Images inside tool results stay out.
          const image = imageBlockFor(p, urlImages);
          if (typeof image === 'string') droppedImages.add(image);
          else blocks.push(image);
        } else if (p.functionCall) {
          // ADK function_call → Anthropic tool_use
          blocks.push({
            type: 'tool_use',
            id: p.functionCall.id ?? `tool_${Date.now()}`,
            name: p.functionCall.name,
            input: p.functionCall.args ?? {},
          });
        } else if (p.functionResponse) {
          // ADK function_response → Anthropic tool_result
          blocks.push({
            type: 'tool_result',
            tool_use_id: p.functionResponse.id ?? '',
            content: JSON.stringify(p.functionResponse.response ?? {}),
          });
        }
      }

      if (blocks.length > 0) {
        messages.push({ role, content: blocks });
      }
    }
    if (droppedImages.size > 0) {
      setLlmSpanAttribute('llm.image.dropped', [...droppedImages].join(','));
      for (const what of droppedImages) {
        if (this.imageDropWarned.has(what)) continue;
        this.imageDropWarned.add(what);
        console.warn(
          what === URL_SOURCE
            ? `⚠ An image part given by URL is not sent to ${endpointLabel('anthropic', endpoint)}, which takes inline (base64) images only.`
            : `⚠ An image part (${what}) is not sent to Claude, which takes JPEG, PNG, GIF or WebP, inline or by https URL.`,
        );
      }
    }

    // Also pull system instruction from generateContentConfig if present
    const configSystem = (llmRequest.config as any)?.systemInstruction;
    if (configSystem) {
      const text =
        typeof configSystem === 'string'
          ? configSystem
          : configSystem.parts?.map((p: any) => p.text).join('\n') ?? '';
      if (text) systemParts.unshift(text);
    }

    // ── Build Anthropic tool definitions from ADK toolsDict ──────────────────
    let anthropicTools = buildAnthropicTools(llmRequest);
    if (wantsWebSearch(llmRequest)) {
      if (nativeSearchOn('anthropic', endpoint.platform)) {
        setLlmSpanAttribute('llm.web_search.native', true);
      } else {
        // Not sent off Anthropic's own API (lib/models/endpoints.ts); the
        // doctor and the capability matrix state this before any request.
        anthropicTools = anthropicTools.filter((t) => t.type !== 'web_search_20250305');
        setLlmSpanAttribute('llm.web_search.omitted', true);
        setLlmSpanAttribute('llm.capability.dropped', 'web_search');
        if (!this.searchDropWarned) {
          this.searchDropWarned = true;
          console.warn(`⚠ web_search is not sent to Claude on ${endpoint.platform}; the agent answers without it (use web_extract).`);
        }
      }
    }

    // ── Thinking ─────────────────────────────────────────────────────────────
    let maxTokens: number = cfg.maxOutputTokens ?? 4096;
    let thinking: Record<string, unknown> | undefined;
    // The agent's config thinks: the forced structured-output tool is offered
    // under 'auto' instead (also on a step that omits thinking, so the rule
    // follows the agent's config).
    let thinkingConfigured: boolean;
    if (plan) {
      // Adaptive generations (ADR 0049). Thinking still counts toward
      // max_tokens, so the effort's budget sets the same floor as below.
      thinking = plan.thinking;
      thinkingConfigured = plan.thinkingOn;
      if (plan.minMaxTokens) maxTokens = Math.max(maxTokens, plan.minMaxTokens);
    } else {
      // Budget generations: Gemini's thinkingConfig → a thinking budget.
      const requestedBudget = cfg.thinkingConfig?.thinkingBudget;
      thinkingConfigured = typeof requestedBudget === 'number' && requestedBudget > 0;
      if (thinkingConfigured && continuesUnsignedToolLoop(messages)) {
        // The tool call this step answers carries no signed thinking (another
        // provider or model made it, or its state was lost), and Anthropic
        // rejects a thinking request whose tool loop does not start with one.
        // This step runs without thinking instead of failing.
        setLlmSpanAttribute('llm.thinking.omitted', 'unsigned_tool_loop');
      } else if (thinkingConfigured) {
        const budget = Math.max(requestedBudget, MIN_THINKING_BUDGET);
        thinking = { type: 'enabled', budget_tokens: budget };
        // Anthropic requires max_tokens to exceed the thinking budget.
        maxTokens = Math.max(maxTokens, budget + 2048);
      }
    }

    // ── Structured output (ADK outputSchema) ─────────────────────────────────
    // Left to prose, Claude returns JSON whose KEYS drift from the schema
    // ("grade" for "correctness"), which silently breaks any consumer that
    // reads fields by name — the observatory's rubric judges first of all.
    // Current generations take the schema as output_config.format and answer
    // in text, with thinking on (ADR 0049). The others, and a schema the
    // structured-outputs transform refuses, get a tool whose input_schema IS
    // the output schema: forced with tool_choice where the model accepts that
    // and thinking is off, offered under 'auto' otherwise; finalResponse()
    // turns its tool_use block back into text. (ADK sets responseSchema only
    // on an agent without tools; one with tools gets ADK's own
    // set_model_response tool instead.)
    const schema = cfg.responseSchema ? toLowercaseJsonSchema(cfg.responseSchema) : undefined;
    const formatted = schema && gen.structuredOutput === 'output_format' ? await outputFormatFor(schema) : undefined;
    const format = formatted && !('refused' in formatted) ? formatted : undefined;
    if (formatted && 'refused' in formatted && !this.schemaFallbackWarned) {
      this.schemaFallbackWarned = true;
      // The SDK's message names what it refused; the schema is the agent's own, kept printable and short.
      const why = formatted.refused.replace(/[^\x20-\x7e]/g, '?').slice(0, 160);
      console.warn(`⚠ ${this.model}: the outputSchema cannot be sent as structured output (${why}); it is offered as a tool, which the model may not call.`);
    }
    const structuredTool =
      schema && !format
        ? {
            name: STRUCTURED_OUTPUT_TOOL,
            description: 'Return the final answer as a JSON object matching this schema. Call this exactly once.',
            input_schema: schema,
          }
        : undefined;
    const forceTool = !!structuredTool && gen.forcedToolChoice && !thinkingConfigured;
    if (schema) setLlmSpanAttribute('llm.structured_output', format ? 'output_format' : forceTool ? 'forced_tool' : 'tool_auto');
    const allTools = structuredTool ? [...anthropicTools, structuredTool] : anthropicTools;
    const outputConfig = { ...(plan?.effort ? { effort: plan.effort } : {}), ...(format ? { format } : {}) };

    // No sampling parameter (temperature, top_p, top_k) is sent on any
    // generation: the current models reject them.
    const requestBase = {
      model: platformModel(endpoint, this.model),
      max_tokens: maxTokens,
      system: systemParts.join('\n\n') || undefined,
      messages,
      tools: allTools.length > 0 ? allTools : undefined,
      ...(forceTool ? { tool_choice: { type: 'tool', name: STRUCTURED_OUTPUT_TOOL } } : {}),
      ...(thinking ? { thinking } : {}),
      ...(Object.keys(outputConfig).length > 0 ? { output_config: outputConfig } : {}),
    };
    // drop_block needs its beta, which the SDK's beta namespace sends the way
    // each platform takes it (a header; on Bedrock, the anthropic_beta field).
    const api = plan?.dropBlock ? client.beta.messages : client.messages;
    const body = plan?.dropBlock ? { ...requestBase, betas: [THINKING_BINDING_BETA] } : requestBase;

    // ── Call Anthropic API ────────────────────────────────────────────────────
    try {
      if (stream) {
        // Streaming path
        const streamResponse = await api.stream(body, providerRequestOptions());

        for await (const chunk of streamResponse) {
          if (chunk.type === 'content_block_delta') {
            if (chunk.delta.type === 'text_delta') {
              yield {
                content: {
                  role: 'model',
                  parts: [{ text: chunk.delta.text }],
                },
                partial: true,
              };
            } else if (chunk.delta.type === 'thinking_delta') {
              yield {
                content: {
                  role: 'model',
                  parts: [{ text: chunk.delta.thinking, thought: true } as any],
                },
                partial: true,
              };
            }
          }
        }

        // Final message: full text, tool_use blocks, thinking stash, usage.
        //
        // WHY includeText is true even though the text was just streamed:
        // ADK's runner persists only NON-partial events, so a final without
        // text would render the reply on screen and lose it from session
        // history — the next turn would have no record the model answered.
        // Printers drop text on a turnComplete event they already streamed.
        const final = await streamResponse.finalMessage();
        yield this.finalResponse(final, /*includeText=*/ true);
      } else {
        // Non-streaming path
        const response = await api.create(body, providerRequestOptions());

        // Thinking first, as a display-only partial.
        const thinkingText = (response.content ?? [])
          .filter((b: any) => b.type === 'thinking')
          .map((b: any) => b.thinking)
          .join('\n\n');
        if (thinkingText) {
          yield {
            content: {
              role: 'model',
              parts: [{ text: thinkingText, thought: true } as any],
            },
            partial: true,
          };
        }

        yield this.finalResponse(response, /*includeText=*/ true);
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      yield { errorCode: 'ANTHROPIC_ERROR', errorMessage: msg };
    }
  }

  /**
   * Maps a complete Anthropic message → the final LlmResponse. Both the
   * streamed and the non-streamed path end here, so both carry the signed
   * thinking blocks: each run of them rides, verbatim, on the part that
   * follows it (providerState, ADR 0046), which keeps their order relative
   * to the text and tool_use blocks when they are replayed. Blocks with no
   * part after them are not needed for a replay and are dropped.
   */
  private finalResponse(response: any, includeText: boolean): LlmResponse {
    const parts: any[] = [];
    let signed: SignedThinkingBlock[] = [];
    const emit = (part: Record<string, unknown>) => {
      parts.push(
        signed.length > 0
          ? withProviderState(part, { provider: 'anthropic', kind: THINKING_STATE_KIND, model: this.model, payload: signed })
          : part,
      );
      signed = [];
    };
    for (const block of response.content ?? []) {
      if (isSignedThinking(block)) {
        signed.push(block);
      } else if (block.type === 'text' && includeText && block.text) {
        emit({ text: block.text });
      } else if (block.type === 'tool_use' && block.name === STRUCTURED_OUTPUT_TOOL) {
        // The schema-validated answer, as the JSON text every consumer expects.
        emit({ text: JSON.stringify(block.input ?? {}) });
      } else if (block.type === 'tool_use') {
        emit({
          functionCall: { name: block.name, args: block.input, id: block.id },
        });
      }
    }

    // Signed blocks the API dropped under drop_block (ADR 0049): their
    // history changed since they were made (a resumed turn read back from
    // storage), or another model made them. Only the reasons named in
    // DROP_REASONS reach the span.
    const dropped = new Set<string>();
    for (const t of Array.isArray(response.input_transformations) ? response.input_transformations : []) {
      if (t?.type === 'thinking_dropped' && DROP_REASONS.has(t.reason)) dropped.add(t.reason);
    }
    if (dropped.size > 0) setLlmSpanAttribute('llm.thinking.dropped', [...dropped].join(','));

    const usage = response.usage;
    return {
      ...(parts.length > 0 ? { content: { role: 'model', parts } } : {}),
      turnComplete: true,
      ...(usage
        ? {
            usageMetadata: {
              ...(usage.input_tokens !== undefined
                ? { promptTokenCount: usage.input_tokens }
                : {}),
              ...(usage.output_tokens !== undefined
                ? { candidatesTokenCount: usage.output_tokens }
                : {}),
              ...(usage.input_tokens !== undefined &&
              usage.output_tokens !== undefined
                ? { totalTokenCount: usage.input_tokens + usage.output_tokens }
                : {}),
            },
          }
        : {}),
    };
  }

  /**
   * Live/bidirectional streaming connection — not supported by the Anthropic
   * Messages API. Throws to surface this clearly rather than silently failing.
   */
  async connect(_llmRequest: LlmRequest): Promise<BaseLlmConnection> {
    throw new Error(
      'ClaudeLlm does not support live bidirectional connections. ' +
        'Use a Gemini model for live/streaming sessions.',
    );
  }
}

// ── Registration helper ───────────────────────────────────────────────────────

/**
 * Registers ClaudeLlm with the ADK LLMRegistry.
 *
 * WHY a separate function instead of auto-registering at import time:
 *   Auto-registration at module load would cause every consumer of this file
 *   to unconditionally register Claude, even if ANTHROPIC_API_KEY is absent.
 *   By making registration explicit, registerAvailableProviders() can
 *   conditionally call this only when the key is present, and log a clear
 *   message about which provider is active.
 */
export function registerClaudeLlm(): void {
  LLMRegistry.register(ClaudeLlm);
}
