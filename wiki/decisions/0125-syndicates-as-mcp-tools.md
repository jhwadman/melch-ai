---
type: decision
title: "ADR 0125: Syndicates served as MCP tools through the A2A executor"
description: "melchizedek-mcp serves each syndicate as one MCP tool plus melch_resume, every call one task through the A2A SyndicateExecutor."
tags:
  - decision
  - protocols
  - mcp
status: stable
generated:
  by: claude-code/claude-opus-5-5
  at: 2026-10-18
sources:
  - resource: lib/mcp/server.ts
  - resource: scripts/mcp_server.ts
  - resource: lib/a2a/executor.ts
  - resource: tests/mcpServer.test.ts
---

# ADR 0125: Syndicates served as MCP tools through the A2A executor

**Decided (2026-10-09):** `melchizedek-mcp` serves each loaded syndicate as one MCP tool and `melch_resume` for a paused turn, every call one task through the A2A `SyndicateExecutor` so limits, locks, guards and the ledger are A2A's. Approvals are answered only by `melch_resume`'s explicit boolean; stdio by default, and Streamable HTTP refuses a non-loopback bind without a 32-character secret.

**Instead of:** calling `runSyndicateTurn` from the MCP handler, one tool per agent, a single `ask` tool, stateless Streamable HTTP, an unauthenticated opt-out, approving with a message

How it works: [MCP server](/protocols/mcp-server.md)
