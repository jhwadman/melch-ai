---
type: decision
title: "ADR 0073: One AgentSpec for both runtimes, a runtime flag on the turn, and refusals at compile time"
description: "lib/compile.ts compiles each YAML agent once into a runtime-neutral AgentSpec (tools resolved and gated, model resolved once, config built); compileAdk builds today's LlmAgent from it and compileNative the native loop's NativeAgent. runSyndicateTurn picks the runtime by its runtime option, else MELCHIZEDEK_RUNTIME, else adk. What native does not run yet throws UnsupportedOnRuntimeError before any model call. Plan-dispatch runs on native. A run's temp: state is kept beside the session. A declarative spec resolved per runtime, a silent fallback to ADK, and writing temp: keys into the session were rejected."
tags:
  - decision
  - runtime
status: stable
generated:
  by: claude-code/claude-opus-5-5
  at: 2026-10-08
sources:
  - resource: lib/compile.ts
  - resource: lib/compileAdk.ts
  - resource: lib/compileNative.ts
  - resource: lib/runtime/runtimeFlag.ts
  - resource: lib/runtime/nativeTurn.ts
  - resource: lib/runtime/syndicateTurn.ts
  - resource: lib/runtime/native/tempState.ts
  - resource: tests/compile.test.ts
  - resource: tests/nativeTurn.test.ts
---

# ADR 0073: One AgentSpec for both runtimes, a runtime flag on the turn, and refusals at compile time

## Context

[ADR 0045](/decisions/0045-own-runtime-behind-the-seam.md) carries the move off ADK on a flag, `MELCHIZEDEK_RUNTIME` (`adk` or `native`), with `adk` the default until a later release. The native loop runs one agent as ADK runs it and stores the events ADK stores ([ADR 0066](/decisions/0066-native-step-sends-the-adk-request.md), [ADR 0071](/decisions/0071-native-loop-runs-calls-as-adk-stores-them.md)). Two things were missing before a turn could run on it:

- **One compiler.** `lib/compile.ts` built ADK's `LlmAgent` directly. The tests that ran the native step built their `NativeAgent`s by hand, each a copy of the compiler's rules (gating, examples, the skills index, reasoning, server-side invocations). A copy drifts.
- **The flag.** `runSyndicateTurn` ([ADR 0024](/decisions/0024-adk-behind-the-runtime-seam.md)) always ran ADK's `Runner`.

The native loop does not yet run delegation (WS2-6), resuming an approval or a question (WS2-7), self-correction (WS2-8), compaction (WS2-9) or workflows. Seven choices had real alternatives.

## Decision

1. **The spec is the compiler's shared work, done once.** `compileSpec` and `compileSubagentSpec` produce an `AgentSpec` with:
   - the tools resolved and gated, in the order the model sees them. A tool is the registry's object, which during the dual period carries its own Tool or InstructionTool ([ADR 0051](/decisions/0051-own-tool-base-behind-an-adk-wrapper.md)). A delegated subagent is a nested spec, and a remote one its name and URL;
   - the skills index appended to the instruction;
   - the model resolved once through `CompileOptions.resolveModel`;
   - the `generateContentConfig` built for the model the agent runs on.

   `compileAdk` (`lib/compileAdk.ts`) adds what only `LlmAgent` takes: `FallbackLlm`, `AgentTool`s, the code executor, the compactor, task mode and a workflow node's settings. `compileGraph` and `compileSubagent` are spec + `compileAdk`, with unchanged signatures. `compileNative` (`lib/compileNative.ts`) hands each tool to the loop as the own object behind it.
2. **The runtime is chosen per turn.** `runSyndicateTurn` takes an optional `runtime` (`adk` or `native`). Without it, `MELCHIZEDEK_RUNTIME` decides, and without that, `adk`. Any other value throws. The flag lives in a leaf module (`lib/runtime/runtimeFlag.ts`), so the wiki agent runner follows it too.
3. **What native does not run yet fails before any model call.** It throws `UnsupportedOnRuntimeError`, which names the feature and the runtime:
   - delegation (local or remote), `context:` and `mode: task`, refused by `compileNative`;
   - a workflow syndicate, `retries:` with a count above zero, and a caller's `transformAgent`, refused by the turn runner before the session is touched;
   - a message that resumes an approval or answers a question, refused when the turn runner reads the session.
