---
type: decision
title: "ADR 0155: Every tool call is answered: an approval pause stores the batch's other answers, and a request answers what the history left open"
description: "When a step's calls include a gated one, the loop stores the other calls' answers as their own event before the approval request (answeredBesideGates), where ADK stored none; the request builder gives any call the history leaves unanswered an error result (answerEveryCall), since Anthropic and OpenAI refuse a request with an unanswered call and every later request replays it."
tags:
  - decision
  - runtime
  - approvals
status: stable
generated:
  by: claude-code/claude-opus-5-5
  at: 2026-11-06
sources:
  - resource: lib/runtime/native/agentLoop.ts
  - resource: lib/runtime/native/request.ts
  - resource: tests/approvals.test.ts
  - resource: tests/nativeApprovals.test.ts
  - resource: tests/answerEveryCall.test.ts
---

# ADR 0155: Every tool call is answered: an approval pause stores the batch's other answers, and a request answers what the history left open

**Decided (2026-11-06):** A step whose calls included a gated one stored the approval request in place of the whole batch's response, as ADK 2.2 did. The calls beside the gated one had run, but their answers were never stored, so after the approval the history held the step's calls with only the pinned call answered. Gemini takes that; Anthropic refuses it (`tool_use ids were found without tool_result blocks immediately after`), and since every later request replays the same history, the conversation could not go on. Now the loop stores the batch's other answers first, as their own event without actions (`answeredBesideGates` in `lib/runtime/native/agentLoop.ts`): the gated calls' stand-ins are left out, and the actions stay on the approval request as before, so no state change is applied twice. History projection already merges answers stored apart and moves them next to their calls. The parity case `parallel-batch` in `tests/nativeApprovals.test.ts` sets that one event aside before comparing with ADK's store.

Separately, `buildModelRequest` passes the messages through `answerEveryCall` (`lib/runtime/native/request.ts`): an assistant message's tool calls are answered in the message right after it, as the contract's ToolMessage holds them, and a call with no result gets an error result saying it never answered. That covers a gated call the person moved on from by typing a new message, a run that ended between a call and its answer, and sessions stored before this change.

**Instead of:** keeping ADK's store and repairing only at the request (the calls beside the gate ran; their real answers belong in the history, not a stand-in); repairing in the Anthropic adapter alone (OpenAI has the same rule, and the contract already says a ToolMessage answers each call); dropping unanswered calls from the request (the model would lose that it asked for them).

How it works: [Native loop](/overview/native-loop.md), [Model contract](/models/model-contract.md). Approvals: [ADR 0028](/decisions/0028-approval-gates.md).
