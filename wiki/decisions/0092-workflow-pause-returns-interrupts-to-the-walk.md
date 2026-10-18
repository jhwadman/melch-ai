---
type: decision
title: "ADR 0092: A workflow ask_user node returns its interrupt to the walk"
description: "An ask_user node writes ADK's adk_request_input event and returns its interrupt id in the run result; the scheduler holds the node waiting and the caller stores the workflow's pause record."
tags:
  - decision
  - runtime
  - agents
status: stable
generated:
  by: claude-code/claude-opus-5-5
  at: 2026-10-18
sources:
  - resource: lib/workflow/pause.ts
  - resource: lib/workflow/scheduler.ts
  - resource: lib/workflowConfig.ts
  - resource: tests/workflowPause.test.ts
---

# ADR 0092: A workflow ask_user node returns its interrupt to the walk

**Decided (2026-10-08):** `lib/workflow/pause.ts` writes ADK's `adk_request_input` event key for key (random interrupt id, schema through a port of `genaiSchemaToJsonSchema`) and returns the id in `NodeResult.interruptIds`. The scheduler holds the node waiting while the rest of the graph runs, and the caller stores the workflow's `recordInputForResume` event after the walk.

**Instead of:** throwing an interrupt error, a sentinel output, a deterministic interrupt id, the scheduler writing events, writing the YAML schema as given

**Superseded by:** [ADR 0094](/decisions/0094-workflow-resume-rebuilds-node-states-from-the-events.md) (the resume), [ADR 0098](/decisions/0098-workflow-subagent-and-node-approvals.md) (approval pauses in an agent node)

**Open:** a map item's interrupts are not carried

How it works: [Workflow scheduler](/overview/workflow-scheduler.md)
