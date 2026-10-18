---
type: decision
title: "ADR 0110: A pause inside a delegated subagent reaches the turn through the open call"
description: "An approval or ask_user pause inside a delegated subagent leaves the caller's call open, the turn finds it by walking down the open calls and reports it with the agent path, and the answer travels back down before the caller's next step."
tags:
  - decision
  - runtime
  - protocols
  - security
status: stable
generated:
  by: claude-code/claude-opus-5-5
  at: 2026-10-18
sources:
  - resource: lib/runtime/native/delegate.ts
  - resource: lib/runtime/native/interrupts.ts
  - resource: lib/runtime/native/agentLoop.ts
  - resource: lib/runtime/syndicateTurn.ts
  - resource: lib/a2a/executor.ts
  - resource: lib/runtime/approvals.ts
  - resource: lib/workflowConfig.ts
  - resource: lib/syndicateSchema.ts
  - resource: lib/compile.ts
  - resource: tests/delegatedPauses.test.ts
  - resource: tests/nativeDelegate.test.ts
  - resource: tests/sessionFixtures.test.ts
---

# ADR 0110: A pause inside a delegated subagent reaches the turn through the open call

**Decided (2026-10-09):** A paused child run leaves its call open and pauses the caller; the turn finds the pause by walking down open calls into child sessions and reports it with a `path`; the answer is stored in the conversation as usual and handed down the open call before the caller's next step. Stored events and interrupt names do not change.

**Instead of:** copying the request into the caller's session, a pause marker event, keeping the pause swallowed, answering the child directly from the turn runner
**Supersedes:** [ADR 0074](/decisions/0074-native-delegation-runs-a-child-loop-as-agent-tool-does.md) (a paused child answered the call ''), [ADR 0028](/decisions/0028-approval-gates.md) (gates only where a pause reaches the caller)
**Superseded by:** [ADR 0111](/decisions/0111-pauses-inside-nested-syndicates.md) (nested syndicates; child session key), [ADR 0118](/decisions/0118-skill-scripts-and-oauth-consent-inside-delegated-subagents.md) (skill scripts and OAuth consent in subagents)
**Open:** a remote (A2A) subagent's own input-required does not reach the turn

How it works: [Native loop: a pause inside a subagent](/overview/native-loop.md#a-pause-inside-a-subagent)
