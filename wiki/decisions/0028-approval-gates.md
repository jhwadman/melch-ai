---
type: decision
title: "ADR 0028: A tool can require a person's approval, per agent, through input-required"
description: "An agent lists in require_approval the tools that run only after a person approves the exact call; the turn pauses and the A2A task ends input-required until the caller approves or rejects."
tags:
  - decision
  - protocols
  - tools
status: stable
generated:
  by: claude-code/claude-opus-5-5
  at: 2026-10-18
sources:
  - resource: lib/compile.ts
  - resource: lib/runtime/syndicateTurn.ts
  - resource: lib/a2a/executor.ts
  - resource: lib/session/transcript.ts
  - resource: lib/syndicateSchema.ts
---

# ADR 0028: A tool can require a person's approval, per agent, through input-required

**Decided (2026-10-02):** A tool runs only after a person approves the exact call when the deployment's YAML lists it in an agent's `require_approval`. Nothing is gated by default. The turn pauses on a confirmation pinned to the call and its arguments, and the A2A task ends `input-required` until the caller approves or rejects on the same conversation.

**Instead of:** a gate in the policy plug point, the tool author as the only switch
**Superseded by:** [ADR 0077](/decisions/0077-native-approvals-port-the-confirmation-processor.md) (the native loop raises and resumes the gate, not ADK's), [ADR 0041](/decisions/0041-tool-vendors-get-least-privilege.md) (MCP tools can be gated), [ADR 0110](/decisions/0110-pauses-inside-delegated-subagents-reach-the-turn.md) (gates inside delegated subagents pause the turn), [ADR 0098](/decisions/0098-workflow-subagent-and-node-approvals.md) (gates on workflow node agents)
**Open:** a default approval flag on the tool contract

How it works: [A2A](/protocols/a2a.md)
