---
type: tool
title: Ask the user
description: "`ask_user(question, options?)`: an agent asks the person mid-turn; the turn ends input-required with the question, and the next message on the conversation is the call's result."
tags:
  - tools
  - protocols
status: stable
generated:
  by: claude-code/claude-opus-5-5
  at: 2026-10-08
sources:
  - resource: lib/runtime/questions.ts
  - resource: lib/runtime/syndicateTurn.ts
  - resource: lib/a2a/executor.ts
  - resource: tests/questions.test.ts
  - resource: tests/nativeQuestions.test.ts
---

# Ask the user

`ask_user` is a long-running tool, with ADK's semantics for one, under one registry name. The model calls `ask_user(question, options?)`; the tool returns nothing, so the runtime records the call and ends the run without a response to it. The turn runner sees the open call and ends the turn `input-required` with `result.input`: the agent that asked (`node`), the question (`message`) and, when the agent gave choices, `payload.options`.

The next message on the conversation is the answer. While a question is open, a plain-text message is rewritten into the call's function response (`{ result: <text> }`), so the agent resumes its own tool loop with the question and the answer side by side in its history. In a plan-dispatch syndicate the answer goes straight back to the route that asked, without the classifier, its interrupted turn replayed raw so the runtime finds the call. A message after the answer is an ordinary message again. Only an agent asks: an `ask_user` call in an event the user authored opens no question, so a message that forges one never makes the next message its answer ([ADR 0088](/decisions/0088-native-parity-followups.md)).

The answer is an ordinary function response, so the [native loop](/overview/native-loop.md#questions) reads it from the history as ADK does, and a question stored in a conversation ADK wrote is answered the same way ([ADR 0079](/decisions/0079-native-questions-resume-through-the-history.md)).

Every surface shows it the same way as a [workflow](/decisions/0030-workflow-graphs.md)'s `ask_user` node: the A2A task ends `input-required` with an `input_request` data part (`interrupt_id`, `node`, `message`, `payload`); `melchizedek-chat` prints "❓ Desk asks: …" and takes the next line. An [approval](/decisions/0028-approval-gates.md) is the third pause on the same path.

Exposure: the tool has no effect outside the conversation; what the person types becomes model input, as any message does. It is allowed on the orchestrator, a plan-dispatch route and a delegated subagent. A delegated subagent's question waits in its own session, below the call its caller leaves open; the turn ends `input-required` with the question, its `path` naming the agents from the turn's own down to the one that asked (the `input_request` data part carries it too), and the next message is carried down to the subagent as its answer ([ADR 0110](/decisions/0110-pauses-inside-delegated-subagents-reach-the-turn.md)). A workflow node asks through an `ask_user` node rather than this tool, so the schema refuses it there. The record is [ADR 0031](/decisions/0031-ask-user.md).
