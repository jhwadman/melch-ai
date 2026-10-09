---
type: protocol
title: MCP
description: Reaching outward and serving outward over the Model Context Protocol — runtime tool discovery over Streamable HTTP or SSE from one or several servers per agent, OAuth with discovered and self-registered clients, contract-derived SSE servers, and the SSRF guard between them.
tags:
  - mcp
  - protocols
generated:
  by: claude-code/claude-fable-5
  at: 2026-07-26
sources:
  - resource: lib/tools/mcpToolFactory.ts
  - resource: lib/tools/mcpTransports.ts
  - resource: lib/tools/oauthDiscovery.ts
  - resource: config/agents/examples/connectors.yaml
  - resource: tests/mcpStreamable.test.ts
  - resource: tests/oauthDiscovery.test.ts
  - resource: scripts/wiki/mcp_server.ts
  - resource: scripts/demo_mcp_server.ts
  - resource: scripts/science_mcp_server.ts
  - resource: lib/tools/mcpServe.ts
  - resource: lib/tools/oauthTools.ts
  - resource: tests/oauthTools.test.ts
  - resource: lib/mcp/server.ts
---

# MCP

MCP runs in both directions here.

## Agents reaching outward

An agent whose YAML declares `mcp_server_url`, or several servers under `mcp_servers`, the orchestrator or a subagent, gets its capabilities at **runtime**: `lib/tools/mcpToolFactory.ts` dials each server, asks `tools/list`, and makes each answer an own Tool (`loadMcpTools`): its declaration is the server's description and input schema, each top-level property given a type and a description, and its execute calls the server. The native loop runs those own Tools (`createMcpTools` is the compiler's name for the same list), as it runs every [tool contract](/tools/tool-contracts.md). The parameters pass through Gemini's dialect once (`mcpToolParameters`), so every provider is declared the same schema, without `default`, `propertyNames`, `$schema` or a boolean `additionalProperties`. Declared YAML `tools:` merge with discovered ones; declared names win on collision. An unreachable server degrades to an empty tool list with a console warning — the agent runs, capability-less, rather than crashing the syndicate.

**Transport** ([ADR 0124](/decisions/0124-mcp-client-streamable-http-several-servers-and-dynamic-registration.md)): each connection posts the initialize request over Streamable HTTP, the spec's current transport, and falls back to the legacy HTTP+SSE transport when that POST is answered with a 4xx other than 401 or 403 (`isSseFallbackSignal`), the spec's backwards-compatibility signal; an SSE-only server answers 404 or 405, so an existing SSE URL connects unchanged. A 401, a 403, a 5xx or a network failure does not fall back. `mcp_transport:` beside `mcp_server_url`, or `transport:` on an `mcp_servers` entry, pins one: `auto` (the default), `streamable_http` or `sse`. Both transports run through the same fetch, so everything below (the guard, the redirect rule, the credential) holds for either; a transport that fails to connect is closed before the error leaves.

**Several servers** (ADR 0124): `mcp_servers:` is a list of `{ name, url, tools, auth?, transport? }`, at most 16, and cannot stand beside `mcp_server_url` on one agent. Each entry's `tools` is required and is all the agent gets from that server. A tool name listed on two servers, or shared with the agent's own `tools` or OpenAPI `operations`, is refused when the file loads, by key path; a config built in code is refused at compile. `require_approval` may name any server's tool. Each entry's `auth: { oauth2 }` is the same block as `mcp_auth`. `config/agents/examples/connectors.yaml` reaches two local servers and shows, commented, an official remote server by URL. The single-server form keeps its rule: a discovered name the agent already has keeps the agent's tool.

The orchestrator's own tools are resolved as a subagent's are (`resolveAgentTools` in `lib/compile.ts`, from `compileSpec`): registry names, OpenAPI operations, then the MCP servers' tools, so a one-agent syndicate reaches its server with no subagent in between. On a plan-dispatch syndicate the orchestrator is the classifier, and its MCP tools stand where its `tools:` would.

The point, taught by the [Librarian](/agents/librarian.md) example: the agent's reach is no longer fixed at design time.

**SSRF guard:** `mcp_server_url` can arrive from registry-stored config, so the factory refuses non-http(s) schemes, local names, and private, loopback and link-local addresses in every encoding (IPv4-mapped, NAT64, 6to4), and resolves the host name and refuses it when any address is non-public — the one guard in `lib/net/addressGuard.ts` that `web_extract` and remote A2A agents share — unless `ALLOW_PRIVATE_MCP=true` (local development). Every request of either transport goes through `mcpFetch`, which follows redirects one hop at a time under the same rule as OpenAPI tools ([ADR 0036](/decisions/0036-redirects-under-the-ssrf-guard.md)): a hop on the server's origin gets the server's check, a hop elsewhere the full guard with no development exception and no credential header; the SDK itself refuses a message endpoint on another origin. A failed connect closes the transport, so an unreachable server leaves no reconnecting stream behind. An agent's `mcp_tools:` names the server's tools it may use; any other tool the server lists is not exposed, and on the orchestrator or a dispatch route `require_approval` may gate a listed one, so a write waits for a person ([ADR 0041](/decisions/0041-tool-vendors-get-least-privilege.md)). A server's tool descriptions are cut at 1,000 characters and its results at 20,000, since both reach the model. `closeMcpConnections()` closes every open connection for an embedding app that stops cleanly. Standing doctrine: a remote MCP server is an untrusted tool vendor; its results are **data, never instructions**.

