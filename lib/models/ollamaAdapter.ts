/**
 * lib/models/ollamaAdapter.ts — open-weight models served locally by Ollama,
 * behind the engine's own model contract (lib/models/contract.ts, ADR 0048).
 *
 * WHY this file exists:
 *   Every other provider in this framework bills per token and requires an
 *   API key. An open-weight model pulled through Ollama runs on the user's
 *   own machine: no key, no account, no data leaving the device. That makes
 *   it the teaching provider for the lyceumagents.com curriculum's Part 1 —
 *   and a legitimate production choice wherever privacy or cost demands
 *   local inference. The chat-completions translation is the shared base
 *   (lib/models/chatCompletionsAdapter.ts); this adapter supplies Ollama's
 *   endpoint, its wire model name and its error wording.
 *   Any agent with model: "ollama/<model>" resolves to it (resolveAdapter,
 *   lib/models/adapterResolver.ts).
 *
 * HOW TO ENABLE:
 *   1. Install Ollama (https://ollama.com — macOS: brew install ollama)
 *      and start it (the desktop app, or `ollama serve`).
 *   2. Pull a model that supports tool calling (see the table below):
 *        ollama pull qwen3.5:9b      # the default recommendation
 *        ollama pull qwen3.5:4b      # lighter; teaching and small machines
 *   3. Set model: "ollama/qwen3.5:9b" in your YAML. No API key needed —
 *      the provider is always available (logProviderStatuses() reports it).
 *   Optional: OLLAMA_BASE_URL in .env overrides the default endpoint
 *   (http://localhost:11434/v1 — Ollama's OpenAI-compatible API).
 *
 * CHOOSING A MODEL (current as of August 2026):
 *   The binding constraint is memory, not taste. A model must fit in RAM
 *   (unified memory on Apple Silicon) with room left for the KV cache and
 *   the OS — as a rule of thumb, the weights should occupy no more than
 *   ~70% of total memory. Every model below is Apache-2.0 and does native
 *   tool calling, which is the capability floor for agent work.
 *
 *     model                Q4 size   fits comfortably in   use it for
 *     ───────────────────────────────────────────────────────────────────
 *     qwen3.5:2b            2.7 GB   8 GB                  toy / CI runs
 *     qwen3.5:4b            3.4 GB   8–16 GB               teaching, demos
 *     qwen3.5:9b            6.6 GB   16 GB+                DEFAULT — real work
 *     qwen3.5:27b            17 GB   32 GB+                heavier local work
 *     qwen3.8:27b            18 GB   32 GB+                strongest local
 *
 *   Qwen3.8 (August 2026) is the strongest open-weight Qwen and the one to
 *   reach for on a 32 GB+ machine, but it ships in 27B ONLY — 18 GB of
 *   weights before any context — so it does not fit the 16/18 GB laptops
 *   this framework is usually developed on. Qwen3.5 (February 2026) is the
 *   newest generation that offers small dense sizes, which is why the
 *   default here is qwen3.5:9b rather than the bigger number. Qwen3.7 is
 *   API-only and has no weights to pull.
 *
 *   Vision: qwen3-vl:8b remains the pinned choice for image work; the
 *   qwen3.5 family is multimodal, so ollama/qwen3.5:9b also accepts images.
 *
 * DESIGN NOTES:
 *   - Zero dependencies: Ollama's OpenAI-compatible endpoint through the
 *     built-in fetch.
 *   - The "ollama/" prefix is a routing namespace and is stripped before the
 *     HTTP call (Ollama knows the model as "qwen3:8b").
 *   - Reasoning models (qwen3 family) emit <think>…</think> blocks or a
 *     `reasoning` field before their answer. The base surfaces them as a
 *     thinking partial — printers show the scratchpad dimmed; it stays out
 *     of history. No providerState is written.
 *   - Vision: inline image blobs go as image_url data URIs, so
 *     ollama/qwen3-vl:8b can see attached images.
 *   - Tool choice: auto and none (none by sending no tools); a forced
 *     choice is weakened to auto.
 *
 * LIMITATIONS vs Gemini:
 *   - web_search: a local model has no native search, so the tool is
 *     omitted with a warning. A local agent's grounding is what you supply:
 *     pasted material, subagents, or MCP tools.
 *   - Structured output: an output schema goes as `response_format:
 *     json_schema` (strict form, as on Kimi and the gateway), which Ollama
 *     0.5.0 and later enforce with grammar-constrained decoding; JSON mode
 *     without a schema stays `json_object`. A server older than 0.5.0
 *     silently ignores json_schema and returns free text, so 0.5.0 is the
 *     minimum for structured output (ADR 0096). `strict` is accepted and
 *     ignored; Ollama Cloud accepts the schema without enforcing it.
 *   - reasoning: travels as reasoning_effort (the level word), and on Ollama
 *     0.31 only "none" changes anything (it turns thinking off); "low" does
 *     not bound a qwen3.5 scratchpad, and `think: false` is ignored on this
 *     path.
 *   - Context window: 4,096 tokens unless the Modelfile (PARAMETER num_ctx)
 *     or OLLAMA_CONTEXT_LENGTH on the server says otherwise — /v1 ignores
 *     num_ctx. A thinking model that fills it, or stops after thinking, is
 *     retried once with thinking off (retriesWithoutThinking); only if that
 *     fails too does the call end with OLLAMA_MAX_TOKENS or
 *     OLLAMA_EMPTY_RESPONSE, never an empty reply (ADR 0027).
 */

