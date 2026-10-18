---
type: decision
title: "ADR 0094: A paused workflow resumes by rebuilding node states from the stored events"
description: "A paused workflow resumes by walking again from START and rebuilding every node's state from the stored events, as ADK's rehydration did, with no walk state kept between turns."
tags:
  - decision
  - runtime
  - agents
status: stable
generated:
  by: claude-code/claude-opus-5-5
  at: 2026-10-18
sources:
  - resource: lib/workflow/resume.ts
  - resource: lib/workflow/scheduler.ts
  - resource: lib/workflow/pause.ts
  - resource: lib/runtime/questions.ts
  - resource: tests/workflowResume.test.ts
---

# ADR 0094: A paused workflow resumes by rebuilding node states from the stored events

**Decided (2026-10-08):** A paused walk resumes by walking the graph again from START and rebuilding each node's state from the session's events (`lib/workflow/resume.ts`, a port of ADK's rehydration): finished nodes complete from their stored output, the paused node reruns with the answer. Nothing is kept between turns, and every ask_user node in a resumed walk sees every answer, as on ADK.

**Instead of:** walk state kept between turns, resuming from the paused node, reading only the newest message, rerunning a nested pause from its input, giving each ask_user node only its own answer
**Superseded by:** [ADR 0098](/decisions/0098-workflow-subagent-and-node-approvals.md) (approval pauses inside an agent node now resume), [ADR 0128](/decisions/0128-oauth-consent-inside-workflow-nodes.md) (OAuth consent pauses inside a node now resume)
**Open:** a pause inside a map item (refused by name)

How it works: [Workflow scheduler](/overview/workflow-scheduler.md)
