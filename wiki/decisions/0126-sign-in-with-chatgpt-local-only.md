---
type: decision
title: "ADR 0126: Sign in with ChatGPT as a local-only OpenAI credential"
description: "OpenAI documents a Sign in with ChatGPT plan-usage flow for open-source apps that run on the user's machine. The engine implements it as its own dynamically registered public client (PKCE S256, state, nonce, a 127.0.0.1 loopback redirect), stores the tokens mode 600 outside any git work tree, refreshes them under a lock, and routes OpenAI ids through a GptAdapter subclass when no OPENAI_API_KEY is set. Served surfaces (the A2A app and server, the worker) refuse to start while it is the OpenAI path; the doctor reports it and --check fails a served config on it. A new onboarding level 9 replaces the ChatGPT half of the unsupported subscription entry. Reusing the Codex CLI's client id or tokens, the DevKit as a dependency, an owner-registered client id, a keychain store, the gateway-first order and serving on a plan were rejected."
tags:
  - decision
  - models
  - openai
  - onboarding
  - security
status: stable
generated:
  by: claude-code/claude-opus-5-5
  at: 2026-10-09
sources:
  - resource: lib/chatgpt/oauth.ts
  - resource: lib/chatgpt/state.ts
  - resource: lib/chatgpt/store.ts
  - resource: lib/chatgpt/adapter.ts
  - resource: lib/chatgpt/cli.ts
  - resource: lib/models/adapterResolver.ts
  - resource: lib/models/gateway.ts
  - resource: lib/doctor.ts
  - resource: lib/onboarding.ts
  - resource: lib/a2a/app.ts
  - resource: tests/chatgptSignIn.test.ts
  - resource: https://developers.openai.com/siwc
  - resource: https://developers.openai.com/siwc/token-sharing-open-source
  - resource: https://developers.openai.com/siwc/token-sharing-open-source/sign-in
  - resource: https://developers.openai.com/siwc/token-sharing-open-source/profiles-and-sessions
  - resource: https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference
  - resource: https://developers.openai.com/siwc/token-sharing-open-source/token-reference
  - resource: https://developers.openai.com/siwc/token-sharing-open-source/errors-and-recovery
  - resource: https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations
  - resource: https://developers.openai.com/siwc/token-sharing-open-source/self-hosted-vms
  - resource: https://developers.openai.com/cookbook/articles/sign-in-with-chatgpt
  - resource: https://github.com/openai/sign-in-with-chatgpt-devkit
---

# ADR 0126: Sign in with ChatGPT as a local-only OpenAI credential

## Context

[ADR 0123](/decisions/0123-onboarding-levels-from-one-generator.md) gave consumer subscription sign-ins an honest entry and no code path, and left OpenAI's documented plan-usage flow as an open question. The owner decided on 2026-10-09 to implement OpenAI's official flow, for local use only.

What OpenAI documents (read 2026-10-09):