4. **Plan-dispatch runs on native.** Its classifier and a local route are each one agent run by the turn runner, so `runNativeAgent` runs them in the same lanes and projections the ADK runtime uses. A remote route goes over A2A on either runtime.
5. **Only the agent run is swapped.** `runNativeAgent` (`lib/runtime/nativeTurn.ts`) does what ADK's `Runner` does around an agent: it reads the session, stores the message under a new `e-` invocation id (nothing when the turn was canceled first), and runs the loop. The turn runner drains it with `drainAgentStream`. Routing, guards, the relay fallback and the pause checks read the stored events, so they are shared.
6. **The adapter follows the caller's resolver, and a caller's key still pays.** On native, a model id's adapter is the one behind what `resolveModel` returns. For an ADK shim, that is its own contract adapter, so a BYOK key reaches the call. For an ADK class that is not a shim (`TracedGemini`), it is `resolveAdapter` under the key the instance carries; off Vertex AI the key is the caller's or the environment's. Otherwise it is `resolveAdapter` for the id.
7. **A run's `temp:` state lives beside the session.** The loop reads each event's `temp:` keys before the store drops them, and lays them over the session's state for the run's later requests and calls (`lib/runtime/native/tempState.ts`). That matches ADK, whose `State.set` writes into the live session. The session object itself never holds them.

## Alternatives considered

- **A declarative spec that each runtime resolves itself** (tool names, the OpenAPI and MCP entries, the raw model id). It reads as more neutral, but every rule `lib/compile.ts` applies would be applied twice: gating, OpenAPI collisions, MCP discovery, the skills index, model resolution. Two copies would drift, which is what the hand-built test agents already showed. The registry's objects already carry both faces.
- **Fall back to ADK, silently or with a warning, for a syndicate native cannot run.** A turn would then run on a runtime nobody asked for, and the parity work (WS2-12) could not tell which runtime a case ran on. Failing loudly costs an opted-in caller one clear error.
- **Refuse plan-dispatch until delegation.** Dispatch never puts an agent inside another. Refusing it would leave the most common multi-agent shape untested on native for no reason.
- **Refuse every syndicate when retries are on by default.** ADK's retry plugins are on unless `retries:` turns them off, so this would refuse almost every syndicate. Instead only an explicit count above zero is refused. A syndicate that sets nothing runs with retries off on native until WS2-8.
- **Write `temp:` keys into the live session, as ADK does.** The Supabase store saves the whole session object, so a temp key would become durable.
- **A `resolveAdapter` option on `CompileOptions` for BYOK on native.** It would carry a per-request endpoint as well as a key, but it widens a consumer-facing option before native is the default. The shim's own adapter and the key a Gemini instance carries cover the BYOK keys the A2A server resolves today.

## Consequences

- `lib/compile.ts` exports `AgentSpec`, `SpecTool`, `compileSpec` and `compileSubagentSpec` beside the existing names. `melchizedek-agents/runtime` exports `RuntimeName`, `chooseRuntime`, `runtimeSetting`, `DEFAULT_RUNTIME`, `RUNTIMES` and `UnsupportedOnRuntimeError`. `SyndicateTurnOptions` gains `runtime`. The `exports` map does not change.
- `tests/compile.test.ts` compiles one spec both ways and requires the same first request. `tests/nativeTurn.test.ts` runs conversations through `runSyndicateTurn` on both runtimes and requires the same results and stored events: a single agent over two turns, tool calls with streaming, plan-dispatch, an approval pause, an `ask_user` pause, and `temp:` state. It also shows a conversation paused on native resuming on ADK. `tests/nativeStep.test.ts`, `tests/nativeLoop.test.ts` and `tests/geminiNativeTools.test.ts` build their agents with `compileNative`.
- A per-request Gemini endpoint on Vertex AI (the credentials plug point, [ADR 0023](/decisions/0023-bring-your-own-endpoint.md)) does not reach a native call yet: the adapter takes the environment's Vertex AI endpoint.
- On native, a syndicate that leaves `retries:` unset runs without ADK's reflect-and-retry, so a throwing tool answers its error at once.
