---
type: decision
title: "ADR 0143: DeepSeek is a direct provider; reasoning_content goes back on every turn of a tool request"
description: "deepseek-* ids get a direct DeepSeek adapter on the chat-completions base, funded by DEEPSEEK_API_KEY, with a tested capability row; with tools, every past assistant message carries reasoning_content (stored, else empty), an output schema goes as JSON mode, and web_search is not native."
tags:
  - decision
  - models
status: stable
generated:
  by: claude-code/claude-opus-5-5
  at: 2026-10-22
sources:
  - resource: lib/models/deepseekAdapter.ts
  - resource: lib/models/chatCompletionsAdapter.ts
  - resource: lib/models/providerMap.ts
  - resource: lib/models/capabilities.ts
  - resource: db/migrations/0019_deepseek_kimi_pricing.sql
  - resource: tests/models.test.ts
  - resource: tests/capabilityMatrix.test.ts
---

# ADR 0143: DeepSeek is a direct provider; reasoning_content goes back on every turn of a tool request

**Decided (2026-10-22):** `deepseek-*` ids get a direct DeepSeek provider (`DEEPSEEK_API_KEY`, `https://api.deepseek.com`, `DEEPSEEK_BASE_URL` for a proxy) built on the chat-completions base, with a tested capability row; `deepseek-flash` is the default. DeepSeek returns 400 on a request with tools unless every earlier assistant message carries its `reasoning_content`, so the base gains `replaysReasoningOnEveryTurn`: on a tool request the adapter sends the same model's stored state on every assistant message, earlier turns included, and an empty string where none is stored. Without tools only the current turn's loop replays, as for Kimi (ADR 0046). The base also gains `takesStrictJsonSchema`: DeepSeek has JSON mode only, so an output schema goes as `response_format: json_object` with the schema asked for in the system message, and the engine validates the reply. `reasoning: none` sends `thinking: disabled`; other levels send `thinking: enabled` with `reasoning_effort` low, high or max (`medium` as high, `xhigh` rounded up to max, as on Kimi K3); no effort is pinned, since the vendor default (`high`) is not its slowest. Forced `tool_choice` is weakened to auto. `web_search` is dropped: DeepSeek's Search is a separate REST API. Price rows (migration 0019) hold the peak rate, double the off-peak list, beside Kimi's first rows.

**Instead of:** the gateway only (it carries no reasoning state, so a DeepSeek tool loop would need the upstream to keep it); replaying only the current turn (a 400 on the second turn of a chat with tools); omitting `reasoning_content` where no state is stored (the field must be present); sending a strict `json_schema` (not offered); off-peak price rows (a budget would underestimate peak calls by half)
**Supersedes:** none
**Open:** not run live (no key when written): whether DeepSeek accepts an empty `reasoning_content` on a turn whose state was not stored, and whether a forced `tool_choice` holds in thinking mode; a client-side tool over DeepSeek's Search API

How it works: [Chat-completions adapters](/models/chat-completions-adapters.md)
