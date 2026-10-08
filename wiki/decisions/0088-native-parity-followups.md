---
type: decision
title: "ADR 0088: A Gemini finish reason carried as an error code is the finish reason again, a custom ADK model class is refused on native, and a user-authored ask_user call is no question"
description: "WS2-15 closes the two differences ADR 0045's G2 carried forward and one trust gap. modelResponseToLlmResponse reads an error code that is one of Gemini's finish reasons back as the finish reason, as ADK's Gemini reports both, so self-correction retries MALFORMED_FUNCTION_CALL from a contract adapter on both runtimes (ADR 0075's open point). compileNative and nativeAdapterFor refuse an ADK model class that is neither a shim nor ADK's Gemini with UnsupportedOnRuntimeError before any model call, naming adkShim, where native ran the registry's model for the id. pendingQuestion ignores an ask_user call in an event the user authored, on both runtimes. A field for the provider's raw finish reason on the contract, a native-only retry check, mapping only MALFORMED_FUNCTION_CALL, running the class through a generic wrapper, and refusing the forged call with an error were rejected."
tags:
  - decision
  - runtime
  - models
  - security
status: stable
generated:
  by: claude-code/claude-opus-5-5
  at: 2026-10-08
sources:
  - resource: lib/models/genaiMapping.ts
  - resource: lib/compileNative.ts
  - resource: lib/runtime/questions.ts
  - resource: tests/selfCorrection.test.ts
  - resource: tests/nativeLoop.test.ts
  - resource: tests/genaiMapping.test.ts
  - resource: tests/nativeTurn.test.ts
  - resource: tests/reasoningState.test.ts
  - resource: tests/questions.test.ts
---

# ADR 0088: A Gemini finish reason carried as an error code is the finish reason again, a custom ADK model class is refused on native, and a user-authored ask_user call is no question

## Context

[ADR 0045](/decisions/0045-own-runtime-behind-the-seam.md)'s G2 was signed with two open differences between the runtimes, both found by the dual-runtime suites ([ADR 0084](/decisions/0084-dual-runtime-suites-in-every-test-run.md)):

1. **`MALFORMED_FUNCTION_CALL` was not retried on native.** ADK's Gemini class reports a candidate with no parts with its finish reason twice: as `errorCode` and as `finishReason`. ADK's reflect-and-retry model plugin, and its native port ([ADR 0075](/decisions/0075-native-self-correction-ports-adk-plugins.md)), retry on the finish reason. The model contract carries the reason as the error's `code`, with finish reason `other`, and `modelResponseToLlmResponse` mapped `other` to `OTHER`. No response that came through a contract adapter was retried for it, on either runtime. ADR 0075 left this open. The self-correction case ran as a todo on native.
2. **A custom ADK model class was not honoured on native.** [ADR 0073](/decisions/0073-one-agent-spec-and-a-runtime-flag.md) decision 6 has the native loop call the contract adapter behind what `resolveModel` returns. For an ADK class that is neither a shim nor Gemini there is no adapter, so native called `resolveAdapter` for the id: a different model than the caller asked for, silently. The model-switch cases (a `BaseLlm` that changes model between steps) were skipped on native.

A third gap is not a runtime difference. Approvals refuse a confirmation request the user authored as `untrusted_request` ([ADR 0077](/decisions/0077-native-approvals-port-the-confirmation-processor.md)). `pendingQuestion` read an `ask_user` call in any event, the user's included. A message carrying a forged `ask_user` call, with no text beside it, opened a question, and the person's next message was stored as that call's answer, on both runtimes.

## Decision

