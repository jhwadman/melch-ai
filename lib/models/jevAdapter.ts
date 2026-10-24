/**
 * lib/models/jevAdapter.ts — TypeSafe Jev behind the engine's own model
 * contract (lib/models/contract.ts, ADR 0048).
 *
 * WHY this file exists:
 *   Jev (https://typesafe.ai) is a System One model: it returns typed
 *   decisions with calibrated probabilities, at $0.042 per million input
 *   tokens and nothing for output, in about a tenth of a second. It writes
 *   no prose, calls no tool and shows no reasoning, so it cannot be a chat
 *   adapter. It can be the model of a classifier agent: one whose
 *   `output.schema` is the questions, whose instruction and input are the
 *   state, and whose reply is the schema's object. That is what this
 *   adapter does, so `model: jev-latest` on such an agent is the whole
 *   change, and the same YAML runs on any chat model with structured
 *   output when calibration is not wanted. Any `jev-*` id resolves to it
 *   (resolveAdapter, lib/models/adapterResolver.ts).
 *
 * HOW TO ENABLE:
 *   1. Create a key at https://console.typesafe.ai/keys and put it in .env
 *      as TYPESAFE_API_KEY. Or none: with MODEL_GATEWAY set (Vercel AI
 *      Gateway or OpenRouter), `jev-*` ids are served on the gateway's
 *      System One route with the gateway's key (lib/models/gateway.ts).
 *   2. Give the agent an `output.schema` whose properties are decisions
 *      (lib/models/jev.ts questionsFromSchema: booleans, enums, levelled
 *      integers) and set model: "jev-latest" (jev-1.14.0, jev-1.13.0,
 *      jev-preview are the ids; TypeSafe lists them at GET /v1/models).
 *   Optional: TYPESAFE_BASE_URL for a proxy speaking the same wire.
 *
 * WHAT THE REQUEST IS:
 *   state      the system prompt (the agent's instruction), then every
 *              message's text in order: a user turn as written, an earlier
 *              answer as "Earlier answer: …", a tool result as JSON. Images
 *              are dropped (Jev's box questions need its image mode, which
 *              this adapter does not use).
 *   questions  from request.outputSchema; a request without one, or with a
 *              property Jev cannot decide, ends in an error final
 *              (TYPESAFE_SCHEMA_REQUIRED, TYPESAFE_SCHEMA_UNSUPPORTED)
 *              before any call.
 *   The final is one text part: the JSON object the schema describes, with
 *   the raw answers under `jev` (objectFromAnswers). Usage is the call's.
 *
 * WHAT IS NOT SENT — stated in the capability matrix:
 *   tools (client or native), reasoning, sampling, streaming (the final is
 *   the only response), images. A request that carries tools gets its
 *   decision anyway; the doctor names an agent with tools on a Jev id as a
 *   gap before it runs (lib/models/capabilities.ts).
 *
 * LIMITS: 64k tokens per request (state plus every question), 32k per
 *   question; TypeSafe's long-context header is not sent.
 */

import type { FinalModelResponse, Message, ModelAdapter, ModelRequest, ModelResponse } from './contract.ts';
import { errorText } from './errorResponse.ts';
import { gatewayConfig } from './gateway.ts';
import type { GatewayConfig } from './gateway.ts';
import { decide, JevError, jevEndpoint, objectFromAnswers, questionsFromSchema } from './jev.ts';
import type { JevEndpoint, JevQuestions, JevState } from './jev.ts';
import { setLlmSpanAttribute } from '../observability/tracer.ts';

export interface JevAdapterOptions {
  /** The model id as the YAML names it: jev-latest, jev-1.14.0, … */
  model: string;
  /** A caller's own TypeSafe key (BYOK); default TYPESAFE_API_KEY. */
  apiKey?: string;
  /** Default: TYPESAFE_BASE_URL, else TypeSafe's API. */
  baseUrl?: string;
  /**
   * Serve through this gateway's System One route with the gateway's key
   * (the transport rule: only when the direct key is absent). Default:
   * none, unless `transport` is 'gateway', when the configured gateway is read.
   */
  transport?: 'direct' | 'gateway';
}

