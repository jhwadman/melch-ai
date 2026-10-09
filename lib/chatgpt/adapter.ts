/**
 * lib/chatgpt/adapter.ts — GPT on the person's ChatGPT plan, through Sign in
 * with ChatGPT, on their own machine only (ADR 0126).
 *
 * It is GptAdapter (the Responses API) with a different credential and the
 * request shape OpenAI documents for plan usage
 * (developers.openai.com/siwc/token-sharing-open-source/models-and-inference
 * and …/preview-limitations):
 *   - always `POST https://api.openai.com/v1/responses`, never a proxy or a
 *     platform, with the stored access token as the bearer, refreshed as it
 *     nears expiry (lib/chatgpt/oauth.ts freshAccessToken), and no
 *     organization or project header;
 *   - `stream: true` and `store: false` on every request; a call that did
 *     not ask to stream is streamed and folded back into one final;
 *   - none of the parameters the preview refuses: `max_output_tokens`,
 *     `temperature`, `top_p`;
 *   - no SDK retries: a plan-usage limit (429) is reported, not hammered.
 * The provider id stays `openai`, so reasoning replay and the stored events
 * are the same as on a key.
 *
 * On a served surface (lib/chatgpt/state.ts markServedSurface) every call
 * ends in a CHATGPT_SIGNIN_LOCAL_ONLY final before any token is read.
 */

import type { FinalModelResponse, ModelRequest, ModelResponse } from '../models/contract.ts';
import type { ProviderEndpoint } from '../models/endpoints.ts';
import { GptAdapter } from '../models/gptAdapter.ts';
import { OPENAI_API_RESOURCE, SignInError, freshAccessToken } from './oauth.ts';
import type { OAuthOptions } from './oauth.ts';
import { servedSurface, servedSurfaceMessage, signInFile } from './state.ts';

export interface ChatGptSignInAdapterOptions extends OAuthOptions {
  model: string;
  /** The credential file; default signInFile(). */
  file?: string;
}

function failure(code: string, message: string): FinalModelResponse {
  return { partial: false, parts: [], finishReason: 'error', error: { code, message, retryable: false } } as FinalModelResponse;
}

export class ChatGptSignInAdapter extends GptAdapter {
  protected override readonly label: string = 'OpenAI (Sign in with ChatGPT)';
  readonly #file: string;
  readonly #oauth: OAuthOptions;

  constructor(options: ChatGptSignInAdapterOptions) {
    super({ model: options.model, endpoint: { platform: 'direct' } });
    this.#file = options.file ?? signInFile();
    this.#oauth = options.issuer ? { issuer: options.issuer } : {};
  }

  protected override endpoint(): ProviderEndpoint {
    return { platform: 'direct' };
  }

  protected override baseURL(): string {
    return OPENAI_API_RESOURCE;
  }

  protected override missingKeyMessage(): string {
    return 'No ChatGPT sign-in is stored; run `melchizedek-setup --chatgpt-signin`.';
  }

  /** The token source: read (and refreshed) on every request, never held in the adapter. */
  protected override clientAuth(): { apiKey: () => Promise<string>; baseURL: string } {
    return { apiKey: () => freshAccessToken(this.#file, this.#oauth), baseURL: OPENAI_API_RESOURCE };
  }

  protected override clientOptions(): Record<string, unknown> {
    return {
      organization: null,
      project: null,
      maxRetries: 0,
      logLevel: 'warn',
      fetchOptions: { redirect: 'error' },
    };
  }

  /** The preview takes none of the sampling fields. */
  protected override acceptsSampling(): boolean {
    return false;
  }

  override requestBody(request: ModelRequest, model?: string, endpoint?: ProviderEndpoint): Record<string, unknown> {
    const body = super.requestBody(request, model, endpoint);
    delete body.max_output_tokens;
    delete body.temperature;
    delete body.top_p;
    body.store = false;
    return body;
  }

  override async *generate(request: ModelRequest): AsyncGenerator<ModelResponse, void> {
    const surface = servedSurface();
    if (surface) {
      yield failure('CHATGPT_SIGNIN_LOCAL_ONLY', servedSurfaceMessage(surface));
      return;
    }
    // Check the sign-in first, so a missing or expired one is a plain final, not an SDK error.
    try {
      await freshAccessToken(this.#file, this.#oauth);
    } catch (err) {
      const code = err instanceof SignInError ? err.code : 'signin_unreadable';
      yield failure(code === 'not_signed_in' ? 'MISSING_API_KEY' : 'CHATGPT_SIGNIN_ERROR', err instanceof Error ? err.message : String(err));
      return;
    }
    if (request.stream === true) {
      yield* super.generate(request);
      return;
    }
    // The plan-usage route streams only: stream, then give the caller what a
    // non-streamed call gives — at most one thinking partial, then the final.
    const thoughts: string[] = [];
    for await (const r of super.generate({ ...request, stream: true })) {
      if (r.partial) {
        for (const p of r.parts) if (p.type === 'thinking' && p.text) thoughts.push(p.text);
        continue;
      }
      if (thoughts.length > 0 && !r.error) yield { partial: true, parts: [{ type: 'thinking', text: thoughts.join('') }] };
      yield r;
    }
  }
}
