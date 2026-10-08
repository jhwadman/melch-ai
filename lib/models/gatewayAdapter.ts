/**
 * lib/models/gatewayAdapter.ts — the one-key fallback transport behind the
 * engine's own model contract (lib/models/contract.ts, ADR 0048).
 *
 * WHY this file exists:
 *   Serves any cloud model id through a hosted gateway's OpenAI-compatible
 *   chat-completions endpoint when the provider's direct key is absent
 *   (lib/models/gateway.ts owns that decision). It extends the
 *   chat-completions base (lib/models/chatCompletionsAdapter.ts) the way
 *   Ollama does, because chat completions is the one dialect every gateway
 *   serves.
 *
 * WHAT STAYS TRUE THROUGH THE GATEWAY:
 *   - Attribution. `provider` is the YAML id's provider (anthropic, openai,
 *     gemini, xai, moonshot), never "gateway", so the ledger and any
 *     per-agent cost view keep the same provider column (ADR 0009). The
 *     transport is a separate span attribute: llm.transport = gateway:<id>.
 *   - Tool calling, structured output, reasoning (as `reasoning_effort`, the
 *     one field every gateway reads, in the upstream's word: ADR 0047),
 *     streaming and token accounting, all from the base. Tool choice goes
 *     as asked; whether the upstream honours a forced one varies.
 *
 * WHAT IS LOST — and reported:
 *   Every native tool (web_search, google_search, x_search,
 *   collections_search, ...). The base drops them, marks the span and warns
 *   once; lib/models/capabilities.ts names the loss per agent for the doctor
 *   and the A2A startup log. Because `provider` is the upstream's, this
 *   adapter replays no providerState: a chat-completions wire has no place
 *   for Claude's signed blocks or OpenAI's reasoning items.
 */

import type { ToolChoiceMode } from './contract.ts';
import { ChatCompletionsAdapter } from './chatCompletionsAdapter.ts';
import type { ChatFailure } from './chatCompletionsAdapter.ts';
import { GATEWAY_ENV, GATEWAY_KEY_ENV, GATEWAY_MODEL_MAP_ENV, gatewayConfig, gatewayWireModel } from './gateway.ts';
import type { GatewayConfig } from './gateway.ts';
import { providerForModel } from './providerMap.ts';

export interface GatewayAdapterOptions {
  /** The model id as the YAML names it; the gateway's id comes from gatewayWireModel. */
  model: string;
}

export class GatewayAdapter extends ChatCompletionsAdapter {
  /** Attribution stays with the upstream provider named by the YAML id. */
  readonly provider: string;
  readonly #cfg: GatewayConfig | null;

  constructor({ model }: GatewayAdapterOptions) {
    super({ model });
    this.provider = providerForModel(model);
    this.#cfg = gatewayConfig();
  }

  override transport(): string {
    return this.#cfg ? `gateway:${this.#cfg.gateway.id}` : 'gateway';
  }

  protected endpointUrl(): string {
    return `${this.#cfg?.baseUrl ?? ''}/chat/completions`;
  }

  protected headers(): Record<string, string> {
    return { Authorization: `Bearer ${process.env[GATEWAY_KEY_ENV] ?? ''}` };
  }

  protected override wireModelName(model: string): string {
    return this.#cfg ? gatewayWireModel(model, this.#cfg.gateway) : model;
  }

  /** A gateway passes tool_choice to the upstream as asked. */
  protected override toolChoiceModes(): readonly ToolChoiceMode[] {
    return ['auto', 'none', 'required', 'named'];
  }

  protected override missingRequirement(): ChatFailure | undefined {
    if (!this.#cfg) {
      return { code: 'GATEWAY_NOT_CONFIGURED', message: `${GATEWAY_ENV} is not set to a known gateway, so ${this.model} has no route.` };
    }
    if (!this.#cfg.keyPresent) {
      return { code: 'GATEWAY_KEY_MISSING', message: `${GATEWAY_ENV}=${this.#cfg.gateway.id} but ${GATEWAY_KEY_ENV} is not set.` };
    }
    return undefined;
  }

  // webSearchBodyFields() stays at the base default (null): a gateway has no
  // uniform switch for upstream native search, so the tool is dropped and
  // the loss is reported (llm.capability.dropped, the doctor, the startup log).

  protected override httpError(status: number, detail: string, model: string): ChatFailure {
    const label = this.#cfg?.gateway.label ?? 'gateway';
    const hint =
      status === 404 || status === 400
        ? ` If the model id is the problem, map it with ${GATEWAY_MODEL_MAP_ENV}=${model}=<gateway id>.`
        : '';
    return {
      code: 'GATEWAY_HTTP_ERROR',
      message: `${label} returned ${status} for ${this.wireModelName(model)}: ${detail.slice(0, 4000)}.${hint}`,
    };
  }
}
