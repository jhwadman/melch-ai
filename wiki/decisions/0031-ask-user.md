---
type: decision
title: 'ADR 0031: An agent asks the person through `ask_user`, a long-running tool on the input-required path'
description: A registry tool, `ask_user(question, options?)`, built on ADK's long-running tool mechanism, ends the turn input-required with the question; the next plain-text message becomes the call's result and the agent that asked resumes. It shares the A2A `input_request` data part with a workflow's ask_user node, and is allowed only where an approval gate is.
tags:
  - decision
  - tools
  - protocols
status: stable
generated:
  by: claude-code/claude-opus-5-5
  at: 2026-10-02
sources:
  - resource: lib/runtime/questions.ts
  - resource: lib/runtime/syndicateTurn.ts
  - resource: lib/syndicateSchema.ts
  - resource: tests/questions.test.ts
  - resource: tests/questionsA2a.test.ts
---

# ADR 0031: An agent asks the person through `ask_user`

## Context

A syndicate put in front of users has to ask: which account, what order number, which of these three drafts. Before this, an agent could only end its turn with a question in its text; nothing in the session said a question was open, so the next message reached the agent as a fresh request, and a plan-dispatch syndicate re-classified the answer ("A-1042") as if it were a new topic. The owner's audit of ADK listed human-in-the-loop input second, behind workflows.

ADK 2.2 ships `requestInputTool` and `getUserChoiceTool`, both `LongRunningFunctionTool`s whose execute returns nothing. Run through the Runner, a long-running call with no result ends the run with the call open; a later message carrying a function response with the call's id resumes the agent's tool loop. That was verified with a scripted model before this design.

## Decision

1. **One tool, `ask_user(question, options?)`,** registered by name like any other. Not ADK's two: `adk_request_input` is a framework name the workflow interrupt already uses, and a choice is a question with options, so one tool with an optional list is one less thing to learn.
2. **The turn ends `input-required` with `result.input`,** the same field a workflow's `ask_user` node fills, and the A2A executor publishes the same `input_request` data part. A client handles a tool question and a node question identically; an approval is the third pause on the path.
3. **The next plain-text message is the answer.** While a question is open, the turn runner rewrites the message into the call's function response (`{ result: <text> }`). No special reply format is required of a client or a person, which is the point of the feature.
4. **A dispatch answer resumes the route that asked,** without the classifier, its interrupted turn replayed raw so ADK finds the call — the approvals mechanism, generalized to any open call (`turnStartOfCall`).
5. **Allowed where an approval gate is:** the orchestrator and plan-dispatch routes. A delegated subagent runs inside a tool call, where ADK swallows the pause; a workflow node's pauses are ADK's interrupts, whose resume differs. The schema refuses both.

> **Note (2026-10-08):** Since 0.20.0 the native runtime is the default ([ADR 0102](/decisions/0102-native-default-and-optional-adk-peer.md)): its own loop resumes an open question through the history ([ADR 0079](/decisions/0079-native-questions-resume-through-the-history.md)), where item 4 has ADK find the call. ADK does so only on the optional adk runtime, which 1.0.0 removes ([ADR 0045](/decisions/0045-own-runtime-behind-the-seam.md)). The tool name `ask_user` and the A2A surface are unchanged.

## Alternatives considered

- **ADK's `requestInputTool` and `getUserChoiceTool` as they ship.** Two names, one of them framework-internal; rejected for the reasons in 1.
- **A structured reply** (a data part naming the question id). Kept possible but not required: a person in a chat window can only type, and a typed answer must work.
- **Treat any message as an answer only if it "looks like" one.** Rejected: the open call is the fact; heuristics about what an answer looks like would misroute short replies.

## Consequences

- While a question is open, a person who changes the subject still answers it; the agent sees the mismatch and can ask again or move on. This is the same contract a person has with a human asking them something.
- `tests/questions.test.ts` (delegate, dispatch, schema) and `tests/questionsA2a.test.ts` (the data part and the resume over the wire) are the boundary suite.
- Open: `ask_user` on a workflow node (the agent's long-running call would become a node interrupt), and answering a question from a delegated subagent.
