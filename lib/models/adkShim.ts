/**
 * lib/models/adkShim.ts — any ModelAdapter on the engine's own contract
 * (lib/models/contract.ts, ADR 0048) as an ADK BaseLlm, so an adapter can
 * move onto the contract while ADK still runs every turn (ADR 0045).
 *
 * WHY this file exists:
 *   ADK calls `BaseLlm.generateContentAsync(llmRequest, stream, abortSignal)`
 *   and expects LlmResponses back. An adapter on the contract implements
 *   `generate(ModelRequest)` and yields ModelResponses. The shim is the one
 *   class between them: it maps the LlmRequest in and each ModelResponse out
 *   through lib/models/genaiMapping.ts, and does no translation of its own.
 *   The adapter tickets move one adapter at a time behind it, and ADK sees
 *   no change.
 *
 * WHAT THE SHIM DOES ONCE, SO NO CONTRACT ADAPTER DOES IT (ADR 0053):
 *   - The turn's charge and the llm.request span. The call goes through
 *     `traceLlmGeneration` (lib/observability/tracer.ts) exactly as every
 *     ADK-path adapter's call does, with the adapter's `provider`, the
 *     shim's model id and the LlmRequest. So the step budget, a stopped
 *     turn's refusal (STEP_LIMIT, DEADLINE_EXCEEDED, CANCELED, as the same
 *     LlmResponse), the token charge and the span's attributes are what
 *     ClaudeLlm, GptLlm and the chat-completions adapters produce. A refused
 *     call never reaches the adapter. The adapter decorates the open span
 *     with `setLlmSpanAttribute`, and never opens one of its own.
 *   - The abort signal. The request's `signal` aborts when the turn stops
 *     (`currentTurnSignal()`) or when the signal ADK passes aborts, whichever
 *     comes first; an adapter hands it to its provider call.
 *
 * TWO SEAMS FOR A SUBCLASS: `toModelRequest` and `toLlmResponse` are the
 * genai mapping by default. A subclass overrides them to carry what its
 * adapter reads beside the contract, or to keep the response shape its
 * ADK-path class yielded before the move (the chat-completions shims in
 * lib/models/openAiCompatibleLlm.ts do both, ADR 0057). Both run inside the
 * span, so the tracer reads the response the subclass returns.
 *
 * WHAT IT DOES NOT DO:
 *   - Repair an adapter that breaks the contract. A throw reaches ADK as a
 *     throw (as Gemini's does today), and every response is mapped as it
 *     comes, so a missing final or a response after it passes through.
 *   - Live connections. `connect()` is refused, as on every adapter but
 *     ADK's Gemini: live sessions are outside the contract.
 *
 * ONE SHIM PER LEAF ADAPTER. A fallback pair on the ADK path is
 * `FallbackLlm(shim(primary), shim(fallback))` (ADR 0044), so each model call
 * is charged and traced on its own, as today. A FallbackAdapter behind one
 * shim would make a redirected call one span and one charge.
 */
import { BaseLlm } from '@google/adk';
import type { BaseLlmConnection, BaseLlmType, LlmRequest, LlmResponse } from '@google/adk';

import type { ModelAdapter, ModelRequest, ModelResponse } from './contract.ts';
import { llmRequestToModelRequest, modelResponseToLlmResponse } from './genaiMapping.ts';
import type { ModelRequestOptions } from './genaiMapping.ts';
import { traceLlmGeneration } from '../observability/tracer.ts';
import { currentTurnSignal } from '../runtime/turnControl.ts';

export interface AdkShimOptions {
  /**
   * The model id ADK and the span see, and the request's `model`. Default
   * the adapter's own `model`, which is what an adapter for one YAML id has.
   */
  model?: string;
}

/** Builds the adapter for a model id: what a registered shim class calls when ADK constructs it. */
export type ModelAdapterFactory = (model: string) => ModelAdapter;

