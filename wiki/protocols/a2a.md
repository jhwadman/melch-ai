---
type: protocol
title: A2A
description: Any syndicate served over A2A 1.0 (with 0.3 compatibility) and any A2A agent callable as a subagent — the plug points for identity and keys, which agents are served, limits, and the compile-time-bindings trap.
tags:
  - a2a
  - protocols
generated:
  by: claude-code/claude-fable-5
  at: 2026-07-26
sources:
  - resource: scripts/a2a_server.ts
  - resource: lib/a2a/app.ts
  - resource: lib/a2a/remoteAgent.ts
  - resource: lib/a2a/identity.ts
  - resource: lib/a2a/executor.ts
  - resource: lib/a2a/policy.ts
  - resource: lib/tools/oauthConsent.ts
  - resource: tests/oauthConsent.test.ts
  - resource: lib/a2a/oauthSetup.ts
  - resource: tests/oauthHosts.test.ts
  - resource: tests/credentialHosts.test.ts
---

# A2A

`npm run start:a2a -- <syndicate>.yaml` (package: `npx melchizedek-serve`) serves a [syndicate](/agents/) over A2A on `$PORT` (default 4000). The server is `createA2AApp(options)` in `lib/a2a/app.ts`, mountable in any Express app; the bin (`scripts/a2a_server.ts`) reads the environment, listens and drains on SIGTERM. Every task runs through the one turn runtime, `runSyndicateTurn` ([ADR 0024](/decisions/0024-adk-behind-the-runtime-seam.md)), on the [native loop](/overview/native-loop.md). `createA2AApp` refuses to start when `MELCHIZEDEK_RUNTIME=adk` is set, with `RuntimeRemovedError` naming 1.0.0 ([ADR 0107](/decisions/0107-release-1-0-0-removes-adk.md)), and while a stored [Sign in with ChatGPT](/models/chatgpt-signin.md) would carry OpenAI ids (no `OPENAI_API_KEY`): a person's ChatGPT plan pays only for their own use on their own machine. It also marks the process served, so the sign-in adapter refuses every call there ([ADR 0126](/decisions/0126-sign-in-with-chatgpt-local-only.md)).

## Protocol

The server speaks A2A 1.0 with the SDK's 0.3 compatibility on every handler: the agent card lists both versions' endpoints, a request with no `A2A-Version` header is treated as 0.3, and 0.3 method names, part shapes and state spellings are translated both ways. Routes: `/.well-known/agent-card.json`, `/a2a/jsonrpc`, `/a2a/rest` for the boot syndicate, and the same under `/<agentId>/` for others — each card advertises its own URLs and declares its security schemes. `/healthz` and `/readyz` answer without credentials.

A syndicate can also CALL an A2A agent: a subagent with `a2a_agent_url:` is a remote agent (1.0 or 0.3, the card decides), reached as a delegation tool or a plan-dispatch route through `lib/a2a/remoteAgent.ts`. The delegation tool is an own Tool (`remoteAgentOwnTool`) with a subagent's single `request` argument; it keys the remote conversation by the local session and aborts with the turn. The native loop runs it as it is (`remoteAgentTool()` returns the same Tool). Its card and endpoints pass the SSRF guard; credentials come from `A2A_AGENT_TOKENS` (host → bearer or headers).