export class JevAdapter implements ModelAdapter {
  readonly provider = 'typesafe';
  readonly model: string;
  readonly #endpoint: JevEndpoint;
  readonly #gateway: GatewayConfig | null;

  constructor({ model, apiKey, baseUrl, transport }: JevAdapterOptions) {
    this.model = model;
    this.#gateway = transport === 'gateway' ? gatewayConfig() : null;
    this.#endpoint = jevEndpoint(this.#gateway ? { gateway: this.#gateway } : { ...(apiKey ? { apiKey } : {}), ...(baseUrl ? { baseUrl } : {}) });
  }

  /** `direct`, or `gateway:<id>`, as the span's llm.transport. */
  transport(): string {
    return this.#endpoint.transport;
  }

  /** Where this adapter posts, for tests and the doctor; never the key. */
  get endpointUrl(): string {
    return this.#endpoint.url;
  }

  async *generate(request: ModelRequest): AsyncIterable<ModelResponse> {
    setLlmSpanAttribute('llm.transport', this.transport());
    const signal = request.signal;
    let questions: JevQuestions;
    try {
      questions = questionsFromSchema(request.outputSchema);
    } catch (err) {
      yield failure(err, signal);
      return;
    }
    if (request.tools?.length || request.nativeTools?.length) setLlmSpanAttribute('llm.capability.dropped', 'tools');
    const state = stateOf(request);
    try {
      const response = await decide({ model: this.model, state, questions }, { endpoint: this.#endpoint, ...(signal ? { signal } : {}), onRetry: (retries) => setLlmSpanAttribute('llm.retries', retries) });
      if (signal?.aborted) {
        yield failure(new JevError('TYPESAFE_UNREACHABLE', 'The call was cancelled.'), signal);
        return;
      }
      const object = objectFromAnswers(questions, response.answers);
      yield {
        partial: false,
        parts: [{ type: 'text', text: JSON.stringify(object) }],
        finishReason: 'stop',
        usage: { inputTokens: response.usage.input_tokens, outputTokens: response.usage.output_tokens },
      };
    } catch (err) {
      if (err instanceof JevError && err.status !== undefined) setLlmSpanAttribute('llm.http_status', err.status);
      yield failure(err, signal);
    }
  }
}

/** The text Jev decides about: the instruction, then the conversation's text in order. */
export function stateOf(request: ModelRequest): JevState {
  const texts: string[] = [];
  if (request.system?.trim()) texts.push(request.system.trim());
  for (const m of request.messages) texts.push(...messageTexts(m));
  return texts.length === 1 ? texts[0]! : texts;
}

function messageTexts(m: Message): string[] {
  switch (m.role) {
    case 'system':
      return m.parts.map((p) => p.text).filter(Boolean);
    case 'user':
      return m.parts.flatMap((p) => (p.type === 'text' && p.text ? [p.text] : []));
    case 'assistant':
      return m.parts.flatMap((p) => (p.type === 'text' && p.text ? [`Earlier answer: ${p.text}`] : []));
    case 'tool':
      return m.parts.map((p) => `Tool result (${p.name}): ${JSON.stringify(p.result)}`);
  }
}

/** An error final from a JevError (its code and verdict) or anything else (unreachable). A cancelled call is never retryable. */
function failure(err: unknown, signal: AbortSignal | undefined): FinalModelResponse {
  const aborted = !!signal?.aborted;
  const error =
    err instanceof JevError
      ? { code: err.code, message: errorText(err), retryable: err.retryable && !aborted, ...(err.status !== undefined ? { status: err.status } : {}) }
      : { code: 'TYPESAFE_UNREACHABLE' as const, message: errorText(err), retryable: !aborted };
  return { partial: false, parts: [], finishReason: 'error', error };
}
