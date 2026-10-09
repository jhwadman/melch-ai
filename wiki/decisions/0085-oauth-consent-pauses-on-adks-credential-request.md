---
type: decision
title: "ADR 0085: OAuth consent pauses on ADK's own credential request, and a server callback completes the flow"
description: "A tool call whose provider the user has not granted pauses the turn on ADK's own adk_request_credential call, stored as ADK's generateAuthEvent writes it, with an AuthConfig that carries the authorization URL and the state nonce but no client secret and no PKCE verifier. A callback route on the A2A server completes the authorization-code flow with PKCE S256 server-side: the state is single-use, expiring and bound to the user, session, provider and paused call; the redirect URI is configuration only; the tokens go to the sealed credential store and nowhere else. The person's next message, once the grant is stored, becomes a credential-free answer, and the native loop runs the paused call again before its next step, a port of ADK's auth preprocessor. The ADK runtime refuses to resume one. A new interrupt name, ADK's exchange in the message with secrets in the event, the client carrying the code back, a consent tool the model calls, and a durable pending-flow table now were rejected."
tags:
  - decision
  - tools
  - security
  - protocols
status: stable
generated:
  by: claude-code/claude-opus-5-5
  at: 2026-10-08
sources:
  - resource: lib/tools/oauthConsent.ts
  - resource: lib/runtime/credentials.ts
  - resource: lib/runtime/native/interrupts.ts
  - resource: lib/runtime/native/agentLoop.ts
  - resource: lib/runtime/syndicateTurn.ts
  - resource: lib/a2a/app.ts
  - resource: lib/a2a/executor.ts
  - resource: lib/tools/tool.ts
  - resource: tests/oauthConsent.test.ts
---

# ADR 0085: OAuth consent pauses on ADK's own credential request, and a server callback completes the flow

## Context

[ADR 0072](/decisions/0072-tool-credentials-sealed-per-user.md) gave the engine a sealed store for each user's third-party tokens and `ctx.accessToken(provider)` to read one. Nothing put a token there. A tool whose provider the user had not connected could only fail with `not_connected`.

Getting a grant is OAuth's authorization-code flow. The person consents in their browser, the provider redirects the browser back with a code, and the code is exchanged for tokens. The turn must wait for this, and the call that needed the grant must then run, once. Three constraints shape it:

- **The stored shape.** A session either runtime wrote must be one the other continues, and the interrupt names and the A2A surface change only additively ([ADR 0045](/decisions/0045-own-runtime-behind-the-seam.md) item 4).
- **The secrets.** A token, the client secret and the PKCE verifier must never reach an event, a log line, the browser or the model.
- **The new surface.** The callback is reached by a browser, which carries no A2A credential. It is the first route the server mounts outside authentication that writes data.

ADK 2.2 already has a credential interrupt. A tool calls `context.requestCredential(authConfig)`. ADK's `generateAuthEvent` stores an `adk_request_credential` call, args `{ function_call_id, auth_config }`, listed in `longRunningToolIds`, before the tool's response, and the run ends. The `auth_config` ADK's `AuthHandler.generateAuthRequest` builds holds the client id **and the client secret**, the authorization URL, the state and **the code verifier**. The client answers with a function response carrying `exchangedAuthCredential.oauth2.authCode` or `authResponseUri`. Before the next step, ADK's `AuthPreprocessor` binds the answer to the request, exchanges the code in-process using the secret and verifier from the stored event, writes the credential into `temp:` session state (gone after the run), and re-runs the original call. The native loop already ported `generateAuthEvent`, but no own tool could raise a request.

## Decision

1. **The pause is ADK's own stored shape.** A call asks with `ctx.requestCredential(provider)`. On the native runtime, in a run given a consent step, `ctx.accessToken(provider)` also asks by itself when the store has no usable grant (`not_connected`, `expired`, `refresh_failed`) and the provider has a client configured. Either way:
   - The call's actions get `requestedAuthConfigs[callId]`, as ADK's `Context.requestCredential` sets them.
   - The loop stores ADK's `adk_request_credential` event before the response, unchanged.
   - The run ends `paused` on the request's id.
   - The call answers `CONSENT_TEXTS.pending(provider)`, and self-correction does not count it as a failure.

   No new interrupt name. `adk_request_confirmation` and `ask_user` are untouched.
2. **The AuthConfig keeps ADK's fields and drops its secrets.** It holds:
   - `credentialKey`, the provider name as the credential store names it;
   - `authScheme`, an oauth2 `authorizationCode` flow with its URLs and scopes;
   - `exchangedAuthCredential.oauth2`, with `clientId`, `redirectUri`, `authUri` and `state`.

   It holds no `clientSecret` and no `codeVerifier`. Those stay in the consent step (`lib/tools/oauthConsent.ts`), held in process memory under the state's SHA-256 (`ConsentStates`). The state and the URL are already what the person is handed, so storing them discloses nothing new.
3. **A callback route completes the flow server-side.** `createA2AApp({ toolCredentials: { store, consent } })` mounts a `GET` at the path of the configured redirect URI. It sits before the bearer check, with its own rate limit (30 per 15 minutes per IP by default).
   - **The state** is 256 random bits, single-use (taken before any other check, so a failed attempt spends it), expiring (10 minutes by default), and bound server-side to the app, user, session, provider and paused call.
   - **The caller.** When the request carries a credential the authenticator accepts (behind a server secret, only once the bearer matches), the caller must be the flow's user, else `403`. `requireCallerIdentity` refuses a callback without one.
   - **PKCE S256.** The verifier goes only to the token endpoint, in the server's own request. The redirect URI is the configured one in both requests, never one read from the callback.
   - **The exchange.** No redirect is followed, there is a time limit and a response bound, and a provider's error is reported by kind, never by its text.
   - **The tokens** go to the sealed credential store. The page the browser lands on says only what happened, sent `no-store`, `no-referrer`, under a `default-src 'none'` policy.
   - **The trail.** A `consent.callback` audit row records the provider, the app, a scope hash and the reason, never a value.
