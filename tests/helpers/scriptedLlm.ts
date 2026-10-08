/**
 * tests/helpers/scriptedLlm.ts — a deterministic model for offline tests of
 * the turn runtime whose script is written in genai's terms: a function from
 * (LlmRequest, call number, signal) to the LlmResponses of that call
 * (lib/models/genaiMapping.ts). It may be async and may await the signal to
 * model a hung provider.
 *
 * ScriptedLlm is a ModelAdapter (lib/models/contract.ts) around a
 * ScriptedModel (./scriptedModel.ts): the loop hands it a ModelRequest, the
 * script reads the LlmRequest that request maps to
 * (modelRequestToLlmRequest), and each LlmResponse the script writes reaches
 * the loop as a ModelResponse (llmResponseToModelResponse). The loop charges
 * and traces the call as it does every adapter's (lib/runtime/turnControl.ts).
 *
 * It is marked as a caller's adapter (servedThroughShim,
 * lib/runtime/native/selfCorrection.ts), as it was when it reached the loop
 * through the pre-1.0 shim, so a Gemini-provider script is told of the
 * reflection tool as the recorded references expect.
 *
 * `adapter` is the ScriptedModel: its `requests` are the ModelRequests the
 * loop sent. `requests` here are the LlmRequests the script read.
 */

import type { ModelAdapter, ModelRequest, ModelResponse } from '../../lib/models/contract.ts';
import { llmResponseToModelResponse, modelRequestToLlmRequest } from '../../lib/models/genaiMapping.ts';
import type { LlmRequest, LlmResponse } from '../../lib/models/genaiMapping.ts';
import { servedThroughShim } from '../../lib/runtime/native/selfCorrection.ts';
import { ScriptedModel } from './scriptedModel.ts';

export type { LlmRequest, LlmResponse };

/** One response, or several in order (streaming chunks, then the full reply). */
export type Script = (request: LlmRequest, call: number, signal?: AbortSignal) => LlmResponse | LlmResponse[] | Promise<LlmResponse | LlmResponse[]>;

export class ScriptedLlm implements ModelAdapter {
  readonly adapter: ScriptedModel;
  /** The LlmRequests the script read, one per call that reached it. */
  readonly requests: LlmRequest[];
  readonly model: string;

  constructor(model: string, script: Script, provider = 'scripted') {
    const requests: LlmRequest[] = [];
    this.model = model;
    this.adapter = new ScriptedModel(
      model,
      async (request, call, signal) => {
        const llmRequest = modelRequestToLlmRequest(request);
        requests.push(llmRequest);
        const out = await script(llmRequest, call, signal);
        return (Array.isArray(out) ? out : [out]).map((response) => llmResponseToModelResponse(response, { model }));
      },
      provider,
    );
    this.requests = requests;
    servedThroughShim(this);
  }

  get provider(): string {
    return this.adapter.provider;
  }

  /** The calls that reached the script; a call the turn refused never does. */
  get calls(): number {
    return this.adapter.calls;
  }

  generate(request: ModelRequest): AsyncIterable<ModelResponse> {
    return this.adapter.generate(request);
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

let callSeq = 0;

/** A model reply that calls one tool, its id `call-<name>-000001`, … in order: a recorded reference must not change per run. */
export function call(name: string, args: Record<string, unknown>): LlmResponse {
  return {
    content: { role: 'model', parts: [{ functionCall: { name, args, id: `call-${name}-${String(++callSeq).padStart(6, '0')}` } }] },
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
