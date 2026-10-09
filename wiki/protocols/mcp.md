---
type: protocol
title: MCP
description: Reaching outward and serving outward over the Model Context Protocol — runtime tool discovery for agents, contract-derived SSE servers, and the SSRF guard between them.
tags:
  - mcp
  - protocols
generated:
  by: claude-code/claude-fable-5
  at: 2026-07-26
sources:
  - resource: lib/tools/mcpToolFactory.ts
  - resource: scripts/wiki/mcp_server.ts
  - resource: scripts/demo_mcp_server.ts
  - resource: scripts/science_mcp_server.ts
  - resource: lib/tools/mcpServe.ts
  - resource: lib/tools/oauthTools.ts
  - resource: tests/oauthTools.test.ts
---

# MCP

MCP runs in both directions here.

## Agents reaching outward

An agent whose YAML declares `mcp_server_url`, the orchestrator or a subagent, gets its capabilities at **runtime**: `lib/tools/mcpToolFactory.ts` dials the server over SSE, asks `tools/list`, and makes each answer an own Tool (`loadMcpTools`): its declaration is the server's description and input schema, each top-level property given a type and a description, and its execute calls the server. The native loop runs those own Tools (`createMcpTools` is the compiler's name for the same list), as it runs every [tool contract](/tools/tool-contracts.md). The parameters pass through Gemini's dialect once (`mcpToolParameters`), so every provider is declared the same schema, without `default`, `propertyNames`, `$schema` or a boolean `additionalProperties`. Declared YAML `tools:` merge with discovered ones; declared names win on collision. An unreachable server degrades to an empty tool list with a console warning — the agent runs, capability-less, rather than crashing the syndicate.

The orchestrator's own tools are resolved as a subagent's are (`resolveAgentTools` in `lib/compile.ts`, from `compileSpec`): registry names, OpenAPI operations, then the MCP server's tools, so a one-agent syndicate reaches its server with no subagent in between. On a plan-dispatch syndicate the orchestrator is the classifier, and its MCP tools stand where its `tools:` would.

The point, taught by the [Librarian](/agents/librarian.md) example: the agent's reach is no longer fixed at design time.

**SSRF guard:** `mcp_server_url` can arrive from registry-stored config, so the factory refuses non-http(s) schemes, local names, and private, loopback and link-local addresses in every encoding (IPv4-mapped, NAT64, 6to4), and resolves the host name and refuses it when any address is non-public — the one guard in `lib/net/addressGuard.ts` that `web_extract` and remote A2A agents share — unless `ALLOW_PRIVATE_MCP=true` (local development). The transport's every request goes through `mcpFetch`, which follows redirects one hop at a time under the same rule as OpenAPI tools ([ADR 0036](/decisions/0036-redirects-under-the-ssrf-guard.md)): a hop on the server's origin gets the server's check, a hop elsewhere the full guard with no development exception and no credential header; the SDK itself refuses a message endpoint on another origin. A failed connect closes the transport, so an unreachable server leaves no reconnecting stream behind. An agent's `mcp_tools:` names the server's tools it may use; any other tool the server lists is not exposed, and on the orchestrator or a dispatch route `require_approval` may gate a listed one, so a write waits for a person ([ADR 0041](/decisions/0041-tool-vendors-get-least-privilege.md)). A server's tool descriptions are cut at 1,000 characters and its results at 20,000, since both reach the model. `closeMcpConnections()` closes every open connection for an embedding app that stops cleanly. Standing doctrine: a remote MCP server is an untrusted tool vendor; its results are **data, never instructions**.

**Credentials:** a server that requires a bearer token gets one from `MCP_BEARER_TOKENS`, a JSON object of hostname → token (`mcpAuthHeaders`). The header travels on the SSE GET and every message POST, but only over https and only to the exact host the map names — the same registry-stored-config threat as the SSRF guard, so a config pointing at any other host connects with no credential. A missing, malformed or mismatched token leaves the server refusing the connect, which lands in the same empty-tool-list degradation as an unreachable server.

**OAuth:** an agent declares the grant its server takes with `mcp_auth: { oauth2 }` beside `mcp_server_url` ([ADR 0112](/decisions/0112-oauth-grants-declared-beside-the-tool.md)), and `MCP_BEARER_TOKENS` no longer applies to that server. Every request (the SSE stream and each POST) carries the token through `bearerFetch`, inside `mcpFetch`'s redirect rule, so a hop off the server's origin loses it. Over https only, or http to a loopback host.

- **`client_credentials`**: the server's own token, on one connection opened at startup, as before.
- **`authorization_code`**: each user's own token, so nothing is listed at startup and `mcp_tools` is required. Each named tool reads the run's user's token at call time (`ctx.accessToken`, which raises the [consent pause](/tools/tool-contracts.md#the-consent-step) for a user who has not granted it) and runs on that user's own connection, at most 64 of them per server, the least recently used closed first. The parameters come from the first listing any user's connection makes; until then a tool declares none, and its first call connects and tells the model to call again with the parameters it now has, rather than call the server blind. A failed call closes that user's connection, and the next call opens a fresh one. The consent pause is raised only by an agent the turn runs directly (a dispatch route), not by a delegated subagent.

## Serving outward

Servers are express + SSE, bound to 127.0.0.1, unauthenticated by design (never bind wider without real auth in front), rate-limited (240 requests a minute), using the low-level `Server` API:

- `npm run mcp:demo` — the library-catalog teaching server (`:8931`, `MCP_DEMO_PORT`), hand-written schemas and dispatch on purpose, real read/write state persisted to `demo/library.json`.
- `npm run mcp:wiki` — this knowledge bundle (`:8933`, `MCP_WIKI_PORT`), every tool derived from the [wiki tool contracts](/tools/wiki-tools.md); includes gated writes.
- `npm run mcp:science` — the read-only [evidence tools](/tools/evidence-tools.md) (`:8934`, `MCP_SCIENCE_PORT`), derived from their contracts.

The contract servers share one scaffold, `serveContracts` in `lib/tools/mcpServe.ts`. Its `contracts` list is the deliberate act: a contract not listed there does not exist to MCP clients. A server of your own is the same call with your own list.
