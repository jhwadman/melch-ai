---
type: decision
title: "ADR 0152: Old tool results go to the model as recallable stubs, and defineTool results are capped by default"
description: "The history projection sends a tool result older than the last keep_recent_events events and longer than mask_over_chars as a { masked, ref } stub; recall_tool_result, listed only while something is masked, reads the stored result back within the agent's own scope; a defineTool result is cut at the shared limit unless the tool says otherwise. Masking is on by default for every agent on the native loop; the tail slides, with no stored marker."
tags:
  - decision
  - runtime
  - tools
status: stable
generated:
  by: claude-code/claude-fable-5-1
  at: 2026-11-02
sources:
  - resource: lib/runtime/native/history.ts
  - resource: lib/runtime/native/recall.ts
  - resource: lib/runtime/native/request.ts
  - resource: lib/runtime/native/compaction.ts
  - resource: lib/tools/toolContract.ts
  - resource: lib/syndicateSchema.ts
  - resource: tests/historyMasking.test.ts
---

# ADR 0152: Old tool results go to the model as recallable stubs, and defineTool results are capped by default

**Decided (2026-11-02):** A tool result is read once and then resent on every step until a compaction removes it, and most of a long conversation's input is tool results. So the history projection (`lib/runtime/native/history.ts`) sends a result older than the verbatim tail (the last `keep_recent_events` projected events, default 6, the tail start moved back so no answer loses its call) and longer than `mask_over_chars` (default 1,000) as `{ masked: true, tool, ref, chars, head }`: the stored event's id, the original's length and its first 200 characters. The call stays, the stored event is untouched, a small result stays whole, and another agent's masked result is retold as the stub. On a request whose projection masked anything, the builder lists `recall_tool_result` and adds one fixed line to the system prompt; the tool is made per request, closed over that session's events and the agent's history scope, returns the stored result (cut at the shared limit) for an event the agent's own projection would include, and "no such result" for any other ref. This is on by default for every agent on the native loop; `context: { mask_over_chars: 0 }` turns it off, and `context:` no longer needs `compact_after_tokens`, whose delegate-orchestrator rule now applies to that key alone. A `defineTool` result is cut at `MAX_RESULT_CHARS` unless the spec sets `maxResultChars` (0 for none); `web_extract` keeps its own `char_limit`.

**Instead of:** a stored boundary marker advanced in batches (a prefix change invalidates the cache only from the changed event on, so a tail that slides one event per step costs the re-caching of the tail alone, and a marker would have been one more event kind for the app and the compactor to understand); summarizing results with a model (JetBrains's measurement: plain masking halves cost and matches the solve rate); a global recall tool in the registry (it must read one session only); listing the recall tool on every request (the fixed line and declaration would cost every request, instead of one prefix change when masking starts); masking inside the stored session.

How it works: [Native loop](/overview/native-loop.md), [Tool contracts](/tools/tool-contracts.md). The plan this is the second phase of: `plans/context-management.md`.
