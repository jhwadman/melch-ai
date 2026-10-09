---
type: decision
title: "ADR 0116: A step's subagent calls run at once under the syndicate's max_concurrency, stored in call order"
description: "When an orchestrator's model calls several subagents in one step, the native loop runs them concurrently through a per-step DelegationGate (lib/runtime/native/delegate.ts): at most max_concurrency at once (a root syndicate key, default 4, at most 32), started in call order, two calls to one subagent one after the other on its one child session. The step's responses are stored once every call has answered, in call order, so the stored history is the same whatever order the children finish in. Pauses, cancel, max_steps and durable checkpoints keep their rules. Ordinary tool calls keep running at once, uncapped. This supersedes ADR 0074's Decision 2. Keeping ADK's one-after-another order, an uncapped Promise.all, a turn-wide cap, the key on the orchestrator, and capping every tool call were rejected."
tags:
  - decision
  - runtime
  - tools
status: stable
generated:
  by: claude-code/claude-opus-5-5
  at: 2026-10-09
sources:
  - resource: lib/runtime/native/delegate.ts
  - resource: lib/runtime/native/agentLoop.ts
  - resource: lib/syndicateSchema.ts
  - resource: lib/compile.ts
  - resource: tests/parallelDelegation.test.ts
  - resource: tests/nativeDelegate.test.ts
---

# ADR 0116: A step's subagent calls run at once under the syndicate's max_concurrency, stored in call order

## Context

[ADR 0074](/decisions/0074-native-delegation-runs-a-child-loop-as-agent-tool-does.md) Decision 2 ran a step's calls to subagents one after another, in call order, as ADK's `AgentTool` ran them, so the native loop's sessions and the order of its model calls matched ADK's recordings. With ADK gone ([ADR 0107](/decisions/0107-release-1-0-0-removes-adk.md)) that order only costs time: the council example's Moderator waits for the Advocate before the Skeptic starts, though neither reads the other.

Every other call in a step already ran at once ([ADR 0071](/decisions/0071-native-loop-runs-calls-as-adk-stores-them.md)), and the response event was already merged in call order. What kept subagents serial was a per-step queue in `delegate.ts`. Since then delegation gained pauses that reach the turn ([ADR 0110](/decisions/0110-pauses-inside-delegated-subagents-reach-the-turn.md), [ADR 0111](/decisions/0111-pauses-inside-nested-syndicates.md)), child sessions keyed by agent path, and durable checkpoints at step boundaries ([ADR 0113](/decisions/0113-durable-runs-checkpoint-the-sessions-beside-the-job.md)). Concurrency must keep each of them.

## Decision

1. **A step's delegated calls run at once, under a cap.** `runCalls` makes one `DelegationGate` per step and enters each delegated call (a subagent tool, a nested workflow tool) in it synchronously, in call order, before any call runs. At most the agent's `maxConcurrency` children run at once; the rest start in entry order as slots free up. A slot is held from the child's start to the end of its run (`ticket.release()` in `runCall`), so self-correction's in-order bookkeeping after it ([ADR 0075](/decisions/0075-native-self-correction-ports-adk-plugins.md)), which waits on earlier calls, never holds one.
2. **The cap is a root syndicate key, `max_concurrency`.** A positive integer, at most 32 (each slot is a model run that costs money), default `DEFAULT_MAX_CONCURRENCY` = 4. `compileSpec` puts it on the orchestrator's spec and `compileNative` on its `NativeAgent`; a nested syndicate's orchestrator runs under its own file's key. The validator refuses it beside `workflow:` (a workflow bounds its nodes with `workflow.max_concurrency`) and `dispatch:` (the classifier delegates nothing). `max_concurrency: 1` restores ADK's order.
3. **One child session, one lane.** Two calls to the same subagent in a step continue one child session, so the gate runs calls sharing a subagent name one after the other, in call order, whether the earlier one succeeded or not. A call waiting on its lane holds its slot; the earlier call already holds one, so the wait ends.
4. **Stored order is call order.** The response event is built once every call has answered, its parts in call order, and the open calls that paused children left are sorted into call order. The stored history, and the next request, are the same whatever order the children finish in.
5. **The existing rules hold, per call.** A paused child leaves its call open while the others finish and are stored. The turn's signal aborts every running child; a call still waiting for a slot answers `''` without running, and the step stores no response. Every child's model call counts toward `max_steps` when it starts. A durable run's step boundary needs every call in every session answered, so no checkpoint is taken while any child of the step runs.
6. **Ordinary tool calls are unchanged:** they start at once and are not capped. They already ran concurrently with a specified merge (ADR 0071), and capping them would change behaviour no one asked to change.

## Alternatives considered

- **Keep ADK's one-after-another order.** It needs nothing, but the 1.0 engine has no ADK session to stay compatible with in ordering, and it makes every multi-specialist syndicate as slow as the sum of its specialists. It stays available as `max_concurrency: 1`.
- **An uncapped `Promise.all` over the delegations.** Simplest, but one model step could start dozens of child runs at once, each a paid model call and a provider's rate limit hit at the same moment.
- **A turn-wide cap shared by every level.** It bounds the whole tree, but a parent holding a slot while its child waits for one deadlocks, and the cap a nested syndicate's author set would depend on who calls it. A per-step cap composes: each level bounds its own fan-out (4 × 4 at two levels), and `max_steps` still bounds the turn's model calls.
- **The key on the orchestrator block.** Inline subagents share the agent fields and cannot delegate, so the key would be valid where it means nothing. At the root it sits beside `max_steps`, the other turn control, and in a nested file it applies to that file's orchestrator.
- **Gate the call around its whole trace span, or release after self-correction.** Releasing after self-correction made a slot wait on every earlier call's end (its bookkeeping counts in call order), so one slow first call held every slot behind it. Releasing at the child's end does not.
- **Cap every tool call.** It would make one key bound all fan-out, but ordinary tools are local and cheap or already bounded by their own services, and changing them was out of scope.

## Consequences

- The council example's Advocate and Skeptic run at once when the Moderator calls both in one step; `tests/parallelDelegation.test.ts` reads it on a virtual clock (the turn takes the slower one's time), and covers the cap, the default, one lane per subagent, call-order storage, a pause among running children, two pauses in a step, cancel, `max_steps`, and the durable step boundary.
- `tests/nativeDelegate.test.ts` still compares the council's two-in-one-step case with ADK's recording, concurrently and with `max_concurrency: 1`: the stored events and the requests each model was sent are the same either way, only the start order differs.
- Under concurrency, which child's model call passes `max_steps` follows start order, which is call order for the children's first steps and the children's own pace after that; ADK stopped at a fixed point in the sequence.
- A `tool.execute` span of a delegated call includes the time it waited for its slot.
- `SyndicateYamlConfig.max_concurrency` and `AgentSpec.maxConcurrency` are new optional fields; the exports map is unchanged.