- **Who may use it.** "ChatGPT plan usage" is open to open-source projects, personal projects that run locally, and selected private apps; a paid or remotely hosted app joins a waitlist ([Sign in with ChatGPT](https://developers.openai.com/siwc), [the cookbook article](https://developers.openai.com/cookbook/articles/sign-in-with-chatgpt), [token sharing for open-source apps](https://developers.openai.com/siwc/token-sharing-open-source)).
- **Registration.** None ahead of time. The first authorization sends `client_id=dynamic_agent_client` with an `agent_name_hint`; the loopback callback returns the client id OpenAI issued, which the app keeps for every later sign-in and refresh. A stable `ext_agent_host_id` (`urn:uuid:…`) identifies the installation ([sign-in](https://developers.openai.com/siwc/token-sharing-open-source/sign-in)).
- **The grant.** Authorization code with PKCE S256, a fresh state and nonce, scopes `openid profile email offline_access resource.invoke chatgpt.tokens.use.direct`, resource `https://api.openai.com/v1`, redirect `http://127.0.0.1:<port>/auth/callback` (any port, never `localhost`), authorization at `https://auth.openai.com/api/accounts/authorize` and tokens at `…/api/accounts/oauth/token`, found through the issuer's OpenID configuration; a public client, no secret. The ID token is verified against the issuer's JWKS (iss, aud = the issued client id, exp, nonce); the plan scope in the granted scopes is what enables plan usage.
- **Tokens.** An access token lasts an hour; the refresh token lasts 30 days and is replaced on every refresh; `earliest_refresh_at` may say when a refresh is allowed. Refreshes for one session must be serialized. Revocation takes the refresh token at the discovery document's `revocation_endpoint` ([token reference](https://developers.openai.com/siwc/token-sharing-open-source/token-reference), [profiles and sessions](https://developers.openai.com/siwc/token-sharing-open-source/profiles-and-sessions)). `invalid_grant` and the `refresh_token_*` codes mean sign in again ([errors and recovery](https://developers.openai.com/siwc/token-sharing-open-source/errors-and-recovery)).
- **What the token may call.** `POST https://api.openai.com/v1/responses` with `stream: true` and `store: false`, and `GET /v1/models`; never ChatGPT's `backend-api`. The preview refuses `temperature`, `top_p`, `max_output_tokens` and other parameters, takes function tools, and rejects explicit system messages ([models and inference](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference), [preview limitations](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations)).
- **Servers.** A self-hosted VM may receive credentials moved over SSH after a local sign-in ([self-hosted VMs](https://developers.openai.com/siwc/token-sharing-open-source/self-hosted-vms)). That is still one person's plan on one person's machine; nothing documents a plan answering other people's requests.

## Decision

1. **The engine is its own client.** `lib/chatgpt/oauth.ts` implements the documented flow directly: discovery (every endpoint must be on the issuer's origin), a one-shot listener on 127.0.0.1 (wrong host, path, method or state is refused and does not end the wait; the state is compared in constant time), the authorization URL with `dynamic_agent_client` and `agent_name_hint=Melchizedek` on the first sign-in and the issued client id after, the code exchange with the verifier, ID-token verification with `jose`, and the plan scope required before tokens are kept. The registration (host id, issued client id) is saved before the exchange, so a failed code does not register the app twice. No owner registration is needed, so no client-id variable exists.
2. **Stored locally, as the person's own file.** `~/.melchizedek/chatgpt-signin.json` by default, or `MELCHIZEDEK_CHATGPT_SIGNIN_FILE`: mode 600 in a mode-700 directory, replaced atomically, refused inside any git work tree, and refused on read when readable by others. Tokens never reach a log, an error message, the doctor or `--auto`.
3. **Refreshed as documented.** `freshAccessToken` refreshes within two minutes of expiry (not before `earliest_refresh_at` while the token is valid), holding a lock file and re-reading under it, so concurrent processes make one refresh. A refreshed ID token must name the same subject. An unusable refresh token clears the tokens, keeps the registration, and asks for a new sign-in. `--chatgpt-signout` clears and revokes.
4. **Routing: key, then sign-in, then gateway.** With no `OPENAI_API_KEY`, OpenAI on its own API (no `OPENAI_PLATFORM`, no `OPENAI_BASE_URL`, no caller key or endpoint) and a signed-in file, `planTransport` counts OpenAI as funded directly and `resolveAdapter` returns `ChatGptSignInAdapter` (`lib/chatgpt/adapter.ts`), a `GptAdapter` whose credential is the token source, read on every request, whose base URL is fixed at `https://api.openai.com/v1`, which sends no organization or project, makes no SDK retries, streams every request with `store: false` and drops the sampling fields. `MELCHIZEDEK_CHATGPT_SIGNIN=off` ignores the file.
5. **Local only, enforced at three points.** `refuseChatGptSignInOnServedSurface` runs in `createA2AApp`, in `melchizedek-serve` before anything else, and in `melchizedek-worker`: each refuses to start while the sign-in is the OpenAI path, naming the fixes. It also marks the process served, after which the adapter answers `CHATGPT_SIGNIN_LOCAL_ONLY` before reading a token, so a surface that skipped the startup check still never spends the plan. A new served surface (an MCP server bin among them) calls the same function. The doctor prints a `chatgpt` line and, when serving variables are set, a problem that fails `--check`.
6. **Onboarding level 9.** `chatgpt-signin` is a detectable level, detected when the sign-in carries OpenAI ids; `melchizedek-setup --chatgpt-signin | --chatgpt-signout | --chatgpt-status` and `melchizedek-chat --chatgpt-signin` run it. The unsupported entry becomes level 10 (Claude.ai, Gemini CLI, the Codex CLI's login) and routes OpenAI to level 9.

## Alternatives considered

- **Reuse the Codex CLI's client id or its `~/.codex/auth.json`.** One step for the user, and impersonation of another client: it is not the documented third-party flow, it puts the user's Codex session at risk, and its tokens were granted to Codex. Never.
- **Depend on OpenAI's DevKit (`@siwc/local`).** It implements the flow and an encrypted store, but its OpenAI-authored code is under a noncommercial licence, which this MIT package cannot pass on to its consumers, and it is not published as a library the engine could pin. The engine implements the documented protocol itself and reads the DevKit only as a reference.
- **An owner-registered client id in an environment variable.** The brief's fallback if registration needed an owner act. The docs register dynamically per installation, so a shared id would be both unnecessary and a single id across every user's machine.
- **The OS keychain or the encrypted credential store (`MELCHIZEDEK_CREDENTIAL_KEY`).** The keychain needs a native module per platform; the credential cipher seals tokens for a server's users and its key would sit in the same `.env` beside the file it protects. A mode-600 file outside the repository is what the CLI tools of this class use, and the docs ask for protected local storage.
- **Gateway before the sign-in.** The gateway is a fallback for an absent key; a person who signed in asked for their plan to pay. The sign-in is a direct credential, so it ranks with the key and above the gateway.
- **Allow serving behind an explicit opt-in.** A plan answering other people's requests is not a documented use, and an opt-in would make the plan one misconfiguration away from funding strangers. The served process can use a key or switch the sign-in off.

## Consequences

- Behaviour change for a local user with no `OPENAI_API_KEY` who signed in: OpenAI ids now run instead of failing `MISSING_API_KEY` or going through the gateway.
- The adapter differs from a keyed `GptAdapter`: no `max_output_tokens`, `temperature` or `top_p`; a non-streamed call is streamed and folded into one thinking partial and the final; a 429 is reported, not retried. A stream that ends without `response.completed` still yields the streamed text, as `GptAdapter` does, though the docs count only `response.completed` as success.
- `npm test` loads `tests/helpers/isolateLocalState.ts`, which points the sign-in at a path that does not exist, so a developer's own sign-in never changes the suite's routing.
- Only a live sign-in can confirm the shapes the fake authorization server plays: the discovery document, the issued client id on the callback, `earliest_refresh_at`'s unit, and which `gpt-*` ids a ChatGPT plan answers.
