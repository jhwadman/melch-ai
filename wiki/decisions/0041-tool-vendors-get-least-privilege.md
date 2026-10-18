---
type: decision
title: "ADR 0041: Tool vendors get least privilege"
description: "An OpenAPI auth may not name a framework setting (or anything off OPENAPI_CREDENTIAL_ENVS when set); mcp_tools: allowlists an agent's MCP tools and lets require_approval gate them; MCP descriptions and results are size-capped."
tags:
  - decision
  - tools
  - security
status: stable
generated:
  by: claude-code/claude-opus-5-5
  at: 2026-10-18
sources:
  - resource: lib/tools/openapiTools.ts
  - resource: lib/tools/mcpToolFactory.ts
  - resource: lib/compile.ts
  - resource: lib/syndicateSchema.ts
  - resource: tests/mcpTools.test.ts
  - resource: tests/openapiTools.test.ts
---

# ADR 0041: Tool vendors get least privilege

**Decided (2026-10-06):** Tool vendors get least privilege. An OpenAPI `auth` may not name one of the framework's own settings, or anything off `OPENAPI_CREDENTIAL_ENVS` when the operator sets it. `mcp_tools:` allowlists the MCP tools an agent sees and lets `require_approval` gate them, and MCP tool descriptions and results are size-capped.

**Instead of:** binding each OpenAPI credential to the spec's host, an allowlist by default, gating MCP tools by name without an allowlist
**Open:** separation of duties for approvals (the approver is the scope that asked)

How it works: [OpenAPI tools](/tools/openapi-tools.md), [MCP](/protocols/mcp.md)
