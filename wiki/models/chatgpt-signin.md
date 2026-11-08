---
type: model-provider
title: Sign in with ChatGPT
description: "lib/chatgpt/: OpenAI's Sign in with ChatGPT plan-usage flow as a local-only OpenAI credential. The browser sign-in (dynamic registration, PKCE S256, state, nonce, a 127.0.0.1 callback), the mode-600 credential file outside any git work tree, the lifecycle epoch and the two locks that make a sign-out win over work in flight, ChatGptSignInAdapter on the Responses API, the routing rule (key, then sign-in, then gateway), the served-surface refusal, the doctor's chatgpt line, and what only a live sign-in can confirm."
tags:
  - models
  - openai
  - onboarding
  - security
generated:
  by: claude-code/claude-opus-5-5
  at: 2026-10-09
sources:
  - resource: lib/chatgpt/oauth.ts
  - resource: lib/chatgpt/state.ts
  - resource: lib/chatgpt/store.ts
  - resource: lib/chatgpt/adapter.ts
  - resource: lib/chatgpt/cli.ts
  - resource: tests/chatgptSignIn.test.ts
---

# Sign in with ChatGPT

OpenAI documents a [Sign in with ChatGPT](https://developers.openai.com/siwc/token-sharing-open-source) flow that lets an open-source app running on a person's own machine use that person's ChatGPT plan for OpenAI requests. `lib/chatgpt/` implements it as the engine's own client, for local use only ([ADR 0126](/decisions/0126-sign-in-with-chatgpt-local-only.md)). It is onboarding level 9 ([setup](/operations/setup.md)).

## Signing in

`melchizedek-setup --chatgpt-signin [--port <n>]`, or `melchizedek-chat --chatgpt-signin` before a chat, runs `signIn` (`lib/chatgpt/oauth.ts`) through `lib/chatgpt/cli.ts`:

1. **The host id and the epoch.** Under the commit lock, the installation's `ext_agent_host_id` (`urn:uuid:…`) is read from the credential file, or a new file is written as `{ version, issuer, hostId }`, as OpenAI's docs ask, so an attempt that times out or is cancelled leaves the id the next attempt sends. A stored file is not overwritten here. The attempt answers to the [epoch](#the-epoch-and-the-two-locks) it reads at this point.
2. **Discovery.** `https://auth.openai.com/.well-known/openid-configuration`; the issuer must match and every endpoint must be on its origin.
3. **The listener.** A one-shot HTTP server on `127.0.0.1` (port 0, a free one, unless `--port`), path `/auth/callback`. A request with another host, path or method answers 404, and one whose `state` differs answers 400; neither ends the wait. The state is compared in constant time. The page it serves carries `no-store`, `no-referrer` and a CSP with no scripts.
4. **The authorization URL.** `client_id=dynamic_agent_client` and `agent_name_hint=Melchizedek` on the first sign-in, the issued client id after; `response_type=code`, the scopes `openid profile email offline_access resource.invoke chatgpt.tokens.use.direct`, `resource=https://api.openai.com/v1`, a fresh 256-bit `state`, `nonce` and PKCE verifier (S256 challenge), and the installation's `ext_agent_host_id` (`urn:uuid:…`). It is printed and opened in the default browser (`open`, `xdg-open` or `rundll32`, no shell).
5. **The callback** must carry one code and at most one `client_id` of the shape `[A-Za-z0-9_-]{1,200}`, never `dynamic_agent_client`, equal to a client id already stored. The issued client id is merged into the file as it is now before the exchange; an attempt the epoch has left behind stops here and its code is not spent.
6. **The exchange** posts the code, the verifier, the same redirect URI and resource, and the issued client id, with no secret. The ID token is verified with `jose` against the issuer's JWKS (RS256, iss, aud = the client id, exp, iat, sub, nonce, azp when present). The token response must be a bearer with `expires_in`, a refresh token and a `scope`; without `chatgpt.tokens.use.direct` the tokens are not kept (`plan_not_granted`).

A refusal reads as one line naming the likely cause. `invalid_grant` on the code exchange, and `access_denied`, `unauthorized_client`, `consent_required` or `interaction_required` on the callback, keep their code and say that ChatGPT refused the sign-in, that the most common cause is a ChatGPT plan or workspace that does not include plan usage for apps (OpenAI's consent page then says a required permission is unavailable, after the app has registered), and to retry with `npm run setup -- --chatgpt-signin` (`npx melchizedek-setup --chatgpt-signin` from an installed package). Any other callback error says ChatGPT did not authorize the sign-in, with its code. No message carries the authorization code or a token.

`--chatgpt-signout` (`signOut`) advances the epoch and removes the tokens from the file under the commit lock, keeping the host id and the issued client id, and only then revokes the refresh token at the discovery document's `revocation_endpoint`, retrying a 5xx once; an unconfirmed revocation says to disconnect the app in ChatGPT's settings. With no file it writes nothing. `--chatgpt-status` prints where the file is and whether it carries OpenAI ids.

## The credential file

`signInFile()`: `MELCHIZEDEK_CHATGPT_SIGNIN_FILE`, else `~/.melchizedek/chatgpt-signin.json`. It holds `version`, `issuer`, `hostId`, `clientId`, `subject`, `scopes`, `accessToken`, `refreshToken`, `expiresAt`, `earliestRefreshAt`, `savedAt` and `epoch` (`StoredSignIn` in `lib/chatgpt/state.ts`). `writeStoredSignIn` (`lib/chatgpt/store.ts`) creates the directory mode 700, writes a new mode-600 file and renames it over the old one, and refuses any path with a `.git` in an ancestor directory. `readStoredSignIn` refuses a file readable by group or others. Neither ever puts a token in an error message.

## Refresh

`freshAccessToken(file)` returns the stored access token while it has more than two minutes left. Otherwise it takes the refresh lease, re-reads the file, and refreshes only if no other process just did and `earliest_refresh_at` has passed or the token has expired. The refresh posts `grant_type=refresh_token`, the issued client id, the refresh token and the resource, with no `scope`, and stores the rotated pair; a refreshed ID token must verify and name the same subject. `invalid_grant`, `invalid_refresh_token`, `token_expired`, `refresh_token_expired`, `refresh_token_invalidated` and `refresh_token_reused` clear the tokens and end in `signin_expired`, which asks for a new sign-in. A file whose issuer is not the configured one is never refreshed. A refresh takes no cancel signal: once the issuer has rotated the token, dropping the answer would end the session.

## The epoch and the two locks

`epoch` in the credential file counts the credential's lifecycles ([ADR 0158](/decisions/0158-credential-lifecycle-epoch-and-owned-locks.md)). A file without it, or holding anything but a non-negative integer, is at zero (`credentialEpoch`); the file stays `version: 1`. A committed sign-in and every sign-out with a file advance it by one. A refresh, a registration write and clearing an unusable refresh token do not.

Every result reaches the file through `commitAtEpoch` (`lib/chatgpt/store.ts`): under the commit lock it re-reads the file, compares the epoch the work started under, and writes only on a match, merging into what the file holds now. A refresh also requires the stored refresh token to be the one it rotated. A sign-in checks its abort signal in the same step.

| What loses | What happens |
|---|---|
| A sign-in overtaken by a sign-out or another sign-in | Stores nothing, fails `superseded` |
| A sign-in whose signal fired | Stores nothing, fails `cancelled`; the signal also aborts discovery, the exchange and the JWKS fetch where they stand |
| A refresh overtaken | Stores nothing, a refused refresh clears nothing, and the caller's request reads the file again: the newer session's token, or `not_signed_in` |

A freshly issued refresh token that loses is revoked at the issuer when the file then holds no tokens, so a sign-out stays true remotely. When the file holds tokens they are a newer session's, and the lost token is dropped without a revocation that an issuer might apply per client and account.

| Lock | Guards | Held across |
|---|---|---|
| `<file>.lock` (`withSignInLock`) | One read-compare-write of the file; sign-out takes it | Local file operations only, never the browser or the network |
| `<file>.refresh.lock` (`withRefreshLease`) | One refresher at a time across processes, as rotating tokens require | The refresh's network calls; a sign-out never takes it |

A lock file is created exclusively, mode 600, and holds `{ owner, pid, host }`, with a unique `owner` per acquisition and no credential. It is abandoned when its process is known to be gone on this machine (taken over at once, so a restart after a crash goes straight through) or when it is older than a minute. An empty lock, as an older engine writes, names no process and only ages out. A release or a takeover removes a lock only if it still reads as that holder saw it: the lock is moved aside, checked, and put back if it changed hands. Waiting is bounded at 20 seconds and then fails naming the lock.

## Routing

`chatGptSignInRoutesOpenAi()` is true when the file is signed in (a refresh token, an access token and the plan scope), `MELCHIZEDEK_CHATGPT_SIGNIN` is not `off`, `OPENAI_API_KEY` is unset, `OPENAI_PLATFORM` is unset or `direct`, and `OPENAI_BASE_URL` is unset: the token goes to `api.openai.com` and nowhere else. Then `planTransport` (`lib/models/gateway.ts`) calls OpenAI funded directly, so the gateway never stands in, and `resolveAdapter` returns `ChatGptSignInAdapter` for `gpt-*` and `o<digit>*` unless the caller passed its own key or endpoint ([provider routing](/models/provider-routing.md)).

## The adapter

`ChatGptSignInAdapter` (`lib/chatgpt/adapter.ts`) is [`GptAdapter`](/models/responses-adapters.md) with provider id `openai`, so its requests, reasoning replay and stored events are GPT's, except:

- **Credential.** The SDK's key is a function that calls `freshAccessToken` on every request. The base URL is fixed at `https://api.openai.com/v1`; `organization` and `project` are null, so `OPENAI_ORG_ID` and `OPENAI_PROJECT_ID` are never sent; redirects are errors.
- **Request.** `store: false` always; `max_output_tokens`, `temperature` and `top_p` are never sent, as the preview refuses them.
- **Streaming.** Every request streams. A call that did not ask to stream is folded back into what a non-streamed call yields: one thinking partial (the summaries joined), then the final. The route closes each stream with a `response.completed` whose `output` is empty; `GptAdapter` builds the final from the `response.output_item.done` items, in `output_index` order, whenever the completed reply carries none.
- **Retries.** The SDK retries nothing (`maxRetries: 0`), so a plan's usage limit (429, `subscription_sharing_usage_limit_exceeded`) is reported once. The final's retry verdict is `GptAdapter`'s.
- **Before the call.** No sign-in is a `MISSING_API_KEY` final naming `melchizedek-setup --chatgpt-signin`; a refresh failure is `CHATGPT_SIGNIN_ERROR`; on a served surface every call is `CHATGPT_SIGNIN_LOCAL_ONLY`, before any token is read. None is retryable.

## Local only

`refuseChatGptSignInOnServedSurface(surface)` (`lib/chatgpt/state.ts`) marks the process served and throws while `chatGptSignInRoutesOpenAi()` holds. `createA2AApp`, `melchizedek-serve` (before any other startup step) and `melchizedek-worker` call it, so each refuses to start with a message naming the fixes: set `OPENAI_API_KEY` or Azure OpenAI, set `MELCHIZEDEK_CHATGPT_SIGNIN=off` for that process, or sign out. A new served surface calls the same function.

The doctor prints a `chatgpt` line whenever a file is present or either variable is set: signed in or not, whether it carries OpenAI ids, and the file's path. The providers line shows OpenAI as `ChatGPT sign-in, local only`. With any serving variable set beside a sign-in that carries OpenAI ids, the line carries a problem and `melchizedek-doctor --check` exits 1 (`checkProblems` lists it as `chatgpt: …`).

`npm test` loads `tests/helpers/isolateLocalState.ts`, which points `MELCHIZEDEK_CHATGPT_SIGNIN_FILE` at a path that does not exist, so a developer's own sign-in never reaches the suite.

## What the offline tests assert

`tests/chatgptSignIn.test.ts` runs a fake authorization server on 127.0.0.1 (discovery, a PKCE-checking token endpoint, a JWKS signing real RS256 ID tokens, revocation) and a "browser" that follows the authorization URL to the callback:

- the authorization parameters, the verifier against the challenge, the issued client id reused on a second sign-in with a fresh state and verifier;
- a callback with the wrong state (and one on the wrong path) is refused and its code never reaches the token endpoint;
- the host id persisted before the browser opens, the same id sent after a timed-out first attempt, and a stored registration left untouched by a failed attempt;
- a refused exchange (`invalid_grant`) and a refusal on the callback (`access_denied`) giving the one-line plan message, in `signIn` and through the CLI, with no code in it;
- a grant without the plan scope keeps the registration and no tokens;
- the file and directory modes, the refusal of a group-readable file and of a path inside a git work tree;
- one refresh for three concurrent callers, the rotation, the omitted scope; `invalid_grant` clearing the tokens; sign-out revoking;
- with the fake issuer held open at each point, a sign-out during a delayed refresh, the browser wait, the exchange, ID-token verification and first-sign-in discovery leaving no tokens and nothing alive at the issuer; two concurrent sign-ins leaving one set of tokens and one epoch advance; neither lock file present where it must not be;
- a late refresh or refusal leaving a newer sign-in alone; a cancel at each request and just before the commit storing nothing; a registration write keeping a rotation made during the browser wait; another issuer's file keeping its host id and epoch;
- a stale takeover in which the old holder's release leaves the new owner's lock; a dead holder's lock on both files; a live holder, another machine's and an older engine's lock waited for within the bound; the epoch on `signIn`, `signOut` and `chatGptSignInStatus`, and a pre-epoch file reading as zero;
- routing with and without a key, a proxy, Azure, `off`, and a caller's key;
- the adapter's request (bearer only, `stream`, `store`, no sampling fields) and its folded non-streamed answer through the real `openai` SDK over a fetch stub;
- the served-surface refusal in-process, in the A2A server bin and in the worker bin, and the adapter's refusal once a surface is marked;
- the doctor's line and `--check`, in-process and through the bin.

`tests/onboarding.test.ts` detects level 9 from a stored file and not from a key.

## Confirmed only against documentation

A live sign-in confirms what the fake server plays:

- the discovery document's issuer and endpoints on `auth.openai.com`;
- the issued client id arriving on the callback, and the ID token's `aud` being it;
- the unit of `earliest_refresh_at` (read as seconds, milliseconds or an ISO date);
- which `gpt-*` ids a ChatGPT plan answers (`GET /v1/models` lists them; the engine does not call it), and whether `include: ['reasoning.encrypted_content']` and a strict `text.format` are accepted on this route.

## Confirmed live (2026-10-11)

The first live sign-in, on a ChatGPT plan, confirmed: the discovery document's endpoints on `auth.openai.com`; registration as `dynamic_agent_client` with the app name on OpenAI's consent screen and an issued `oaiapp_…` client id on the callback; a plan without plan usage for apps refusing the grant (the consent page says the permission is unavailable for the workspace and plan; the exchange then fails `invalid_grant`). After an upgrade the sign-in completes. `GET /v1/models` on this route answers `{ models: [{ slug }] }` (not `data[].id`) and lists the plan's ids (that day: `gpt-6.1-sol`, `gpt-6-astra`, `gpt-6-sol`, `gpt-6-luna`, `gpt-reserve`, `gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna`, `gpt-5.5`, `codex-auto-review`); an id off the list is refused 400 ("not supported when using Codex with a ChatGPT account"). The route needs `input` as a list, and sends `response.completed` with an empty `output` (handled above). `gpt-5.5` and `gpt-6.1-sol` answer, and the structured critic delegates and answers in its schema on `gpt-5.5`.