/** One signal that aborts when any of the given ones does; undefined when none is given. */
function eitherSignal(...candidates: Array<AbortSignal | undefined>): AbortSignal | undefined {
  const signals = [...new Set(candidates.filter((s): s is AbortSignal => s !== undefined))];
  return signals.length <= 1 ? signals[0] : AbortSignal.any(signals);
}

export class AdkShim extends BaseLlm {
  /** The adapter every call runs through. */
  readonly adapter: ModelAdapter;

  constructor(adapter: ModelAdapter, options: AdkShimOptions = {}) {
    super({ model: options.model ?? adapter.model });
    this.adapter = adapter;
  }

  /**
   * One model call: charged against the turn and traced as one llm.request
   * span, then mapped to the contract and back. A call the turn refuses
   * yields the refusal and never reaches the adapter.
   */
  async *generateContentAsync(
    llmRequest: LlmRequest,
    stream = false,
    abortSignal?: AbortSignal,
  ): AsyncGenerator<LlmResponse, void> {
    yield* traceLlmGeneration(
      { provider: this.adapter.provider, model: this.model, llmRequest },
      this.generateInner(llmRequest, stream, abortSignal),
    );
  }

  /** Runs inside the span: the adapter's setLlmSpanAttribute calls land on it. */
  private async *generateInner(
    llmRequest: LlmRequest,
    stream: boolean,
    abortSignal: AbortSignal | undefined,
  ): AsyncGenerator<LlmResponse, void> {
    const signal = eitherSignal(abortSignal, currentTurnSignal(), llmRequest.config?.abortSignal);
    const request = this.toModelRequest(llmRequest, {
      model: this.model,
      stream,
      ...(signal ? { signal } : {}),
    });
    for await (const response of this.adapter.generate(request)) {
      yield this.toLlmResponse(response);
    }
  }

  /**
   * The ModelRequest the adapter receives for one LlmRequest: the genai
   * mapping's. A subclass may extend it with what its own adapter reads
   * beside the contract (an agent's older generateContentConfig spelling
   * that the contract leaves out), so an agent keeps it on the ADK runtime.
   */
  protected toModelRequest(llmRequest: LlmRequest, options: ModelRequestOptions): ModelRequest {
    return llmRequestToModelRequest(llmRequest, options);
  }

  /**
   * The LlmResponse ADK receives for one ModelResponse: the genai mapping's,
   * in Gemini's meanings. A subclass may keep the shape its ADK-path class
   * yielded before it moved onto the contract. It runs inside the span, so
   * the tracer reads what it returns.
   */
  protected toLlmResponse(response: ModelResponse): LlmResponse {
    return modelResponseToLlmResponse(response);
  }

  /** Live/bidirectional connections are outside the model contract. Throws to say so. */
  async connect(_llmRequest: LlmRequest): Promise<BaseLlmConnection> {
    throw new Error(
      `${this.model} runs through the ADK shim, which does not support live bidirectional connections ` +
        '(they are outside the model contract). Use a Gemini model for live/streaming sessions.',
    );
  }
}

/** A shim around `adapter`, under `model` (default the adapter's own id). */
export function adkShim(adapter: ModelAdapter, model: string = adapter.model): AdkShim {
  return new AdkShim(adapter, { model });
}

/**
 * A shim class ADK's LLMRegistry can register: it answers for
 * `supportedModels` and builds its adapter with `createAdapter(model)` when
 * ADK constructs it for a model id. Pass the direct adapter's own pattern
 * instances, since the registry keys on the pattern object (see
 * lib/models/gatewayLlm.ts), so the shim replaces that entry rather than
 * shadowing it.
 */
export function adkShimClass(
  supportedModels: Array<string | RegExp>,
  createAdapter: ModelAdapterFactory,
): BaseLlmType & (new (params: { model: string }) => AdkShim) {
  return class AdkShimFor extends AdkShim {
    static readonly supportedModels: Array<string | RegExp> = supportedModels;

    constructor({ model }: { model: string }) {
      super(createAdapter(model), { model });
    }
  };
}
