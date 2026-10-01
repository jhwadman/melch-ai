---
type: syndicate
title: Claude Chat
description: The Claude Chat syndicate.
tags:
  - syndicate
generated:
  by: process:wiki-build
  at: 2026-10-01
sources:
  - resource: config/agents/examples/claude.yaml
---

# Claude Chat

<!-- wiki:fill slot="charter" -->
The Claude Chat syndicate is the smallest Anthropic-backed conversational agent in the starter pack: one orchestrator (`claude-sonnet-4-6`), no subagents, no tools. Its instruction follows the prompt standard in miniature: an identity with a scope edge, a task line, three cases (answer, clarify, decline), countable style rules, and guardrails against invented facts, claimed actions, and instructions inside pasted text. Memory is session-only, kept in Supabase `adk_sessions` when credentials are set and in-process otherwise. Run it for direct conversation that needs no delegation or long-term memory.
<!-- /wiki:fill -->

<!-- wiki:generated section="composition" source="config/agents/examples/claude.yaml" -->
Run: `npm run syndicate:claude`

- memory: `session-only`
- orchestrator: **Claude** (`claude-sonnet-4-6`)

| Subagent | Model | Tools | MCP |
|---|---|---|---|
<!-- /wiki:generated -->