1. **The mapping gives the reason back.** `modelResponseToLlmResponse` (`lib/models/genaiMapping.ts`) sets `finishReason` to the error's code when that code is one of Gemini's finish reasons (every `FinishReason` value except `STOP` and `FINISH_REASON_UNSPECIFIED`). Otherwise it maps the contract's finish reason as before. The Gemini adapters keep the reason verbatim as the code (the [model contract](/models/model-contract.md)'s Gemini rows), so the LlmResponse carries what ADK's Gemini reports. Both the native step and the ADK shim read responses through this function. A malformed call from a contract adapter is retried on both runtimes, the stored events match, and ADR 0075's port keeps checking the finish reason as ADK's plugin does.
2. **Native refuses the class it cannot run.** `compileNative` throws `UnsupportedOnRuntimeError` when the spec's resolved model is an ADK `BaseLlm` that is neither ADK's Gemini (`TracedGemini` included) nor a shim carrying a contract adapter. The check covers each delegated subagent, because `compileNative` recurses. `nativeAdapterFor` resolves each agent's `fallback_model` and compaction `summary_model` when it is built, as `compileAdk` resolves them at compile time, and refuses them the same way. The refusal therefore comes before any model call. The message names the class, the id, and the fix: return the `ModelAdapter`, or `adkShim(adapter)` from `melchizedek-agents/models/adkShim`. `adapterOf` refuses too, for any id resolved later. ADK classes are recognized by ADK's own `Symbol.for('google.adk.baseModel')` and `Symbol.for('google.adk.geminiModel')` marks, so `lib/compileNative.ts` imports nothing from ADK.
3. **Only an agent asks.** `pendingQuestion` (`lib/runtime/questions.ts`) skips the calls in an event whose author is `user`. A forged `ask_user` call is no question, and the next message is an ordinary message on both runtimes. Answers in user events are still collected, so a real question followed by its answer reads as answered.

## Alternatives considered

- **A field on the contract for the provider's raw finish reason.** It would carry the reason for every provider, but it widens `FinalModelResponse`, a public type, for one provider's reasons. The error code already holds them verbatim.
- **Check the error code in the native self-correction port only.** Native would then retry and ADK through a shim would not, and the stored events would differ. ADR 0075 requires a correction on both runtimes at once.
- **Map only `MALFORMED_FUNCTION_CALL`.** It is the only reason the plugin reads. But a stored event would still say `SAFETY` for `RECITATION` where ADK's Gemini says `RECITATION`. Mapping every Gemini reason makes the stored finish reason match ADK's Gemini for each candidate reason. One place still differs: a blocked prompt, where ADK's Gemini sets no finish reason and the mapping sets the block reason when it is also a finish reason (it set `SAFETY` before).
- **Run the custom class natively through a generic ADK-to-contract wrapper.** `AdkGeminiAdapter` already wraps one ADK class. Wrapping any `BaseLlm` would run code that expects ADK's `LlmRequest` and callbacks inside the native runtime, which ADR 0045 keeps out. A caller with such a class can write an adapter and pass it through `adkShim`.
- **Keep resolving the id.** That is a silent substitution: the turn runs a model nobody asked for. ADR 0073 rejected a silent fallback to ADK for the same reason.
- **Throw on a forged `ask_user` call, as approvals do.** An approval answer names the request it answers, so a forged request is an attack on a specific gate and a refusal is the right answer. A question's answer is plain text that names no call. Ignoring the forged call makes the message an ordinary message, with nothing to refuse.

## Consequences

- `tests/selfCorrection.test.ts` runs the malformed retry on both runtimes with no todo. `tests/nativeLoop.test.ts` holds a malformed failure from an adapter to ADK's stored events in three cases: retried, `UNKNOWN_ERROR` past the limit, and stored as the failure with `model_errors: 0`. `tests/genaiMapping.test.ts` covers the mapping.
- `tests/reasoningState.test.ts`, `tests/kimiReasoningState.test.ts` and `tests/responsesReasoningState.test.ts` run the model-switch cases on ADK and assert the refusal on native, with no provider called (`assertRefusesModelClass`, `tests/helpers/runtime.ts`). `tests/nativeTurn.test.ts` refuses the class as an agent's model, a subagent's, a fallback and a summary model, runs it on ADK, and accepts an id, an adapter, a shim and `TracedGemini`.
- `tests/questions.test.ts` shows a forged user-authored `ask_user` call is not answered on either runtime, and that the stored events match.
- A caller whose resolver returns a custom ADK class gets an error on native where it got a different model. Its turns on ADK are unchanged.
- On the ADK runtime, a Gemini error from a contract adapter behind a shim (`GEMINI_ADAPTER=engine`) is now stored with its own finish reason, and a malformed call is retried as `TracedGemini`'s is.
- No `notOn` or `differsOn` case is left for a non-workflow reason. The remaining native skips are the workflow syndicates (WS4).