**Credentials:** a server that requires a bearer token gets one from `MCP_BEARER_TOKENS`, a JSON object of hostname → token (`mcpAuthHeaders`). The header travels on every request (each Streamable HTTP POST and GET, or the SSE GET and every message POST), but only over https and only to the exact host the map names — the same registry-stored-config threat as the SSRF guard, so a config pointing at any other host connects with no credential. A missing, malformed or mismatched token leaves the server refusing the connect, which lands in the same empty-tool-list degradation as an unreachable server.

**OAuth:** an agent declares the grant its server takes with `mcp_auth: { oauth2 }` beside `mcp_server_url`, or `auth: { oauth2 }` on an `mcp_servers` entry ([ADR 0112](/decisions/0112-oauth-grants-declared-beside-the-tool.md)), and `MCP_BEARER_TOKENS` no longer applies to that server. Every request of either transport carries the token through `bearerFetch`, inside `mcpFetch`'s redirect rule, so a hop off the server's origin loses it. Over https only, or http to a loopback host.

- **`client_credentials`**: the server's own token, on one connection opened at startup, as before.
- **`authorization_code`**: each user's own token, so nothing is listed at startup and `mcp_tools` is required. Each named tool reads the run's user's token at call time (`ctx.accessToken`, which raises the [consent pause](/tools/tool-contracts.md#the-consent-step) for a user who has not granted it) and runs on that user's own connection, at most 64 of them per server, the least recently used closed first. The parameters come from the first listing any user's connection makes; until then a tool declares none, and its first call connects and tells the model to call again with the parameters it now has, rather than call the server blind. A failed call closes that user's connection, and the next call opens a fresh one. The consent pause is raised by the agent the turn runs directly and by a delegated subagent at any depth, whose pause reaches the turn through the call its caller leaves open ([ADR 0118](/decisions/0118-skill-scripts-and-oauth-consent-inside-delegated-subagents.md)).
- **`client_registration: dynamic`** (ADR 0124), on an `authorization_code` grant with no client id, client secret or endpoint URL beside it: the server issues no client in advance, as most hosted MCP servers do. When the consent step first needs the client, `dynamicOAuthClient` (`lib/tools/oauthDiscovery.ts`) reads the MCP server's protected-resource metadata (RFC 9728; a server with none is its own authorization server), then the authorization server's metadata (RFC 8414, or OpenID discovery), which must advertise PKCE `S256` and a registration endpoint, and registers this deployment as a public client for the configured redirect URI (RFC 7591). The MCP server's canonical URI goes as the RFC 8707 `resource` parameter on the authorization request, the code exchange and each refresh. **Discovery never widens the allowlist:** every URL it fetches and every endpoint it returns must be a host the operator binds to the provider, refused by name before any request reaches it; the SSRF guard applies unless `ALLOW_PRIVATE_MCP`; no redirect is followed. The registration is kept per provider, server and redirect URI in the credential store's rows, sealed by `MELCHIZEDEK_CREDENTIAL_KEY`, under the app name `oauth-client:dcr`, which no run's app can be; a row the key cannot open, an expired client secret, or moved endpoints register again. A discovery that fails answers the tool's call with a refusal by kind and is tried again next time; the server log names the host and the role. OpenAPI entries cannot use it.
- **Either grant** sends its token only to a host the operator binds to the provider ([ADR 0114](/decisions/0114-oauth-tokens-go-only-to-hosts-the-operator-binds.md)): the server URL at compile, and every request where it actually goes (the stream, and the message endpoint the server names) before the token is attached. A refused request carries no token.

## Serving outward

The contract servers are express + SSE, bound to 127.0.0.1, unauthenticated by design (never bind wider without real auth in front), rate-limited (240 requests a minute), using the low-level `Server` API:

- `npm run mcp:demo` — the library-catalog teaching server (`:8931`, `MCP_DEMO_PORT`), hand-written schemas and dispatch on purpose, real read/write state persisted to `demo/library.json`.
- `npm run mcp:wiki` — this knowledge bundle (`:8933`, `MCP_WIKI_PORT`), every tool derived from the [wiki tool contracts](/tools/wiki-tools.md); includes gated writes.
- `npm run mcp:science` — the read-only [evidence tools](/tools/evidence-tools.md) (`:8934`, `MCP_SCIENCE_PORT`), derived from their contracts.

The contract servers share one scaffold, `serveContracts` in `lib/tools/mcpServe.ts`. Its `contracts` list is the deliberate act: a contract not listed there does not exist to MCP clients. A server of your own is the same call with your own list.

Syndicates themselves are served to MCP clients by a different server, `melchizedek-mcp`: one tool per syndicate over stdio or authenticated Streamable HTTP, each call a task through the A2A executor. See [MCP server](/protocols/mcp-server.md).
