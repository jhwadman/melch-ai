---
type: decision
title: "ADR 0132: Local MCP servers over stdio, only for operator-listed commands"
description: "An mcp_servers entry may run a local MCP server over stdio, only when MELCHIZEDEK_STDIO_MCP lists the command, with the environment named by the entry."
tags:
  - decision
  - protocols
  - tools
status: stable
generated:
  by: claude-code/claude-opus-5-5
  at: 2026-10-18
sources:
  - resource: lib/tools/mcpToolFactory.ts
  - resource: lib/syndicateSchema.ts
  - resource: lib/compile.ts
  - resource: lib/loadSyndicate.ts
  - resource: tests/mcpStdio.test.ts
---

# ADR 0132: Local MCP servers over stdio, only for operator-listed commands

**Decided (2026-10-15):** An `mcp_servers` entry may give a `command` instead of a `url`, started over stdio only when the operator lists the exact command in `MELCHIZEDEK_STDIO_MCP`, with a minimal environment plus the variables the entry names, one process per spec for the engine's life.

**Instead of:** running any command the YAML names, passing the whole environment, a process per turn, a separate `mcp_stdio:` key

How it works: [MCP](/protocols/mcp.md)
