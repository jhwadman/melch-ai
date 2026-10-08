/**
 * tests/helpers/scriptedModel.ts — a deterministic model adapter on the
 * engine's own contract (lib/models/contract.ts), for offline tests. The
 * loop charges and traces its calls the way it does every adapter's.
 * ScriptedLlm (./scriptedLlm.ts) wraps one for a script written in genai's
 * terms.
 *
 * A script is a function from (request, call number, signal) to the
 * responses of that call; it may be async and may await the request's
 * signal to model a hung provider. The model yields what the script says,
 * as it says it: a test of the contract's rules writes them in its script.
 */

import type {
  FinalModelResponse,
  ModelAdapter,
  ModelError,
  ModelRequest,
  ModelResponse,
  OutputPart,
  PartialModelResponse,
  ToolResultPart,
  Usage,
} from '../../lib/models/contract.ts';
import { servedThroughShim } from '../../lib/runtime/native/selfCorrection.ts';

export type ModelScript = (
  request: ModelRequest,
  call: number,
  signal?: AbortSignal,
) => ModelResponse | ModelResponse[] | Promise<ModelResponse | ModelResponse[]>;

export class ScriptedModel implements ModelAdapter {
  calls = 0;
  readonly requests: ModelRequest[] = [];
  readonly provider: string;
  readonly model: string;
  private readonly script: ModelScript;

  constructor(model: string, script: ModelScript, provider = 'scripted') {
    this.model = model;
    this.provider = provider;
    this.script = script;
  }

  async *generate(request: ModelRequest): AsyncGenerator<ModelResponse, void> {
    this.calls += 1;
    this.requests.push(request);
    const out = await this.script(request, this.calls, request.signal);
    for (const response of Array.isArray(out) ? out : [out]) yield response;
  }
}

/** A final answer carrying plain text. */
export function answer(text: string, usage?: Usage): FinalModelResponse {
  return { partial: false, parts: [{ type: 'text', text }], finishReason: 'stop', ...(usage ? { usage } : {}) };
}

let callSeq = 0;

/** A final that calls one tool. Without an id it gets `call-<name>-000001`, … in order: a recorded reference must not change per run (tests/helpers/adkReference.ts). */
export function toolCall(name: string, args: Record<string, unknown>, id = `call-${name}-${String(++callSeq).padStart(6, '0')}`): FinalModelResponse {
  return { partial: false, parts: [{ type: 'toolCall', id, name, args }], finishReason: 'tool_call' };
}

/** A streamed answer: text partials as the model writes them, then the final with the whole text. */
export function streamedAnswer(...chunks: string[]): ModelResponse[] {
  return [...chunks.map((text): PartialModelResponse => ({ partial: true, parts: [{ type: 'text', text }] })), answer(chunks.join(''))];
}

/** A failed call: a final with `error` set, holding whatever was produced before it failed. */
export function failure(error: Partial<ModelError> & Pick<ModelError, 'code'>, parts: OutputPart[] = []): FinalModelResponse {
  return { partial: false, parts, finishReason: 'error', error: { message: 'the call failed', retryable: false, ...error } };
}

/** Waits until the signal aborts, then ends the call as rule 4 says: a final, never retryable. */
export function untilAborted(signal: AbortSignal | undefined, code = 'SCRIPTED_ERROR'): Promise<FinalModelResponse> {
  return new Promise((resolve) => {
    const done = () => resolve(failure({ code, message: 'The operation was aborted.', retryable: false }));
    if (!signal) return; // never settles: the test's deadline must stop it
    if (signal.aborted) done();
    else signal.addEventListener('abort', done, { once: true });
  });
}

/** Text of every text part the model was sent, system prompt aside, for history asserts. */
export function requestTexts(request: ModelRequest): string[] {
  return request.messages.flatMap((m) => m.parts.flatMap((p) => (p.type === 'text' && p.text ? [p.text] : [])));
}

/** The last tool result in the request's history, if any. */
export function lastToolResult(request: ModelRequest): ToolResultPart | undefined {
  for (const message of [...request.messages].reverse()) {
    if (message.role !== 'tool') continue;
    const result = message.parts.at(-1);
    if (result) return result;
  }
  return undefined;
}

/**
 * A model resolver for compile options: each YAML model id `scripted/<key>`
 * gets the ScriptedModel registered under <key>, marked as a caller's
 * adapter (servedThroughShim, lib/runtime/native/selfCorrection.ts), as it
 * was when it reached the loop through the pre-1.0 shim: a Gemini-provider
 * model is told of the reflection tool, as the recorded references expect.
 */
export function shimResolver(models: Record<string, ScriptedModel>) {
  return (id: string | undefined): ScriptedModel => {
    const key = (id ?? '').replace(/^scripted\//, '');
    const m = models[key];
    if (!m) throw new Error(`no scripted model '${id}'`);
    return servedThroughShim(m);
  };
}
