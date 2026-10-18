---
type: decision
title: "ADR 0074: Native delegation runs a subagent as a child loop in its own session"
description: "A subagent call on the native loop runs the subagent on its own runAgentLoop in a session of its own, as ADK's AgentTool did, not on a branch of the caller's session."
tags:
  - decision
  - runtime
  - tools
status: stable
generated:
  by: claude-code/claude-opus-5-5
  at: 2026-10-18
sources:
  - resource: lib/runtime/native/delegate.ts
  - resource: lib/runtime/native/agentLoop.ts
  - resource: tests/nativeDelegate.test.ts
  - resource: tests/syndicateTurn.test.ts
---

# ADR 0074: Native delegation runs a subagent as a child loop in its own session

**Decided (2026-10-08):** A subagent is a tool (`subagentTool`) whose call runs the subagent on its own `runAgentLoop` in a session of its own, created from the caller's state and continued by later calls, with its state writes recorded on the caller's response and its last text as the result. An ADK AgentTool listed on a native agent fails the run.

**Instead of:** a branch of the caller's session, running subagent calls in parallel, reading an AgentTool's LlmAgent by shape

**Superseded by:** [ADR 0110](/decisions/0110-pauses-inside-delegated-subagents-reach-the-turn.md) (pauses inside a subagent reach the turn), [ADR 0111](/decisions/0111-pauses-inside-nested-syndicates.md) (child session filed under the agent path), [ADR 0116](/decisions/0116-a-steps-subagent-calls-run-at-once-under-max-concurrency.md) (subagent calls run at once under `max_concurrency`)

How it works: [Native loop](/overview/native-loop.md)
