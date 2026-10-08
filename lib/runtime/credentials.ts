/**
 * lib/runtime/credentials.ts — reading and answering a tool's OAuth consent
 * request in a session (WS6-3b, ADR 0085).
 *
 * A tool that needs a grant the person has not given asks for it
 * (`ctx.requestCredential(provider)`). The run stores ADK's own
 * `adk_request_credential` call, as ADK's generateAuthEvent writes it: args
 * `{ function_call_id, auth_config }`, an `adk-` id listed in
 * longRunningToolIds. The auth_config carries the authorization URL and the
 * state nonce, never a client secret or a code verifier
 * (lib/tools/oauthConsent.ts). The turn ends input-required with the
 * request (`result.consent`).
 *
 * The person completes the flow in their browser; the server's callback
 * stores the grant. Their next message, once the grant is stored, becomes a
 * function response to the request (`credentialResponsePart`), and the
 * agent's loop runs the paused call again before its next step
 * (lib/runtime/native/interrupts.ts grantedCalls). Until the grant is
 * stored, a message repeats the request and runs nothing.
 */
import type { Event } from '@google/adk';

/** ADK's name for the credential request (REQUEST_CREDENTIAL_FUNCTION_CALL_NAME). */
export const CREDENTIAL_REQUEST = 'adk_request_credential';

/** A paused call waiting for the person to grant a provider. */
export interface PendingConsent {
  /** The `adk_request_credential` call's id: what the answer names. */
  id: string;
  /** The agent whose call is paused. */
  agent: string;
  /** The paused call's id. */
  functionCallId: string;
  /** The provider, as the credential store names it (the AuthConfig's credentialKey). */
  provider: string;
  /** The authorization URL the person opens. */
  authUri: string;
  /** The state nonce the URL carries. */
  state: string;
  scopes: string[];
}

const partsOf = (e: Event) => (e.content?.parts ?? []) as Array<Record<string, any>>;
const hasUserText = (e: Event) => e.author === 'user' && partsOf(e).some((p) => typeof p.text === 'string' && p.text.trim() && !p.thought);
const isRecord = (v: unknown): v is Record<string, any> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** The request an `adk_request_credential` call carries, or undefined when it is not one this engine reads. */
export function consentFrom(author: string | undefined, call: { name?: string; id?: string; args?: Record<string, unknown> }): PendingConsent | undefined {
  if (call.name !== CREDENTIAL_REQUEST || !call.id || !isRecord(call.args)) return undefined;
  const functionCallId = call.args.function_call_id ?? call.args.functionCallId;
  const config = call.args.auth_config ?? call.args.authConfig;
  if (typeof functionCallId !== 'string' || !isRecord(config)) return undefined;
  const oauth2 = isRecord(config.exchangedAuthCredential) && isRecord(config.exchangedAuthCredential.oauth2) ? config.exchangedAuthCredential.oauth2 : {};
  const flows = isRecord(config.authScheme) && isRecord(config.authScheme.flows) ? config.authScheme.flows : {};
  const scopes = isRecord(flows.authorizationCode) && isRecord(flows.authorizationCode.scopes) ? Object.keys(flows.authorizationCode.scopes) : [];
  return {
    id: call.id,
    agent: author ?? '',
    functionCallId,
    provider: typeof config.credentialKey === 'string' ? config.credentialKey : '',
    authUri: typeof oauth2.authUri === 'string' ? oauth2.authUri : '',
    state: typeof oauth2.state === 'string' ? oauth2.state : '',
    scopes,
  };
}

/**
 * The consent request still waiting in a session, or undefined. One that is
 * answered (a function response with its id), or that the person moved past
 * with a text message, is not pending. Only an agent asks: a request in an
 * event the user authored is none, so a forged request never makes the next
 * message a grant (as pendingQuestion reads ask_user).
 */
export function pendingConsent(events: readonly Event[]): PendingConsent | undefined {
  const answered = new Set<string>();
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    if (hasUserText(e)) return undefined;
    for (const p of partsOf(e)) {
      if (p.functionResponse?.name === CREDENTIAL_REQUEST && p.functionResponse.id) answered.add(p.functionResponse.id);
    }
    // Only an agent asks: a credential request in an event the user authored is none, as pendingQuestion reads ask_user (WS5-5).
    if (e.author === 'user') continue;
    for (const p of partsOf(e)) {
      const call = p.functionCall;
      if (call?.name !== CREDENTIAL_REQUEST || !call.id || answered.has(call.id)) continue;
      return consentFrom(e.author, call);
    }
  }
  return undefined;
}

/**
 * The message part that answers request `id` once the grant is stored. It
 * names the provider and carries no credential: the grant is in the
 * credential store, and the resumed call reads it from there.
 */
export function credentialResponsePart(id: string, provider: string): Record<string, unknown> {
  return { functionResponse: { id, name: CREDENTIAL_REQUEST, response: { credentialKey: provider, granted: true } } };
}

/** One line a person can read: what they are asked to connect. */
export function describeConsent(c: PendingConsent): string {
  return `${c.agent} needs access to your ${c.provider} account`;
}
