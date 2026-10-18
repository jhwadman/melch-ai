---
type: decision
title: "ADR 0073: One AgentSpec for every runtime, refusals at compile time"
description: "Each YAML agent compiles once into a runtime-neutral AgentSpec, the runtime is chosen per turn, and what the native runtime cannot run fails before any model call."
tags:
  - decision
  - runtime
status: stable
generated:
  by: claude-code/claude-opus-5-5
  at: 2026-10-18
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

# ADR 0073: One AgentSpec for every runtime, refusals at compile time

**Decided (2026-10-08):** `lib/compile.ts` compiles each agent once into an `AgentSpec` (tools resolved and gated, model resolved once, config built) that each runtime builds from. The runtime is chosen per turn; anything native cannot run throws `UnsupportedOnRuntimeError` before any model call, and a run's `temp:` state is kept beside the session, never in it.

**Instead of:** a declarative spec each runtime resolves, a silent fallback to ADK, refusing plan-dispatch, writing `temp:` keys into the session, a `resolveAdapter` compile option

**Superseded by:** [ADR 0107](/decisions/0107-release-1-0-0-removes-adk.md) (ADK and the adk runtime removed; the flag accepts only native); [ADR 0077](/decisions/0077-native-approvals-port-the-confirmation-processor.md), [ADR 0078](/decisions/0078-native-compaction-ports-adk-compactor.md), [ADR 0079](/decisions/0079-native-questions-resume-through-the-history.md), [ADR 0081](/decisions/0081-native-task-mode-ends-a-node-on-finish-task.md), [ADR 0095](/decisions/0095-native-workflow-turn-drains-through-the-adk-reader.md) (lifted the refusals of approvals, `context:`, questions, `mode: task`, workflows)

**Open:** a per-request Vertex AI endpoint does not reach a native call

How it works: [Native loop](/overview/native-loop.md)
