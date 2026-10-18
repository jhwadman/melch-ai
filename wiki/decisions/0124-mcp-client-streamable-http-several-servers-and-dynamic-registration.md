---
type: decision
title: "ADR 0124: MCP client: Streamable HTTP, several servers, dynamic client registration"
description: "The MCP client speaks Streamable HTTP with SSE fallback, reaches several servers per agent, and registers itself where no client is issued."
tags:
  - decision
  - protocols
  - tools
  - security
status: stable
generated:
  by: claude-code/claude-opus-5-5
  at: 2026-10-18
sources:
  - resource: lib/tools/mcpToolFactory.ts
  - resource: lib/tools/mcpTransports.ts
  - resource: lib/tools/oauthDiscovery.ts
  - resource: lib/tools/oauthConsent.ts
  - resource: lib/tools/oauthTools.ts
  - resource: lib/tools/credentialUses.ts
  - resource: lib/a2a/oauthSetup.ts
  - resource: lib/syndicateSchema.ts
  - resource: lib/compile.ts
  - resource: config/agents/examples/connectors.yaml
  - resource: tests/mcpStreamable.test.ts
  - resource: tests/oauthDiscovery.test.ts
---

# ADR 0124: MCP client: Streamable HTTP, several servers, dynamic client registration

**Decided (2026-10-09):** The MCP client tries Streamable HTTP first and falls back to SSE only on the spec's signal; an agent may list several servers in `mcp_servers`, each with its tool names, a name collision refused at load; `client_registration: dynamic` discovers the authorization server and registers a public PKCE client, every discovered host held to the operator's OAuth allowlist and the registration sealed in the existing credential store.

**Instead of:** SSE-first probing, transport by URL suffix, falling back on any failure, namespacing tool names by server, optional per-server tool lists, `mcp_servers` beside `mcp_server_url`, YAML-written endpoints beside dynamic registration, the SDK's `OAuthClientProvider`, a new table, a confidential client
**Open:** tool-name namespacing per server (deferred); registering at a YAML-named endpoint (deferred)

How it works: [MCP](/protocols/mcp.md)
