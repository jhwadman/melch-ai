---
type: decision
title: "ADR 0078: The native loop compacts with a port of ADK's token-based compactor, and its summary call is an llm.request under the agent span"
description: "`context:` runs on the native loop through lib/runtime/native/compaction.ts, a rule-for-rule port of ADK's TokenBasedContextCompactor and LlmSummarizer: the same trigger, the same cut, the same prompt, and the same compacted event, stored before the step. The summary call goes to summary_model's leaf adapter through traceLlmGeneration, charged against the turn, as an llm.request under agent.invoke and outside any model.call, where ADK's sits under invoke_agent outside call_llm. A summary that fails fails the turn, as on ADK. Running ADK's compactor from the loop, a summary call inside model.call, a fallback for the summary model and a summary failure that skips compaction were rejected."
tags:
  - decision
  - runtime
  - agents
status: stable
generated:
  by: claude-code/claude-opus-5-5
  at: 2026-10-08
sources:
  - resource: lib/runtime/native/compaction.ts
  - resource: lib/runtime/native/agentLoop.ts
  - resource: lib/runtime/native/history.ts
  - resource: lib/compileNative.ts
  - resource: tests/compaction.test.ts
---

# ADR 0078: The native loop compacts with a port of ADK's token-based compactor

## Context

[ADR 0033](/decisions/0033-context-task-code.md) gives a delegate orchestrator a `context:` block, which the ADK runtime runs as ADK's `TokenBasedContextCompactor` with an `LlmSummarizer`. ADK's request processor runs the compactor before every model step. When it fires, it stores a compacted event: author `system`, `isCompacted`, `startTime`, `endTime` and `compactedContent`. From then on, the content processor reads that summary in place of the events it covers. The native loop ([ADR 0071](/decisions/0071-native-loop-runs-calls-as-adk-stores-them.md)) did not compact, so `compileNative` refused `context:` ([ADR 0073](/decisions/0073-one-agent-spec-and-a-runtime-flag.md)). A session either runtime writes must be one the other continues ([ADR 0045](/decisions/0045-own-runtime-behind-the-seam.md)), and the history builder (`lib/runtime/native/history.ts`) already read ADK's compacted events.

## Decision

1. **A port, in `lib/runtime/native/compaction.ts`.** It works over `TurnEvent`s and imports nothing from ADK at runtime:
   - **The trigger.** The active events (the latest compaction and what follows it, in the run's isolation scope) hold more raw events than `keep_recent_events`. The cut leaves something to summarize: it starts `keep_recent_events` from the end, and moves back while it would separate a call from its answer. The prompt size passes `compact_after_tokens`. That size is the latest active event's `promptTokenCount`, or, when no event carries one, the agent's projected history in characters divided by 4. ADK's estimate reads the history with no isolation scope, and so does the port.
   - **What is summarized.** The raw events before the cut, after the active compaction when there is one.
   - **The request.** ADK's default prompt and `[Event i - Author: …]` blocks, mapped through `llmRequestToModelRequest` as the shim maps them.
   - **The answer.** The first response's first text part, then each later chunk's.
   - **The event.** It is ADK's, field for field.

   The history builder exports `activeEvents`, `isCompacted` and `contentsOf`, so the trigger and the request read the same projection.
2. **The loop stores the summary before the step.** `compactBeforeStep` runs at the top of each iteration, before the step budget, as ADK's request processors run before its call count. The loop appends the event and yields it. The step then builds its request from a session that already holds it. A turn that stopped during the summary stores nothing and returns `stopped`, as ADK's Runner drops the event of an aborted run. The compacted event is not the run's `lastEvent`.
3. **The summary call is charged and traced as the shim charges and traces it.** It goes through `traceLlmGeneration` with the summary adapter's provider and the summary model's id. It therefore counts toward `max_steps`, charges the turn's tokens, and opens one `llm.request` span. On native that span sits under `agent.invoke`, outside any `model.call`. On ADK it sits under `invoke_agent`, outside `call_llm`. The ledger rows match ([ADR 0076](/decisions/0076-native-loop-spans-feed-the-same-ledger.md)).
4. **The summary model is resolved like the agent's model, with no fallback.** It is `summary_model`, or the agent's own model. The loop's `adapterFor` resolves it, which on a native turn is `nativeAdapterFor` behind `CompileOptions.resolveModel`. Compile hands ADK's summarizer `resolveModel(id)` with no `FallbackLlm`.
5. **A failed summary fails the turn.** A first response with no text throws `LLM failed to return a valid summary.` out of the loop, as ADK's summarizer throws out of the agent's run. Nothing is stored.
6. **`ContextConfig` and `DEFAULT_KEEP_RECENT_EVENTS` live in `compaction.ts`.** `lib/compile.ts` and `lib/compileAdk.ts` re-export them under their existing names, so the native module imports no compiler.

## Alternatives considered

- **Run ADK's own compactor from the loop.** No port to keep in step. But `TokenBasedContextCompactor` reads ADK's `InvocationContext` and pushes into its session, and the summarizer takes a `BaseLlm`. The loop would bring ADK back inside its seam, the thing [ADR 0045](/decisions/0045-own-runtime-behind-the-seam.md) exists to remove. The parity suite, `tests/compaction.test.ts`, catches drift between the port and ADK while both exist.
- **The summary call inside the step's `model.call`.** One span per step would cover the summary too. But ADK's `call_llm` opens after the request processors, so its `call_llm` never holds the summary call. The `model.call` payload row would then hold a request that is not the step's.
- **A fallback for the summary model** (the agent's `fallback_model`). It would be more robust, but neither runtime does it today, and a session's events would differ by runtime.
- **Skip compaction when the summary fails, and answer from the full history.** It would be kinder to the turn. But the ADK runtime fails it, and the two runtimes must agree. Changing both is a separate decision.

## Consequences

- `compileNative` hands `context:` to the loop instead of refusing it. `runSyndicateTurn` runs a `context:` syndicate on `native`.
- `tests/compaction.test.ts` runs ADR 0033's cases on both runtimes and compares the stored events, the compacted events included, ids and times aside. The cases are a single compaction, a second compaction that folds the first in (with tool calls, and with the size estimated), and the turn runner on `native`. It also compares every request each adapter got. It continues a session compacted on ADK on native and the reverse, fails a turn whose summary has no text, and compares the ledger rows of a compacting turn.
- ADK's before/after context-compaction plugin hooks are not ported: no plugin the engine installs implements them.
- A compaction compares event times (`endTime`), and in ADK and the port alike an event stamped in the same millisecond as the last summarized one counts as covered. The parity tests advance the clock by at least a millisecond per reading, as real turns do.