A tool an agent lists in `require_approval` runs only after a person approves the exact call ([ADR 0028](/decisions/0028-approval-gates.md)): the task ends `input-required` with the pending call (text, plus a data part `{ type: 'approval_request', approval_id, agent, tool, args }`), and the caller's next message on the conversation answers it — `approve` / `reject`, or `{ approval: { id, approved } }`. The approval is pinned to the stored call (by the native loop's approval resume, as ADK's confirmation gate pinned it), so an approval cannot run a different one. A gate on a delegated subagent, at any depth, pauses the turn the same way ([ADR 0110](/decisions/0110-pauses-inside-delegated-subagents-reach-the-turn.md)), and so does a delegated subagent's skill script run ([ADR 0118](/decisions/0118-skill-scripts-and-oauth-consent-inside-delegated-subagents.md)): the data part adds `path`, the agents from the turn's own down to the one that asked, and the decision travels down to that subagent. So does a gate inside a nested syndicate, a delegated nested workflow's agent node included, whose `path` ends at the node; the same holds for an `input_request` raised by a delegated nested workflow's `ask_user` node ([ADR 0111](/decisions/0111-pauses-inside-nested-syndicates.md)). A nested workflow run as a dispatch route or a workflow node pauses the task the same way, its `path` running from the route or node down to the node that asked, e.g. `['Writer', 'Send']`, and a message that is not the decision repeats the request ([ADR 0119](/decisions/0119-workflow-routes-and-nodes-pause-the-turn.md)). A nested dispatch syndicate's routes, which it runs as a turn of its own, pause the task wherever it runs, e.g. `path: ['Boss', 'Team', 'Ops']` delegated or `['Team', 'Ops']` as a route, and `approve` / `reject` resume them ([ADR 0120](/decisions/0120-nested-dispatch-syndicates-route-as-at-the-top.md)). A dispatch resume skips the classifier and runs the route that asked (or whose subagent asked), with the interrupted turn replayed raw. Stored function-call parts keep Gemini's `skip_thought_signature_validator` value so the replay is valid.

### OAuth consent

With `toolCredentials: { store, consent }` (`lib/tools/oauthConsent.ts`), a tool call whose provider the user has not granted ends the task `input-required` ([ADR 0085](/decisions/0085-oauth-consent-pauses-on-adks-credential-request.md), [tool contracts](/tools/tool-contracts.md)). The status message names the provider and carries the link, and a data part carries the request:

```json
{
  "type": "consent_request",
  "consent_id": "adk-…",
  "agent": "Boss",
  "provider": "github",
  "authorization_url": "https://github.com/login/oauth/authorize?response_type=code&client_id=…&redirect_uri=…&scope=…&state=…&code_challenge=…&code_challenge_method=S256",
  "state": "<43 base64url characters>",
  "scopes": ["repo"]
}
```

`consent_id` is the stored `adk_request_credential` call's id, and `state` the nonce the URL carries. The part holds no token, code, client secret or PKCE verifier. A client opens `authorization_url` in the person's browser. The provider redirects to the **consent callback**: a `GET` at the path of the consent's configured redirect URI (`/oauth/callback` by convention). The callback completes the flow server-side and answers a page that holds no value. The person's next message on the conversation, of any content, resumes the paused call. Until the grant is stored, a message repeats the request and runs nothing. The part is additive: `approval_request` and `input_request` are unchanged, and a client that ignores data parts reads the link in the status text. A call paused inside a delegated subagent, at any depth, adds `path`, the agents from the turn's own down to the one that asked, and the next message after the grant resumes that subagent's call ([ADR 0118](/decisions/0118-skill-scripts-and-oauth-consent-inside-delegated-subagents.md)).

The callback sits before the bearer check, because a browser cannot carry the A2A credential:

- It has its own rate limit (`toolCredentials.callbackLimit`, default 30 requests per 15 minutes per IP).
- The state admits it: 256 bits, single-use (spent by its first use, whatever the outcome), expiring after 10 minutes, and bound server-side to the user, the session, the provider and the paused call.
- When the request carries a credential the authenticator accepts (behind `serverSecret`, only once the bearer matches), the caller must be the flow's user, else `403`. By default (`toolCredentials.requireCallerIdentity`, default true) a callback without such a credential is refused with `401` and the state is not spent: the browser that completes a grant must carry the flow's user's identity (a session cookie or a gateway header `resolveRequest` reads), so a forwarded authorization link cannot link someone else's account. `requireCallerIdentity: false` lets the state alone bind the flow, for a deployment whose browsers carry no identity and that accepts that risk.
- The redirect URI is read from configuration only. The response is `Cache-Control: no-store`, `Referrer-Policy: no-referrer`, with a CSP of `default-src 'none'`.
- Nothing logs the query. The log names the provider and the refusal reason, and the audit trail gets a `consent.callback` row.

