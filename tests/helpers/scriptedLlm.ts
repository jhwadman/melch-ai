/**
 * tests/helpers/scriptedLlm.ts — a deterministic ADK model for offline tests
 * of the turn runtime: the ADK shim (lib/models/adkShim.ts) around a
 * ScriptedModel (./scriptedModel.ts), so the step budget, cancellation and
 * the llm.request span in lib/runtime/turnControl.ts apply to it exactly as
 * they do to every adapter in production.
 *
 * A script is written in ADK's terms, a function from (request, call
 * number, signal) to the LlmResponses of that call; it may be async and may
 * await the signal to model a hung provider. The shim hands the call to its
 * ScriptedModel as a ModelRequest; the model runs the script on the
 * LlmRequest that request was mapped from, and yields each LlmResponse as a
 * ModelResponse (llmResponseToModelResponse). ADK then receives the response
 * exactly as the script wrote it, not its round trip through the contract,
 * so a test that compares this model with a contract script behind the shim
 * (the boundary suite, tests/syndicateTurn.test.ts) still compares two
 * different paths.
 *
 * On the native runtime the loop calls the ScriptedModel itself, with no
 * LlmRequest behind its ModelRequest: the script then reads the LlmRequest
 * that request maps to (modelRequestToLlmRequest), and the loop reads the
 * script's responses through the contract, which is the native path.
 *
 * `model` is the ScriptedModel: its `requests` are the ModelRequests the
 * shim handed it. `requests` here are the LlmRequests ADK sent.
 */

import type { LlmRequest, LlmResponse } from '@google/adk';
import type { ModelRequest, ModelResponse } from '../../lib/models/contract.ts';
import { AdkShim } from '../../lib/models/adkShim.ts';
import { llmResponseToModelResponse, modelRequestToLlmRequest } from '../../lib/models/genaiMapping.ts';
import type { ModelRequestOptions } from '../../lib/models/genaiMapping.ts';
import { ScriptedModel } from './scriptedModel.ts';

/** One response, or several in order (streaming chunks, then the full reply). */
export type Script = (request: LlmRequest, call: number, signal?: AbortSignal) => LlmResponse | LlmResponse[] | Promise<LlmResponse | LlmResponse[]>;

export class ScriptedLlm extends AdkShim {
  declare readonly adapter: ScriptedModel;
  /** The LlmRequest each ModelRequest the shim built was mapped from. */
  readonly #sources: WeakMap<ModelRequest, LlmRequest>;
  /** The LlmResponse the script wrote for each ModelResponse the model yielded. */
  readonly #written: WeakMap<ModelResponse, LlmResponse>;
  /** The LlmRequests ADK sent, one per call that reached the script. */
  readonly requests: LlmRequest[];

  constructor(model: string, script: Script) {
    const sources = new WeakMap<ModelRequest, LlmRequest>();
    const written = new WeakMap<ModelResponse, LlmResponse>();
    const requests: LlmRequest[] = [];
    super(
      new ScriptedModel(model, async (request, call, signal) => {
        // Under ADK the shim mapped the request from an LlmRequest; on the
        // native runtime the loop hands the adapter its ModelRequest
        // directly, so the script reads the LlmRequest it maps to.
        const llmRequest = sources.get(request) ?? modelRequestToLlmRequest(request);
        requests.push(llmRequest);
        const out = await script(llmRequest, call, signal);
        return (Array.isArray(out) ? out : [out]).map((response) => {
          const mapped = llmResponseToModelResponse(response, { model });
          written.set(mapped, response);
          return mapped;
        });
      }),
    );
    this.#sources = sources;
    this.#written = written;
    this.requests = requests;
  }

  /** The calls that reached the script; a call the turn refused never does. */
  get calls(): number {
    return this.adapter.calls;
  }

  protected override toModelRequest(llmRequest: LlmRequest, options: ModelRequestOptions): ModelRequest {
    const request = super.toModelRequest(llmRequest, options);
    this.#sources.set(request, llmRequest);
    return request;
  }

  protected override toLlmResponse(response: ModelResponse): LlmResponse {
    return this.#written.get(response) ?? super.toLlmResponse(response);
  }
}

/** A model reply carrying plain text. */
export function text(t: string): LlmResponse {
  return { content: { role: 'model', parts: [{ text: t }] }, turnComplete: true } as LlmResponse;
}

/** A streamed reply: partial chunks as the model writes them, then the whole text. */
export function streamed(...chunks: string[]): LlmResponse[] {
  return [
    ...chunks.map((c) => ({ content: { role: 'model', parts: [{ text: c }] }, partial: true }) as LlmResponse),
    text(chunks.join('')),
  ];
}

/** A model reply that calls one tool. */
export function call(name: string, args: Record<string, unknown>): LlmResponse {
  return {
    content: { role: 'model', parts: [{ functionCall: { name, args, id: `call-${name}-${Math.random().toString(36).slice(2, 8)}` } }] },
  } as LlmResponse;
}

/** Waits until the signal aborts, then rejects like an aborted fetch. */
export function hangUntilAborted(signal?: AbortSignal): Promise<never> {
  return new Promise((_resolve, reject) => {
    const fail = () => reject(Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' }));
    if (!signal) return; // never settles: the test's deadline must stop it
    if (signal.aborted) fail();
    else signal.addEventListener('abort', fail, { once: true });
  });
}

/** Text of every user/model content the model was sent, for history asserts. */
export function sentTexts(request: LlmRequest): string[] {
  return (request.contents ?? []).flatMap((c) => (c.parts ?? []).map((p: any) => p.text).filter(Boolean));
}

/**
 * A model resolver for compile options: each YAML model id `scripted/<key>`
 * gets the ScriptedLlm registered under <key>.
 */
export function scriptedResolver(models: Record<string, ScriptedLlm>) {
  return (id: string | undefined) => {
    const key = (id ?? '').replace(/^scripted\//, '');
    const m = models[key];
    if (!m) throw new Error(`no scripted model '${id}'`);
    return m;
  };
}
