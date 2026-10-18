---
type: decision
title: "ADR 0081: Native task mode: finish_task as an own tool, ending a node on its answer"
description: "mode: task runs on the native loop with finish_task as an own tool and a taskNode hook that ends a workflow node's run on its successful answer."
tags:
  - decision
  - runtime
  - agents
status: stable
generated:
  by: claude-code/claude-opus-5-5
  at: 2026-10-18
sources:
  - resource: lib/runtime/native/taskMode.ts
  - resource: lib/runtime/native/agentLoop.ts
  - resource: lib/runtime/native/request.ts
  - resource: lib/compileNative.ts
  - resource: tests/execution.test.ts
---

# ADR 0081: Native task mode: finish_task as an own tool, ending a node on its answer

**Decided (2026-10-08):** `finish_task` is an own Tool (ADK's texts and quirks kept, a non-`OBJECT` schema wrapped under `result`), declared after the agent's tools. A loop hook (`taskNode`) writes the node's output onto the answering event before it is stored and ends the run; a plain run goes on after the answer.

**Instead of:** leaving the node's end to the workflow runner, ending every task-mode run on finish_task, normalizing a lowercase schema

How it works: [Native loop](/overview/native-loop.md)
