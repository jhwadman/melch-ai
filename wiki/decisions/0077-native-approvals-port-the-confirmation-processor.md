---
type: decision
title: "ADR 0077: The native loop resumes an approval before every step, as ADK's request-confirmation processor does, and throws a refusal"
description: "An answered approval on the native loop runs in lib/runtime/native/interrupts.ts, a port of ADK's request-confirmation processor: before every model step, the adk_request_confirmation answers in the latest user event are bound to the pinned calls by id, name and arguments, the bound calls run through the loop's own call path with the answer in their context, and their response is stored before the request is built. An answer that does not bind throws ADK's IntentMismatchError text and stores nothing. Resuming once at the start of the run, resuming in the turn runner, and storing a refusal as an error event were rejected."
tags:
  - decision
  - runtime
  - security
status: stable
generated:
  by: claude-code/claude-opus-5-5
  at: 2026-10-08
sources:
  - resource: lib/runtime/native/interrupts.ts
  - resource: lib/runtime/native/agentLoop.ts
  - resource: lib/runtime/approvals.ts
  - resource: tests/nativeApprovals.test.ts
  - resource: tests/nativeTurn.test.ts
  - resource: lib/runtime/syndicateTurn.ts
---

# ADR 0077: The native loop resumes an approval before every step, as ADK's request-confirmation processor does, and throws a refusal

## Context

An approval gate ([ADR 0028](/decisions/0028-approval-gates.md)) stops a call to a tool in `require_approval`. ADK stores an `adk_request_confirmation` call that pins the original call and its arguments, and the turn ends. The person's answer is the next user message, a function response to that call carrying `{ confirmed }`. On the ADK runtime, `LlmAgent`'s request-confirmation processor reads that answer before each model step. It checks that the answer binds to a call the agent made, runs the pinned call with the confirmation, and stores the response before the content processor builds the request. An answer that does not bind throws `IntentMismatchError`, and the turn fails before any model call.

The native loop ([ADR 0071](/decisions/0071-native-loop-runs-calls-as-adk-stores-them.md)) already stored the request and paused. It could not resume. A session either runtime wrote must be one the other continues ([ADR 0045](/decisions/0045-own-runtime-behind-the-seam.md)), so an approval ADK opened in production must resume on the loop and run the pinned call once.

## Decision

1. **A port of the processor, in its own file.** `lib/runtime/native/interrupts.ts` (`approvedCalls`) does what the processor does, check for check:
   - it reads the answers from the latest user event;
   - it finds the gates they name (a request authored by the user is refused; one authored by another agent is skipped; a pinned call the agent already answered is skipped);
   - it binds each pinned call to the call the agent made by id, tool, name and arguments (deep equality);
   - it requires the tool to gate the call, or to have asked for confirmation.

   The refusal reasons and the error's text are ADK's.
2. **A small hook in the loop, before every step.** `agentLoop.ts` calls `resumeApprovals` at the top of each step, outside the `model.call` span. The bound calls run through `runCalls`, the path every call takes, with the answer in the call's context. So self-correction, the `tool.execute` span and the response shape are the same as for any call. The response is stored and yielded before the step builds its request.
3. **A refusal throws.** An answer that does not bind throws `IntentMismatchError`, with ADK's text, out of the loop. Nothing runs and nothing is stored after the user's message, as on ADK.

## Alternatives considered

- **Resume once, at the start of the run.** Simpler, and the same events in every case the suites cover. But ADK checks at every step, and the "already answered" rule is what keeps a later step from running the call again. Checking every step keeps the two runtimes equal in cases nobody has thought of, such as an answer that a step's own events complete. It costs a scan of the latest user event per step.
- **Resume in the turn runner (`runSyndicateTurn`).** This would keep the loop unaware of approvals. But on ADK the resume belongs to the agent's run: its spans, its self-correction counters and its tools. A turn runner that ran tools would duplicate the loop's call path.
- **Store a refusal as an error event, or end the run with `error`.** A friendlier surface, but ADK stores nothing and throws. A refusal is a security check on the pinned call ([ADR 0028](/decisions/0028-approval-gates.md)), and the boundary suite reads it the same way on both runtimes. A surface that wants a friendlier failure catches it in the turn runner, for both runtimes at once.

## Consequences

- `tests/nativeApprovals.test.ts` runs the approval conversations both ways: approve, refuse, an answer as JSON under `response`, changed pinned arguments, a parallel batch with one gated call, and a confirmed call that throws (a first failure for self-correction). The stores hold the same events. On the loop alone, it covers the confirmed call's tool span, an answer naming no open request, and a request the user authored. Session fixture 03, an approval ADK opened, resumes on the loop, runs the pinned call once, and stores what ADK stores.
- `runSyndicateTurn` on `runtime: 'native'` resumes an approval, which [ADR 0073](/decisions/0073-one-agent-spec-and-a-runtime-flag.md) refused until now; answering a question stays refused until WS2-7b. The turn runner's own checks are unchanged on both runtimes: an answer naming no open request fails `NO_PENDING_APPROVAL`, and a dispatch turn replays the interrupted turn raw (`interruptedTurnStart`) to the route that asked. `tests/nativeTurn.test.ts` runs approve, refuse and a dispatch resume through `runSyndicateTurn` on both runtimes, and an approval opened on each runtime resumed on the other.
- `isDeepStrictEqual` stands in for lodash's `isEqual`. The two agree on the JSON values stored arguments hold.
- ADK's plain-text answers (`plainTextToolConfirmation`) and its refusal of answers a remote peer delivered (`remoteDelivered`) are not ported: no surface turns either on.
- Resuming `ask_user` is WS2-7b. It follows the same pattern: a port of ADK's input-request processor beside this one in `interrupts.ts`.
