/**
 * lib/models/providerState.ts — provider-opaque reasoning state carried on a
 * model content part from one model step to the next (ADR 0046).
 *
 * WHY: some providers want back, on the next request of a tool loop, state
 * only they can read: Anthropic's signed `thinking` and `redacted_thinking`
 * blocks, OpenAI's and xAI's reasoning items, Moonshot's reasoning_content.
 * ADK's request is built from each event's `content` alone (event metadata
 * never reaches it), and @google/genai serializes a part field by field, so
 * the state rides as one extra field on a part the model actually produced:
 *
 *     { functionCall: {...}, providerState: { provider, kind, payload } }
 *
 * THE RULES:
 *   - The adapter that produced the response writes it, on the part the
 *     state belongs before (Claude: the part its signed blocks preceded).
 *   - Only an adapter of the same `provider` replays it, and only the `kind`
 *     it wrote (and, when `model` is set, only that model). Every other
 *     adapter ignores the field, so a model switch between steps drops the
 *     state rather than misreading it.
 *   - `payload` is opaque to everything but the writer, JSON-serializable,
 *     and replayed verbatim. The session services store it with the event;
 *     the transcript projection drops it with the rest of a past turn's
 *     machinery (lib/session/transcript.ts).
 */

/** The field name on a content part. */
export const PROVIDER_STATE_FIELD = 'providerState';

export interface ProviderState {
  /** The writer's provider id (lib/models/providerMap.ts), e.g. `anthropic`. */
  provider: string;
  /** What the payload is, in the writer's terms, e.g. `thinking_blocks`. */
  kind: string;
  /**
   * The model that wrote it, when the provider binds the state to a model
   * (Anthropic's signed thinking): a reader skips state another model wrote.
   */
  model?: string;
  /** Opaque to everyone but the writer; replayed verbatim. */
  payload: unknown;
}

/**
 * The state `provider` wrote on a part, or undefined when the part carries
 * none, another provider's, another kind, a malformed one, or (with `model`
 * given) one another model wrote.
 */
export function providerStateOf(part: unknown, provider: string, kind: string, model?: string): ProviderState | undefined {
  const state = (part as Record<string, unknown> | null | undefined)?.[PROVIDER_STATE_FIELD] as ProviderState | undefined;
  if (!state || typeof state !== 'object') return undefined;
  if (state.provider !== provider || state.kind !== kind) return undefined;
  return model !== undefined && state.model !== undefined && state.model !== model ? undefined : state;
}

/** A copy of `part` carrying `state`; the input is not mutated. */
export function withProviderState<T extends object>(part: T, state: ProviderState): T & { providerState: ProviderState } {
  return { ...part, [PROVIDER_STATE_FIELD]: state } as T & { providerState: ProviderState };
}

/**
 * Where the current turn starts in `contents`: the index of the last user
 * content that is not purely tool results, or -1 when there is none (every
 * content is then this turn's, the first included). The model contents
 * after it are this turn's tool loop, the only place an adapter replays its
 * state. Earlier turns' state is left out: dropping it from the front of
 * the history is allowed, and the stored history before it may differ from
 * what the model saw (tool payloads are elided before storage).
 */
export function currentTurnStart(contents: ReadonlyArray<{ role?: string; parts?: ReadonlyArray<unknown> }>): number {
  for (let i = contents.length - 1; i >= 0; i--) {
    const c = contents[i];
    if (c.role === 'user' && (c.parts ?? []).some((p) => !(p as { functionResponse?: unknown } | null)?.functionResponse)) return i;
  }
  return -1;
}