**The server binary** (`melchizedek-serve`) builds `toolCredentials` from the environment ([ADR 0114](/decisions/0114-oauth-tokens-go-only-to-hosts-the-operator-binds.md); `lib/a2a/oauthSetup.ts`, `serverOAuth`): `MELCHIZEDEK_CREDENTIAL_KEY` seals the store's rows (Postgres with `DATABASE_URL`, else process memory); `OAUTH_REDIRECT_URI` mounts the callback; `OAUTH_CALLBACK_IDENTITY` is `required` (the default, `requireCallerIdentity: true`) or `state`; the consent clients and refresh hooks come from the authorization-code grants the served syndicate files declare (the default, the `A2A_SERVED_AGENTS` files, or every root file when that is unset), never from a registry row. It refuses to start on a malformed key, allowlist or redirect URI, a redirect URI without a key, or a served file whose grant `MELCHIZEDEK_OAUTH_HOSTS` refuses, and prints one `oauth` line: the key's id, where rows live, the callback path, the providers, the allowlist. It reads `MELCHIZEDEK_CREDENTIAL_HOSTS` too ([ADR 0122](/decisions/0122-static-credentials-go-only-to-hosts-the-operator-binds.md)): it refuses to start on a malformed one or a served file whose static credential it refuses, warns naming each credential variable no binding holds when it is unset, and prints a `creds` line (the bound variables, or the unbound ones). It warns when `required` meets an authenticator a browser cannot carry (anything but `A2A_AUTH=header`), since every callback would then be refused.

