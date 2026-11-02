---
type: decision
title: "ADR 0151: The prompt prefix is stable, per-step text rides after the history, and Claude requests carry automatic cache control"
description: "Text that changes between an agent's requests (preload_memory's recall for this message) leaves the system prompt for ModelRequest.turnNotes, which every adapter places after the history; the Claude adapter sends top-level cache_control on Anthropic's own API; a test holds the system prompt and tool declarations byte-identical across turns."
tags:
  - decision
  - runtime
  - models
status: stable
generated:
  by: claude-code/claude-fable-5-1
  at: 2026-11-02
sources:
  - resource: lib/models/contract.ts
  - resource: lib/runtime/native/request.ts
  - resource: lib/tools/tool.ts
  - resource: lib/tools/memoryTools.ts
  - resource: lib/models/claudeAdapter.ts
  - resource: tests/promptPrefix.test.ts
  - resource: scripts/context_report.ts
---

# ADR 0151: The prompt prefix is stable, per-step text rides after the history, and Claude requests carry automatic cache control

**Decided (2026-11-02):** Every provider caches a prompt as a prefix: the tools, then the system prompt, then the history. A word that changes in the system prompt misses the whole history behind it, and `preload_memory` changed one every request. So `ModelRequest` gains `turnNotes`, text for this step alone, and an `InstructionTool` marked `volatile` (preload_memory) writes there instead of into the system prompt. Each adapter places the notes after the history: on the last user message (Claude, Gemini, the chat-completions family), or as one more user item (the Responses API); never as a trailing system message, which some OpenAI-compatible servers refuse. The Claude adapter sends top-level `cache_control: { type: 'ephemeral' }` on Anthropic's own API, so the breakpoint follows the growing history without the loop placing one. `tests/promptPrefix.test.ts` holds an agent's system prompt and tool declarations byte-identical from one turn to the next, and `scripts/context_report.ts` reads the ledger's per-step input and cache-read tokens so the effect is measured, not assumed.

**Instead of:** a `SystemMessage` after the history (every adapter hoists those into the system prompt); a breakpoint the loop places per block (the four-slot limit, and nothing to gain over the automatic one); `cache_control` on Bedrock and Vertex before they are confirmed to take the field; a cache-ratio span attribute (the ledger already stores both counts, and the report divides them).

How it works: [Native loop](/overview/native-loop.md), [Model contract](/models/model-contract.md), [Claude adapter](/models/claude-adapter.md). The plan this is the first phase of: `plans/context-management.md`.
