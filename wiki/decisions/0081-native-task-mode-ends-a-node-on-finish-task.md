---
type: decision
title: "ADR 0081: Task mode on the native loop is finish_task as an own tool and a task-node hook that ends the run on its answer"
description: "mode: task runs on the native runtime as ADK 2.2 runs it. lib/runtime/native/taskMode.ts holds ADK's FinishTaskTool as an own Tool (its declaration, instruction line, missing-key error and success answer word for word, its OBJECT-only unwrapping kept), which the request declares after the agent's tools; and taskNodeRun, the loop's taskNode hook, which marks finish_task's successful answer as the node's output, outputKey and messageAsOutput and ends the run, as ADK's runTaskMode does. A plain run goes on after the answer, as LlmAgent.runAsync does. code_execution: gemini already ran on native and is now held by parity tests. Leaving the node's end to the workflow runner, ending every task-mode run on finish_task, and normalizing a lowercase schema were rejected."
tags:
  - decision
  - runtime
  - agents
status: stable
generated:
  by: claude-code/claude-opus-5-5
  at: 2026-10-08
sources:
  - resource: lib/runtime/native/taskMode.ts
  - resource: lib/runtime/native/agentLoop.ts
  - resource: lib/runtime/native/request.ts
  - resource: lib/compileNative.ts
  - resource: tests/execution.test.ts
---

# ADR 0081: Task mode on the native loop is finish_task as an own tool and a task-node hook that ends the run on its answer

## Context

[ADR 0033](/decisions/0033-context-task-code.md) made `mode: task` and `code_execution: gemini` agent keys, compiled into ADK's `LlmAgent`. The native runtime ([ADR 0073](/decisions/0073-one-agent-spec-and-a-runtime-flag.md)) refused `mode: task` at compile time. Code execution already reached the native request: `code_execution` among Gemini's own tools, and raw code parts in the history read as ADK's code-execution processor reads them ([ADR 0066](/decisions/0066-native-step-sends-the-adk-request.md)).

In ADK 2.2 task mode is spread over three places: `LlmAgent` adds a `FinishTaskTool` after its own tools and never sets the output schema as the response schema; the tool declares the output schema as its parameters, appends a line to the instruction and answers `Task completed.` or an error naming missing keys; and `runTaskMode`, which runs a task-mode agent as a workflow node, ends the node on the successful answer with the arguments as the node's output. Outside a workflow, `LlmAgent.runAsync` keeps stepping after the answer. The schema allows `mode: task` on workflow nodes only, and workflows are refused on native until WS4.

## Decision

1. **finish_task is an own Tool** (`lib/runtime/native/taskMode.ts`, `finishTaskTool`), which `buildModelRequest` declares after the agent's tools and before the caller's extra tools (self-correction's reflection tool), in `set_model_response`'s place. Every text is ADK's word for word. ADK's quirks are kept: a schema whose `type` is not Gemini's `OBJECT` is wrapped under `result`, a lowercase `object` included, and only top-level `required` keys are checked. The `set_model_response` instruction line is still written where ADK's instruction processor writes it.
2. **A node's end is a loop hook.** `AgentLoopContext.taskNode` marks a run as a task-mode node's. `taskNodeRun` sees each event before it is stored: it holds the latest `finish_task` call's arguments, and on the answer that reports success it sets `output`, `nodeInfo.messageAsOutput` and the `outputKey` state write on that event. The loop then returns `final` with `output`. The change to `agentLoop.ts` is that hook and one return.
3. **A plain run goes on** after `finish_task`'s answer, as `LlmAgent.runAsync` does.
4. **The refusal is lifted** in `compileNative`; a workflow syndicate stays refused by `refuseOnNative` until the workflow engine, whose node runner sets `taskNode` and adds the node's own path.

`tests/execution.test.ts` holds both keys under both runtimes: the same results, stored events and model requests, and a task node's events equal to the ones ADK's workflow stores, the node path aside.

## Alternatives considered

- **Leave the node's end to the workflow runner (WS4).** Rejected: the end is decided per event inside the loop (the arguments come from one event, the output is written onto another before it is stored), and the native loop stores its own events, so a runner outside it could not write the output onto the event before the store sees it.
- **End every task-mode run on finish_task.** Rejected: a plain ADK run does not, and a session either runtime wrote must be one the other continues.
- **Normalize a lowercase `object` schema so it is not wrapped.** Rejected for parity: ADK wraps it, and the model would be sent a different declaration on each runtime.

## Consequences

- `mode: task` runs wherever native runs an agent; the ADR 0033 workflow case reaches native with the workflow engine.
- `AgentLoopEnd` carries `output` for a task node's run.
- A later ADK release that changes FinishTaskTool's texts or unwrapping shows up as a parity failure in `tests/execution.test.ts`.
