---
type: decision
title: "ADR 0079: A question resumes on the native loop through its history, with no request processor, as on ADK"
description: "An answered ask_user call resumes on the native loop the way it resumes on ADK: the turn runner stores the person's next plain-text message as the call's function response, and the first step's history puts the call and the answer side by side. ADK's request-input processor re-runs only node tools paused on adk_request_input and does nothing for an agent with none, so no port of it joins the loop until workflows run natively. runSyndicateTurn no longer refuses a question's answer on native. Porting the processor now, and a loop hook that writes or re-runs the answer, were rejected."
tags:
  - decision
  - runtime
status: stable
generated:
  by: claude-code/claude-opus-5-5
  at: 2026-10-08
sources:
  - resource: lib/runtime/questions.ts
  - resource: lib/runtime/syndicateTurn.ts
  - resource: lib/runtime/native/interrupts.ts
  - resource: lib/runtime/native/agentLoop.ts
  - resource: lib/runtime/native/history.ts
  - resource: tests/questions.test.ts
  - resource: tests/questionsA2a.test.ts
  - resource: tests/nativeQuestions.test.ts
  - resource: tests/nativeTurn.test.ts
---

# ADR 0079: A question resumes on the native loop through its history, with no request processor, as on ADK

## Context

`ask_user` ([ADR 0031](/decisions/0031-ask-user.md)) is a long-running tool. The call is stored, the run ends with no response to it, and the turn ends `input-required` with `result.input`. While the call is open, `runSyndicateTurn` rewrites the person's next plain-text message into the call's function response (`questionAnswerPart`), and runs the agent that asked. In plan-dispatch, that is the route, with its interrupted turn replayed raw.

The native loop ([ADR 0071](/decisions/0071-native-loop-runs-calls-as-adk-stores-them.md)) already paused on the call as ADK does. [ADR 0073](/decisions/0073-one-agent-spec-and-a-runtime-flag.md) had `runSyndicateTurn` refuse the answer on native. [ADR 0077](/decisions/0077-native-approvals-port-the-confirmation-processor.md) expected the resume to be a port of ADK's request-input processor (`REQUEST_INPUT_LLM_REQUEST_PROCESSOR`), placed beside the approval resume.

Reading that processor in `@google/adk` 2.2 shows what it does:

- It collects the answers to `adk_request_input` calls, a workflow's interrupts.
- It finds the calls to node tools (a workflow run as a tool) that have no response.
- It re-runs those node tools with the answers.

For an agent that lists no node tool, it returns before running anything. Without a response schema, which only an `adk_request_input` call declares, it cannot throw. An `ask_user` call is neither of those. On ADK, the answer reaches the model through the content processor: the answer is moved next to its call in the history, and the model reads it as the call's result.

## Decision

1. **No request processor for a question.** The native loop resumes an answered `ask_user` call the way ADK does. The turn runner stores the answer as the user event's function response. The first step's history (`lib/runtime/native/history.ts`, the content processor's port) puts the call and the answer side by side. The model continues the agent's tool loop from there. Nothing in `agentLoop.ts` changes beyond its comments.
2. **The refusal is lifted.** `runSyndicateTurn` answers a question on `native` as on `adk`. The question still has to be open, the message plain text, and the syndicate not a workflow. The dispatch resume (`turnStartOfCall`) is shared.
3. **The processor's place is kept for workflows.** `interrupts.ts` and `agentLoop.ts` record where ADK runs it: after request-confirmation and before compaction. A port belongs there when node tools run on the native loop (WS4).

## Alternatives considered

- **Port the processor now, in full.** It would follow the plan's letter. But the port would need a node-tool kind, which no native agent has, since native refuses workflows. Every session native can run would return at the processor's first check. The code could not be exercised, and it would put a second hook into `agentLoop.ts` while WS3-5 is changing the same function.
- **A hook that writes the answer into the history, or re-runs `ask_user` with it.** This would make the loop aware of questions. But on ADK the answer is the stored user event, not something a processor writes. A second copy of the answer, or a call to the tool, would store events ADK does not, and a session would then read differently on each runtime ([ADR 0045](/decisions/0045-own-runtime-behind-the-seam.md)).

## Consequences

- `tests/questions.test.ts` runs each conversation on ADK, on native, and with the runtime switched at each turn in both directions, and requires the same results, the same stored events and the same model calls. The conversations are: ask, then answer, then a further message; a question asked in parallel with another call; and a question inside a dispatch route.
- `tests/questionsA2a.test.ts` runs the A2A conversation the same four ways. The task, its `input_request` data part and the stored events are the same on each.
- `tests/nativeQuestions.test.ts` runs the conversation directly on `runAgentLoop`: paused, then final, with the stored events equal to ADK's. It also answers the question ADK stored in session fixture 04, on the loop and through `runSyndicateTurn` on native. The resumed step sends the request ADK sends, and stores what ADK stores.
- `tests/nativeTurn.test.ts` runs a question and its answer through `runSyndicateTurn` on both runtimes, where it used to require the refusal.
- The A2A surface, the stored Event JSON and the interrupt names are unchanged.
