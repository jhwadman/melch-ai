---
type: decision
title: "ADR 0163: A remote MCP server's static credential is named in its YAML entry, by variable"
description: "mcp_auth and an mcp_servers entry's auth take bearer_env or header { env, name } beside oauth2, read through the credential source at each request, bound by the credential host allowlist, sent only to the server's own origin."
tags:
  - decision
  - protocols
  - security
status: stable
generated:
  by: claude-code/claude-opus-5-5
  at: 2026-11-22
sources:
  - resource: lib/tools/mcpToolFactory.ts
  - resource: lib/tools/credentialHeader.ts
  - resource: lib/tools/credentialUses.ts
  - resource: lib/syndicateSchema.ts
  - resource: tests/mcpStaticCredential.test.ts
---

# ADR 0163: A remote MCP server's static credential is named in its YAML entry, by variable

**Decided (2026-11-22):** A remote MCP server's `auth` (an `mcp_servers` entry's, or `mcp_auth` beside `mcp_server_url`) is exactly one of `oauth2`, `bearer_env: NAME` or `header: { env: NAME, name }`, the OpenAPI `auth` shape. The value is read through the credential source at each request, after `credentialEnvProblem`; it is held to the credential host allowlist like an OpenAPI credential, to https or loopback http, and to the server's own origin, and a redirect to another origin is refused rather than followed without it. `MCP_BEARER_TOKENS` applies, unchanged, only to a server with no `auth`. A header name the HTTP layer, a proxy or the transport owns is refused at load.

**Instead of:** an embedder writing `MCP_BEARER_TOKENS` into its own environment; the static form on `mcp_servers` only; following a cross-origin redirect with the header stripped; reading the value once at compile

**Open:** an OpenAPI `api_key.name` is not held to the header-name rule

How it works: [MCP](/protocols/mcp.md), [Tool contracts](/tools/tool-contracts.md#static-credentials-and-their-hosts)