import { ChatCompletionsAdapter } from './chatCompletionsAdapter.ts';
import type { ChatFailure } from './chatCompletionsAdapter.ts';

/** Ollama's OpenAI-compatible endpoint on a local install. */
export const DEFAULT_OLLAMA_BASE_URL = 'http://localhost:11434/v1';

export interface OllamaAdapterOptions {
  /** The model id as the YAML names it: "ollama/<model>". */
  model: string;
  /** Default: OLLAMA_BASE_URL, else http://localhost:11434/v1. */
  baseUrl?: string;
}

export class OllamaAdapter extends ChatCompletionsAdapter {
  readonly provider = 'ollama';
  readonly #baseUrl: string;

  constructor({ model, baseUrl }: OllamaAdapterOptions) {
    super({ model });
    this.#baseUrl = baseUrl || process.env.OLLAMA_BASE_URL || DEFAULT_OLLAMA_BASE_URL;
  }

  protected endpointUrl(): string {
    return `${this.#baseUrl}/chat/completions`;
  }

  protected headers(): Record<string, string> {
    return {}; // no auth — local
  }

  protected override wireModelName(model: string): string {
    return model.replace(/^ollama\//, '');
  }

  // webSearchBodyFields() stays at the base default (null): no native
  // search locally — the tool is omitted with a warning, keys stay optional.

  protected override httpError(status: number, detail: string, model: string): ChatFailure {
    return {
      code: 'OLLAMA_HTTP_ERROR',
      message: `Ollama returned ${status}: ${detail.slice(0, 4000)}. Is the model pulled? Try: ollama pull ${this.wireModelName(model)}`,
    };
  }

  protected override unreachable(message: string): ChatFailure {
    return {
      code: 'OLLAMA_UNREACHABLE',
      message: `Could not reach Ollama at ${this.#baseUrl} (${message}). Is it running? Start the Ollama app or run: ollama serve`,
    };
  }

  /**
   * Out of tokens on Ollama almost always means the CONTEXT WINDOW, not
   * max_tokens: Ollama loads a model with a 4,096-token window unless told
   * otherwise, the prompt and the scratchpad share it, and this /v1 path
   * ignores num_ctx (and `options` entirely). A qwen3.5 explainer prompt can
   * think for 3,700+ tokens and hit the ceiling before the answer starts.
   * The two levers that work are named in the message.
   */
  protected override noAnswerError(truncated: boolean, model: string): ChatFailure {
    if (!truncated) return super.noAnswerError(truncated, model);
    const name = this.wireModelName(model);
    return {
      code: 'OLLAMA_MAX_TOKENS',
      message:
        `${name} filled its context window while thinking and never wrote a reply ` +
        '(finish_reason "length"). Ollama defaults to a 4,096-token window and its ' +
        'OpenAI-compatible endpoint ignores num_ctx, so either set reasoning: none ' +
        'on the agent to skip thinking (generateContentConfig.reasoningEffort: "none" ' +
        `in the older spelling), or give the model a larger window: a Modelfile with "FROM ${name}" and ` +
        '"PARAMETER num_ctx 32768" (ollama create), or OLLAMA_CONTEXT_LENGTH=32768 ' +
        'on the ollama serve process.',
    };
  }

  /**
   * A local reasoning model that thinks its way to no answer is asked once
   * more with thinking off ("none" is the one reasoning_effort Ollama 0.31
   * honours), so the call answers instead of failing. Off with
   * OLLAMA_RETRY_WITHOUT_THINKING=false.
   */
  protected override retriesWithoutThinking(): boolean {
    return process.env.OLLAMA_RETRY_WITHOUT_THINKING?.trim().toLowerCase() !== 'false';
  }
}
