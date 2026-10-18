---
type: decision
title: "ADR 0035: Moonshot AI (Kimi) is a direct provider; its search stays off the model"
description: "kimi-* ids get a direct Moonshot adapter on the chat-completions base, funded by MOONSHOT_API_KEY, with a tested capability row; Moonshot's model-side web search is not wired as native search."
tags:
  - decision
  - models
status: stable
generated:
  by: claude-code/claude-opus-5-5
  at: 2026-10-18
sources:
  - resource: lib/models/kimiLlm.ts
  - resource: lib/models/providerMap.ts
  - resource: lib/models/capabilities.ts
---

# ADR 0035: Moonshot AI (Kimi) is a direct provider; its search stays off the model

**Decided (2026-10-02):** `kimi-*` ids get a direct Moonshot provider (`MOONSHOT_API_KEY`) built on the chat-completions base, with a tested capability row. Moonshot's model-side `$web_search` is not wired as native search.

**Instead of:** the gateway only, the Anthropic-compatible endpoint through the Claude adapter, `$web_search` as native search
**Superseded by:** [ADR 0046](/decisions/0046-provider-reasoning-state-on-the-part.md) (Kimi's `reasoning_content` is replayed in the tool loop, so thinking with tools is no longer degraded)
**Open:** a client-side tool over Moonshot's REST search

How it works: [Chat-completions adapters](/models/chat-completions-adapters.md)
