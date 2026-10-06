---
type: decision
title: 'ADR 0041: Tool vendors get least privilege: OpenAPI auth cannot read framework secrets; MCP tools are allowlisted, gateable and bounded'
description: An OpenAPI auth may not name one of the framework's own settings (or, with OPENAPI_CREDENTIAL_ENVS, anything off that list); an agent's mcp_tools allowlist chooses which MCP tools it sees, require_approval can gate them on a dispatch route, and MCP descriptions and results are size-capped.
tags:
  - decision
  - tools
  - security
status: stable
generated:
  by: claude-code/claude-opus-5-5
  at: 2026-10-06
sources:
  - resource: lib/tools/openapiTools.ts
  - resource: lib/tools/mcpToolFactory.ts
  - resource: lib/compile.ts
  - resource: lib/syndicateSchema.ts
  - resource: tests/mcpTools.test.ts
  - resource: tests/openapiTools.test.ts
---

# ADR 0041: Tool vendors get least privilege

## Context

An enterprise readiness audit (6 October 2026) found two ways a tool vendor,
or a YAML pointing at one, reached further than an agent needs:

- **SEC-04.** An OpenAPI `auth` could name any environment variable and send
  it to the host the same YAML chose. A registry-stored syndicate could set
  `bearer_env: SUPABASE_SERVICE_ROLE_KEY` with `base_url` on a host it
  controls. MCP and A2A client tokens, by contrast, are bound to one host.
- **SEC-07.** Every tool an MCP server listed was exposed to the agent;
  `require_approval` could not name an MCP tool; and a server's tool
  descriptions and results reached the prompt unbounded.

## Decision

- **OpenAPI credentials.** `credentialEnvProblem()` refuses, at compile, any
  variable under the framework's own prefixes (`A2A_`, `SUPABASE_`,
  `DATABASE_`, `MCP_`, `MODEL_`, `MEMORY_`, `OTEL_`, `TELEMETRY_`, the
  provider prefixes and others) and a few exact names. A test checks the
  rule against every variable `.env.example` documents, so a new setting
  cannot slip through. `OPENAPI_CREDENTIAL_ENVS`, set by the operator, turns
  the rule into an exact allowlist (and is how a provider key is allowed on
  purpose).
- **`mcp_tools:`**, an agent key: the MCP tools the agent may use, by name.
  Any other tool the server lists is not exposed. A listed name the server
  does not offer is logged. `require_approval` may name a listed MCP tool,
  which validation checks statically, as it does for OpenAPI operations;
  gates still run only on the orchestrator or a dispatch route, and MCP
  tools reach only subagents, so a gated MCP tool lives on a dispatch route.
- **Bounds.** A server's tool description is cut at 1,000 characters and a
  result at 20,000, each marked where it was cut.
- **`closeMcpConnections()`** closes every open MCP connection, for an
  embedding app that stops cleanly and for tests.

## Alternatives

- **Bind each OpenAPI credential to the spec's host.** The YAML chooses the
  host too, so the binding constrains nothing the attacker cannot also set.
- **An allowlist by default.** Every existing `auth` would need a new
  setting; refusing the framework's own secrets closes the exfiltration
  path without that, and the allowlist stays one variable away.
- **Gating MCP tools by name without an allowlist.** Validation could not
  check the name until the server answered; listing it in `mcp_tools` makes
  the gate a static, reviewable fact of the file.

## Consequences

- A syndicate that sent a framework variable to an API stops compiling with
  a message naming the variable and the fix.
- Separation of duties for approvals (the approver is the same scope that
  asked) is unchanged and remains open.
