---
type: decision
title: "ADR 0075: The native loop's self-correction ports ADK's reflect-and-retry plugins as they behave, counted in call order"
description: "lib/runtime/native/selfCorrection.ts does what ADK 2.2.0's ReflectAndRetryModelPlugin and ReflectAndRetryToolPlugin do on the ADK runtime: the reflection tool adk_handle_model_error declared on every request, a reserved or malformed call replaced by ADK's reflection call, UNKNOWN_ERROR past model_errors, reflection guidance for a throwing or unknown tool and the retry-exceeded guidance past tool_errors. Their quirks are kept so both runtimes store the same events. A step's parallel calls are counted in call order. Running ADK's plugin classes natively, correcting the quirks on one runtime, and counting in completion order were rejected."
tags:
  - decision
  - runtime
  - tools
status: stable
generated:
  by: claude-code/claude-opus-5-5
  at: 2026-10-08
sources:
  - resource: lib/runtime/native/selfCorrection.ts
  - resource: lib/runtime/native/agentLoop.ts
  - resource: lib/runtime/native/step.ts
  - resource: lib/runtime/native/request.ts
  - resource: tests/nativeLoop.test.ts
  - resource: tests/nativeStep.test.ts
  - resource: tests/selfCorrection.test.ts
---

# ADR 0075: The native loop's self-correction ports ADK's reflect-and-retry plugins as they behave, counted in call order

## Context

[ADR 0034](/decisions/0034-self-correction.md) turns self-correction on by default: `runSyndicateTurn` installs ADK's `ReflectAndRetryModelPlugin` (`retries.model_errors`, default 2) and `ReflectAndRetryToolPlugin` (`retries.tool_errors`, default 3, not throwing past the limit) on every Runner. The plugins change what the model is sent and what the store holds:

- every request declares one more tool, `adk_handle_model_error`, after the agent's own;
- a response that calls that tool, or finishes with `MALFORMED_FUNCTION_CALL`, is replaced by ADK's call to it (id `adk_handle_model_error_<uuid>`, the error in its arguments), which the loop runs, and the tool answers with reflection guidance;
- past the model limit, the plugin throws, and ADK stores an `UNKNOWN_ERROR` event with the plugin manager's message;
- a tool that throws, and a call naming no tool, answer with reflection guidance in place of the plain error, counted per tool in the run; past the limit, guidance that the limit is exceeded.

The native loop ([ADR 0071](/decisions/0071-native-loop-runs-calls-as-adk-stores-them.md)) did none of this, so its parity suites ran with `retries: 0`. A session either runtime writes must be one the other continues ([ADR 0045](/decisions/0045-own-runtime-behind-the-seam.md)), with retries at their defaults.

Probing ADK 2.2.0 with scripted adapters showed three quirks:

1. The reflection tool reads `retryCount` while the call carries `retry_count`, so its guidance always says "attempt 1".
2. The model plugin sees every response, partials included, and any response that is not an error resets the agent's count. In a streamed run a partial before each failed final resets it, so the count stays at 1.
3. The plugin looks for `MALFORMED_FUNCTION_CALL` in the finish reason. Through the model contract a malformed Gemini call arrives as an error code with finish reason `OTHER`, so no response from a contract adapter is retried for it, on either runtime. The model side is reached only by a model calling the reserved tool itself.

## Decision

1. **Own module, ADK's behaviour.** `lib/runtime/native/selfCorrection.ts` ports both plugins: the texts, argument names, ids, counts, the error message and the `UNKNOWN_ERROR` code. `SelfCorrection` holds one run's counters (per run id, per agent for the model and per tool name for the tools), as the plugin pair does per Runner. `runAgentLoop` takes it as `selfCorrection` and defaults to retries at their defaults, as `runSyndicateTurn` does. The defaults (`DEFAULT_MODEL_ERROR_RETRIES`, `DEFAULT_TOOL_ERROR_RETRIES`) live in this module, and `lib/runtime/syndicateTurn.ts` re-exports them.
2. **The quirks are kept.** The native loop stores what ADK stores, the "attempt 1", the partial's reset and the unreachable malformed check included. A correction belongs on both runtimes at once.
3. **Counted in call order.** The native loop runs a step's calls in parallel; ADK runs them one after another, and its counts follow call order. Each call's count waits for the calls before it to be counted, while the tools still run at the same time.
4. **Small hooks.** The step takes `correction` (the reflection tool, declared through the request's `extraTools` after the agent's tools, and `afterModel` on every response after the fallback's redirect check). The loop passes each call a `CallCorrection` from `forCalls`. All the logic stays in the module.

## Alternatives considered

- **Run ADK's plugin classes from the native loop.** That needs ADK's `CallbackContext`, `ToolContext` and `LlmRequest` in the native runtime, which ADR 0045 keeps out.
- **Fix the quirks natively.** Correct counts, a working malformed check and no reset on partials would read better, but then the two runtimes store different events for the same run, which the parity suites exist to rule out. The fix belongs on both runtimes together, through the contract's mapping or a ported plugin that replaces ADK's.
- **Count in completion order.** It is simpler, with no waiting. But with two failing calls and a slow success between them, the counts, and so the stored guidance, would depend on timing. `tests/nativeLoop.test.ts` has a case that fails under completion order.
- **Run the calls one after another when self-correction is on.** It matches ADK without the ordering, but slows every step to fix a counter. ADR 0071 chose parallel calls.

## Consequences

- `tests/nativeStep.test.ts` and `tests/nativeLoop.test.ts` run with retries at their defaults. Each request carries `adk_handle_model_error`, and the stored events match ADK. The loop suite's self-correction cases cover: guidance for a throwing tool and for an unknown tool, counted per tool in call order; the exceeded guidance; a success resetting the count in call order; the reserved call retried while streaming; `UNKNOWN_ERROR` past the limit; `model_errors: 0`; and a malformed failure from an adapter, stored as the failure on both runtimes.
- A long-running tool that throws with tool retries on answers with guidance, as on ADK, instead of answering nothing.
- WS2-10 builds one `SelfCorrection` per turn from the syndicate's `retries:` and hands it to every agent loop in the turn.
- Whether a malformed Gemini call should be retried through the contract is still open. It takes a change to the genai mapping or the model contract that both runtimes would read.