4. **The next message resumes the call.** While a request is open, `runSyndicateTurn` checks the store:
   - **Granted.** The message becomes the request's answer, `{ credentialKey, granted: true }` (`credentialResponsePart`), which carries no credential. Before its next step the native loop runs the paused call again (`grantedCalls` in `lib/runtime/native/interrupts.ts`). It is a port of ADK's auth preprocessor, ahead of the approval resume as ADK orders them: the last event with content must be the user's, the answer must name this agent's request and grant its `credentialKey`, and the calls named by `function_call_id` run from the latest event that made them.
   - **Not granted.** The message repeats the request (`result.consent`, `input-required`) and runs nothing.

   A dispatch resume replays the interrupted turn raw, as approvals and questions do.
5. **The surface is additive.**
   - `SyndicateTurnOptions.toolCredentials`, `SyndicateTurnResult.consent` and `RouteDecision.decidedBy: 'consent'` are optional additions; the function's signature is unchanged.
   - On A2A, the task ends `input-required` with a `consent_request` data part (`consent_id`, `agent`, `provider`, `authorization_url`, `state`, `scopes`) beside the existing `approval_request` and `input_request`.
   - The audit trail gains the `consent.callback` event.
6. **The ADK runtime does not resume it.** ADK's preprocessor would ignore a credential-free answer, and would need the secrets in the event to exchange a code itself. An open credential request on `runtime: 'adk'` throws `UnsupportedOnRuntimeError` before any model call. No own tool can raise one on ADK yet: its tool context has no `accessToken` until WS6-3c.

> **Note (2026-10-09):** [ADR 0118](/decisions/0118-skill-scripts-and-oauth-consent-inside-delegated-subagents.md) gives a delegated subagent's loop the consent step too, its flows bound to the caller's app, so a consent request inside a subagent pauses the turn through the open call and the grant's answer travels back down; the Consequences line on delegated subagents no longer holds.

## Alternatives considered

- **A new interrupt name** (`melch_request_consent`). Rejected. ADK's name already means "this call waits for a credential", the native loop already stored it, and the history projection already hides it from the model on both runtimes. A new name would add a fifth stored shape to keep stable.
- **ADK's flow as it stands: the code in the message, exchanged in the preprocessor.** Rejected. It needs the client secret and the code verifier in the stored event, readable by anything that reads sessions, and the token in `temp:` state, lost at the end of the run instead of kept sealed per user. It also makes the A2A client handle the authorization response, which the brief puts on the server.
- **The client carries the code back on its authenticated channel** (the callback page shows the code; the next message carries it). This binds the grant to the authenticated caller better than a browser redirect can. Rejected for this ticket: the code would pass through the client and the message, and so into the stored user event, and the flow would need a second hop. It stays the stronger answer for deployments whose browsers carry no identity, recorded as an open question.
- **A consent tool the model calls.** Rejected. A model-chosen call would decide when to ask and for which provider. The tool that needs the grant knows, and asking from `accessToken` keeps the model out of an authorization decision.
- **A durable pending-flow table now** (a migration, the verifier sealed under the credential key). Deferred. The task store and the turn lock are already per process unless storage replaces them, and `ConsentStates` is the plug point a shared store implements. One process keeps the verifier out of every database.
- **Resume as soon as the callback completes**, without waiting for a message. Rejected. A2A's `input-required` is answered by the client's next message, and a turn the server started on its own would need a task the client is not waiting on.

## Consequences

- `tests/oauthConsent.test.ts` covers the flow end to end, against a mock provider on a local HTTP server that checks what a real one checks: the S256 challenge against the verifier, the redirect URI, the client secret and a single-use code. It covers the pause, the data part, a message before the grant, the callback, the sealed row, the resume running the call once, and the model's next request reading only the real result. It checks that no token, code, verifier or client secret appears in any event, log line, audit row, page or model request. It also covers the refusals: replayed, tampered, cross-user (which spends the state), declined, a refused code, expired, unknown provider, unsafe configuration, and the ADK runtime's refusal.
- The pending flows are per process. Behind several instances, the callback must reach the instance that paused the call (sticky routing), until a shared `ConsentStates` exists.
- The callback requires the caller's identity by default (`requireCallerIdentity`, the owner's decision of 2026-10-08). Without it, the state alone would bind a flow to its user, and a person who opened someone else's authorization link within its ten minutes, and consented, would grant their account to that link's user (an account-linking attack). A deployment whose browsers carry no identity can set `requireCallerIdentity: false` and accept that risk; the provider's consent screen naming the client then only limits it.
- A delegated subagent gets the parent's credentials but no consent step: its pause would end inside the call, as ADK's `AgentTool` swallows any pause ([ADR 0028](/decisions/0028-approval-gates.md)).
- WS6-3c adds the YAML that names an agent's providers and wires `accessToken` into the ADK runtime's tool context. A consent opened there will need ADK's preprocessor bypassed or ported, or the refusal kept.
