---
type: decision
title: "ADR 0118: Skill scripts and OAuth consent pause the turn inside delegated subagents"
description: "Skill scripts are allowed on delegated subagents and a subagent's OAuth consent request pauses the turn through the open call, its grant stored under the turn's app."
tags:
  - decision
  - runtime
  - tools
  - security
  - protocols
status: stable
generated:
  by: claude-code/claude-opus-5-5
  at: 2026-10-18
sources:
  - resource: lib/runtime/native/delegate.ts
  - resource: lib/runtime/native/interrupts.ts
  - resource: lib/runtime/native/agentLoop.ts
  - resource: lib/runtime/credentials.ts
  - resource: lib/runtime/syndicateTurn.ts
  - resource: lib/a2a/executor.ts
  - resource: lib/syndicateSchema.ts
  - resource: config/agents/templates/systems_operator.yaml
  - resource: tests/delegatedScriptsConsent.test.ts
---

# ADR 0118: Skill scripts and OAuth consent pause the turn inside delegated subagents

**Decided (2026-10-09):** A delegated subagent may run skill scripts, their approval travelling up and down the open call as a gated tool's does. A child gets its caller's consent step pinned to the turn's app, so its consent request pauses the turn with the agent path and the next message after the grant resumes the child's paused call.

**Instead of:** asking for every subagent's grants before the turn, binding the flow to the child's app, resuming the child from the callback, copying the request into the caller's session, pinning in the turn runner, an opt-in key for delegated scripts
**Superseded by:** [ADR 0119](/decisions/0119-workflow-routes-and-nodes-pause-the-turn.md) (lifts the refusal kept for nested workflows as a route or node)
**Open:** a remote (`a2a_agent_url`) subagent's own input-required pause (still answered as text)

How it works: [Native loop](/overview/native-loop.md)
