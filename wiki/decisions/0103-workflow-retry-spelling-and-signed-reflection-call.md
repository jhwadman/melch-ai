---
type: decision
title: "ADR 0103: A map entry refuses retry and timeout, a node's retry spells exceptions and jitter, and native signs the reflection call on Gemini"
description: "Three follow-ups to ADR 0089 and ADR 0097. The schema refuses retry and timeout on a workflow map: entry, which neither runtime applies (each item runs under the mapped agent's own entry, as on ADK), with a message naming where they belong; this refuses YAML that loaded before. A node's retry spells exceptions (error names to retry on) and jitter, which the scheduler already honoured; the ADK runtime hands both to ADK's retryConfig, which accepts them. On the native runtime the reflection call self-correction stores in a Gemini model's place carries the replaced response's thoughtSignature, or on Gemini 3 Gemini's documented placeholder, so the next request passes Gemini 3's signature check; the ADK runtime still stores ADK's unsigned call and gets the 400. Applying the map entry's modifiers, refusing exceptions and jitter on ADK, replacing ADK's plugin on the ADK runtime, and signing every provider's reflection call were rejected."
tags:
  - decision
  - runtime
  - agents
  - gemini
status: stable
generated:
  by: claude-code/claude-opus-5-5
  at: 2026-10-08
sources:
  - resource: lib/syndicateSchema.ts
  - resource: lib/workflow/graph.ts
  - resource: lib/workflowConfig.ts
  - resource: lib/workflow/scheduler.ts
  - resource: lib/runtime/native/selfCorrection.ts
  - resource: lib/runtime/native/step.ts
  - resource: lib/models/geminiState.ts
  - resource: tests/workflowScheduler.test.ts
  - resource: tests/geminiTurnParity.test.ts
---

# ADR 0103: Workflow retry spelling, and a signed reflection call on native Gemini

## Context

[ADR 0089](/decisions/0089-workflow-scheduler-controls-follow-adks-node-runner.md) left two seams in the `workflow:` block. The schema accepted `retry` and `timeout` on a `map:` entry that neither runtime applies, since ADK's compile hands them to nothing and each item runs under the mapped agent's own entry. And the scheduler honoured a retry's `exceptions` and `jitter`, which ADK's `RetryConfig` takes, but the YAML could not spell them.

[ADR 0097](/decisions/0097-reflection-tool-declared-where-adk-declares-it.md) left one gap open on both runtimes. When a Gemini 3 model calls the reserved `adk_handle_model_error` tool, or answers `MALFORMED_FUNCTION_CALL`, self-correction stores ADK's reflection call in its place. That call has no `thoughtSignature`, and Gemini 3 rejects the next request with a 400: "Function call is missing a thought_signature in functionCall parts". On the ADK runtime the call is built by ADK's `ReflectAndRetryModelPlugin`. On the native runtime it is built by the engine's port (`lib/runtime/native/selfCorrection.ts`).

## Decision

1. **A map entry refuses `retry` and `timeout`.** `validateSyndicateConfig` and `workflowConfigProblems` report `workflow.nodes.<Map>.retry — retry on a map node is not applied: each item runs under its agent's own retry; set it on nodes.<Agent>`, and the same for `timeout`, in the same order. `MapNode.settings` is therefore always empty. A YAML that set them loaded before and now does not, so the CHANGELOG lists it as Breaking. No shipped example or template sets them.
2. **A node's retry spells `exceptions` and `jitter`.** `exceptions` is a non-empty list of error names (identifiers, matched against the error's class or `name`); `jitter` is a non-negative number. `toRetryConfig` hands both to ADK's `retryConfig`, which accepts names as strings, so the ADK runtime and the scheduler retry the same errors after the same backoff.
3. **On native, the reflection call is signed on Gemini.** `reflectionSigning(adapter, model)` is undefined for every provider but `gemini`, so their reflection call is stored as ADK stores it. For a Gemini adapter, the call carries the replaced response's signature (its first function call's, else its first signed part's). On a Gemini 3 model, a response with none, such as a `MALFORMED_FUNCTION_CALL` with no parts, gets `PLACEHOLDER_THOUGHT_SIGNATURE` (`skip_thought_signature_validator`, Gemini's documented value). The constant moves to `lib/models/geminiState.ts`, and `geminiAdapter.ts` re-exports it. The ADK runtime is left as it is.

## Alternatives considered

- **Apply the map entry's `retry` and `timeout`.** A reader of the YAML might expect it, but ADK applies neither. Applying them on native alone would make the same YAML behave differently on each runtime. Refusing the keys keeps the YAML honest on both.
- **Refuse `exceptions` and `jitter` on the ADK runtime.** ADK's `RetryConfig` accepts both, and its node runner uses them as the scheduler does, so no refusal is needed.
- **Fix the signature on both runtimes.** On ADK that means replacing ADK's reflect-and-retry model plugin with the engine's own. That is a larger change to a runtime the plan is retiring, and native is the runtime that becomes the default in 0.20.0 ([ADR 0099](/decisions/0099-native-default-moves-to-0-20-0.md)).
- **Sign every provider's reflection call.** Only Gemini reads `thoughtSignature`. Other providers' stored events would differ from ADK's for no gain.
- **Put the placeholder on every Gemini model.** Gemini 2.x does not require signatures. A carried signature is never wrong, but a placeholder there would only change the stored event.

## Consequences

- A native session differs from an ADK one by a single field: the `thoughtSignature` on the reflection call stored in a Gemini model's place. `tests/geminiTurnParity.test.ts` holds everything else equal, and it runs a stubbed Gemini 3 that refuses unsigned calls. Under that stub, a reserved-tool call and a malformed-call retry both complete on native, signed with the model's signature and with the placeholder respectively. On ADK both still fail with the 400.
- The ADK runtime still has the gap ADR 0097 recorded, until it is retired.
- Two things are confirmed only against documentation and the stub, not yet on a live Gemini 3 run: that the placeholder passes the check after a reflection call, and that a signature carried from the reserved call onto the reflection call is accepted. A live reserved-call or malformed-call turn on native would settle both.
- `tests/workflowScheduler.test.ts` runs `exceptions` on ADK and on the scheduler with the same stubs and requires the same calls and node errors. `tests/workflow.test.ts` and `tests/workflowGraph.test.ts` hold the map refusal to the same message from the schema and from the graph.
