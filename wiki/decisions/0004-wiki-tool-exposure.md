---
type: decision
title: "ADR 0004: Wiki tools in tiers: primitives for agents, composites MCP-only"
description: "Navigation and gated write tools go to syndicate agents and MCP; the agentic composites are MCP-only; every write passes one gate."
tags:
  - decision
  - tools
status: stable
generated:
  by: claude-code/claude-opus-5-5
  at: 2026-10-18
sources:
  - resource: lib/tools/wikiTools.ts
---

# ADR 0004: Wiki tools in tiers: primitives for agents, composites MCP-only

**Decided (2026-07-26):** Navigate and write tools are registered for agents and served over MCP; `wiki_query` and `wiki_garden` are MCP-only, so a syndicate gets that behaviour by being an agent with the primitives; every write goes through one validated gate.

**Instead of:** every tool to every consumer, agents nesting agent runs inside tool calls, ungated writes

How it works: [Wiki tools](/tools/wiki-tools.md)
