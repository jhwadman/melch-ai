/**
 * tests/helpers/scriptedLlm.ts — a deterministic model for offline tests of
 * the turn runtime. It goes through the same `traceLlmGeneration` wrapper
 * every real adapter uses, so the step budget and cancellation in
 * lib/runtime/turnControl.ts apply to it exactly as they do in production.
 *
 * A script is a function from (request, call number) to the response; it
 * may be async and may await the turn's abort signal to model a hung
 * provider.
 */

import { BaseLlm } from '@google/adk';
import type { BaseLlmConnection, LlmRequest, LlmResponse } from '@google/adk';
import { llmRequestToModelRequest } from '../../lib/models/genaiMapping.ts';
import { traceLlmGeneration } from '../../lib/observability/tracer.ts';

/** One response, or several in order (streaming chunks, then the full reply). */
export type Script = (request: LlmRequest, call: number, signal?: AbortSignal) => LlmResponse | LlmResponse[] | Promise<LlmResponse | LlmResponse[]>;

export class ScriptedLlm extends BaseLlm {
  calls = 0;
  readonly requests: LlmRequest[] = [];
  private readonly script: Script;

  constructor(model: string, script: Script) {
    super({ model });
    this.script = script;
  }

  async *generateContentAsync(
    llmRequest: LlmRequest,
    stream?: boolean,
    abortSignal?: AbortSignal,
  ): AsyncGenerator<LlmResponse, void> {
    yield* traceLlmGeneration(
      { provider: 'scripted', model: this.model, request: () => llmRequestToModelRequest(llmRequest, { model: llmRequest.model || this.model, stream }) },
      this.inner(llmRequest, abortSignal),
    );
  }

  private async *inner(llmRequest: LlmRequest, abortSignal?: AbortSignal): AsyncGenerator<LlmResponse, void> {
    this.calls += 1;
    this.requests.push(llmRequest);
    const out = await this.script(llmRequest, this.calls, abortSignal);
    for (const response of Array.isArray(out) ? out : [out]) yield response;
  }

  async connect(_req: LlmRequest): Promise<BaseLlmConnection> {
    throw new Error('ScriptedLlm does not support live connections');
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