`createA2AApp({ oauthHosts })` sets the OAuth host allowlist for the process, over `MELCHIZEDEK_OAUTH_HOSTS`, and `createA2AApp({ credentialHosts })` the credential host allowlist, over `MELCHIZEDEK_CREDENTIAL_HOSTS`; the app refuses a syndicate whose grant or static credential they do not permit when it loads one to serve: the default at startup, and each dynamic route (a file or a registry row) with `503` and the reason in the log ([tool contracts](/tools/tool-contracts.md#grants-declared-in-yaml)).
- The pending flows live in the process (`memoryConsentStates`), so the callback must reach the instance that paused the call, as the A2A task store already requires. `ConsentStates` is the plug point for a shared store.

## Identity and keys

Two separate questions, each a plug point ([ADR 0017](/decisions/0017-plug-points.md)): who the caller is, which decides whose data a request touches, and who pays for the models. `A2A_AUTH` answers the first ([ADR 0025](/decisions/0025-built-in-authenticators.md)); the built-in authenticators live in `lib/a2a/identity.ts` and are what `createA2AApp`'s `resolveRequest` takes.

- `A2A_AUTH=secret` (the default off a public URL) — every caller presents the one `A2A_SERVER_SECRET`; the calling backend names its end user in `X-User-Id`, so any holder of the secret can act as any user. Without a secret the server binds loopback only; with `PUBLIC_URL` set it refuses to start without one, or with the `.env.example` placeholder, and a public server must choose its mode explicitly ([ADR 0039](/decisions/0039-public-deployments-state-their-posture.md)): `callers` or `jwt` give each caller its own identity.
- `A2A_AUTH=callers` — one bearer token per calling backend, listed in `A2A_CALLERS` as `name:sha256[:scope]`. The config holds only each token's hash. A caller owns its scope, and an `X-User-Id` it sends nests beneath it. A scope is stable across model-key rotation, and callers given the same scope share data, which is how a deployment keeps its existing key-hash silo. `A2A_SERVER_SECRET`, while still set, keeps working beside the tokens with its old scoping, so callers move over one at a time. `melchizedek-serve --new-caller <name> [--scope s] [--token-file f]` mints a token.
- `A2A_AUTH=jwt` — a JWT from the deployment's identity provider (`A2A_JWT_JWKS_URL`, or an HS256 `A2A_JWT_SECRET`), with issuer, audience and expiry required. The scope is the user claim (`sub`), under the tenant claim when `A2A_JWT_TENANT_CLAIM` is set. A claim value that is not key-safe is stored as `h-` plus a SHA-256 prefix.
- `A2A_AUTH=header` — an authenticating gateway in front sets `A2A_TRUSTED_USER_HEADER`. It requires `A2A_SERVER_SECRET`, which only the gateway holds, so no other client can set the header.

Billing is `A2A_KEY_MODE`, whatever the authenticator:

- `server` (default) — the server's own provider keys pay.
- `byok` — the caller's `X-API-Key` pays, and a task request without one is refused (unless the authenticator supplies a key itself). `X-Provider` (default `google`) names the provider that key belongs to; the key reaches only agents whose model is on that provider. Agents on any other provider, tools that call a model, and memory extraction and embeddings run on the server's own environment keys. Under the shared secret only (`A2A_AUTH=secret`, or `A2A_SERVER_SECRET` still accepted beside caller tokens), the key's hash also prefixes the stored scope (`a2a-<hash>[/<user>]`).

In `server` mode `X-API-Key` and `X-Provider` are ignored.

The agent card declares the schemes the configured authenticator enforces.

Data is stored under the syndicate's `memory_namespace` when it declares one, else `melchizedek-a2a` ([ADR 0020](/decisions/0020-memory-contract.md)). `DELETE /memory` erases everything held for the calling scope in the default syndicate's namespace (`?all=1`: every namespace), in one transaction (`melchizedek_erase_scope`, migrations 0002, 0010, 0011 and 0013): memory facts and their ingestion markers, sessions with their subagent rows, the ledger's turns, spans, payloads, verdicts and labels, the scope's stored A2A tasks, the third-party tokens held for its tools under that namespace (with `?all=1`, every app's), and (with `?all=1`) its task-tool list and jobs. It answers with a count per store, and 501 when the server has no durable storage. A caller-token or key-hash scope that sends no `X-User-Id` also erases its end users' scopes beneath it. Turns and tasks do not record the namespace, so a namespace erase keeps only those whose conversation is still live in another namespace; a conversation whose session expired after seven idle days is erased with the rest. The budget counters hold only a hash of the scope and are not erased.

## Which agents are served

A bare `/<agentId>/` is `<agentId>.yaml` in the deployment's agents directory. The shipped `examples/` and `templates/` answer only ids in `A2A_SERVED_AGENTS`, and that list, when set, is the whole served set. The registry answers `registry:<id>`, and bare ids in `A2A_REGISTRY_AGENTS`; a registry miss is a 404 and a registry failure a 503, never a fallback to a file ([ADR 0018](/decisions/0018-files-are-the-source-of-truth.md)). Every load logs its source. A loaded config is cached for the life of the process, so a change needs a restart.

## Limits and lifecycle

With `A2A_STREAM_TEXT=true`, `message/stream` also carries the answer as the model writes it, as chunks of an `answer` artifact that is closed with the text the user receives; narration before a tool call is withdrawn, and a syndicate with guards never streams (a guard reads the whole answer first).

Each task has a deadline (`A2A_TASK_TIMEOUT_MS`, default 15 minutes) and a turn-wide model-call cap (the YAML's `max_steps`); `tasks/cancel` aborts the provider call in flight. With the Postgres task store a cancel may reach any replica: one that is not running the task answers `canceled` and records the request on the task's row (`cancel_requested_at`, migration 0014), the replica holding the task's lease reads it on its lease heartbeat (every third of the lease) and aborts the run, and the row stays `canceled` whatever that run saves afterwards ([ADR 0113](/decisions/0113-durable-runs-checkpoint-the-sessions-beside-the-job.md)). A task aborted while it waits for its conversation's turn lock ends `canceled`. While a run goes on, its progress (a tool, a delegation, a route) streams as `working` status updates. A2A turns are not resumable: a task whose instance died is failed by the reaper; durable long runs go through the [task queue and its worker](/tools/task-tools.md). The task rate limit counts submissions only, not polling GETs (`A2A_RATE_LIMIT_MAX`, default 60, per `A2A_RATE_LIMIT_WINDOW_MS`, default 15 minutes): per caller or per end-user scope when an authenticator is configured, per IP under the shared secret. The failed-login limit (`A2A_AUTH_FAILURE_MAX`, default 30 per 15 minutes per IP), the concurrency cap (`A2A_MAX_CONCURRENT_TASKS`, default unlimited), trust-proxy (`A2A_TRUST_PROXY`, default 1 hop) and body limit (`A2A_BODY_LIMIT`, default `1mb`) are environment settings too.

The server's stores are the engine's ([ADR 0080](/decisions/0080-surfaces-on-the-engines-own-interfaces.md)). `createA2AApp`'s `storage` takes the engine's `SessionService` (`lib/runtime/sessions.ts`) and `MemoryService` (`lib/runtime/memoryService.ts`), which the executor hands the turn runner as they are; the server's by-name memory checks (dimensions at boot, retention, erase) run on the service it was given. Without durable storage, and for an `internal-only` syndicate, sessions live in the engine's `InProcessSessionService`. A `resolveModel` returns what the compiler's `CompileOptions.resolveModel` returns: a model id, or a `ModelAdapter` (`melchizedek-agents/model`), which the native loop calls. The bin sets the engine's log level (`lib/runtime/logging.ts`) to `warn`.

The server is not stateless. The config cache, the rate-limiter counters and the concurrency count are always per process. A2A tasks are per process too unless `DATABASE_URL` plugs in the Postgres storage, whose task store (`adk_a2a_tasks`) every instance shares; with Supabase alone, sessions and memory are durable but tasks are not, so run one replica or route a conversation's requests to one instance. The server prints no conversation content unless `OTEL_CONSOLE_SPANS=true`.

Governance ([ADR 0026](/decisions/0026-governance-policy-and-visibility.md)) runs on the `policy` plug point:

- **Budgets.** `A2A_BUDGETS` sets daily limits per UTC day, per caller and per scope, on tasks, model calls and tokens; for example `{"perCaller":{"tokens":5000000},"callers":{"reports":{"tasks":100}},"perScope":{"tasks":50}}`. A task over budget ends `rejected` with the reason before it takes a slot. A store that cannot be read refuses. The counts live in `melchizedek_usage` (migration 0004, scopes stored only as a hash) when Postgres or Supabase is configured, else in process memory.
- **One record per task**, however it ended: agent, caller, a hash of the scope, status, reason, duration, model calls and tokens. `A2A_LOG_FORMAT=json` prints it as a JSON line among the server's other JSON lines.
- **Metrics.** `GET /metrics` (Prometheus text) serves tasks, model calls, tokens by kind, a task-duration histogram and tasks in flight, behind its own `A2A_METRICS_TOKEN`. Labels are agent, outcome and caller name, never a scope.

## The bindings trap

`{{token}}` bindings evaluate **once per agent load** — at boot for the boot syndicate, at first request for `/<agentId>/` ones. Long-lived deployments must therefore never pass per-request data through bindings: prepend it to the message instead, for example a `[System Context: Current Date is …]` line the prompt treats as authoritative over the frozen `{{current_date}}` (the shipped `research.yaml` does this; memory extraction strips such lines). Message parts may be text or `data` (sent to the model as JSON). A message with a file part ends `rejected`, as does one with no text.

Auth failures and their fixes are catalogued in [failure modes](/operations/failure-modes.md).
