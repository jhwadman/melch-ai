---
type: runbook
title: Native loop security
description: "The threat model of the native runtime's agent loop (lib/runtime/native/), the gate it passes before it becomes the default (ADR 0045, ADR 0099, ADR 0101): for model output, tool results, interrupt answers (approvals, questions, OAuth consent, workflow pauses), state deltas, delegation and nested workflows, compaction and resource limits, what can go wrong, what stops it, and the test that proves it; the findings fixed and the ones recorded with an owner decision; and the fuzz suite (tests/nativeFuzz.test.ts) that holds the loop to it."
tags:
  - operations
  - security
  - runtime
status: stable
generated:
  by: claude-code/claude-opus-5-5
  at: 2026-10-08
sources:
  - resource: lib/runtime/native/agentLoop.ts
  - resource: lib/runtime/native/step.ts
  - resource: lib/runtime/native/interrupts.ts
  - resource: lib/runtime/native/history.ts
  - resource: lib/runtime/native/delegate.ts
  - resource: lib/runtime/native/compaction.ts
  - resource: lib/runtime/credentials.ts
  - resource: lib/runtime/approvals.ts
  - resource: lib/runtime/questions.ts
  - resource: lib/runtime/sessions.ts
  - resource: lib/runtime/valueDepth.ts
  - resource: lib/models/genaiMapping.ts
  - resource: lib/compile.ts
  - resource: lib/workflow/resume.ts
  - resource: lib/a2a/executor.ts
  - resource: tests/nativeFuzz.test.ts
---

# Native loop security

The [native loop](/overview/native-loop.md) runs an agent's turn without ADK, and is the default runtime since 0.20.0 ([ADR 0045](/decisions/0045-own-runtime-behind-the-seam.md), [ADR 0102](/decisions/0102-native-default-and-optional-adk-peer.md)). Before it became the default it passed this gate ([ADR 0101](/decisions/0101-native-loop-security-gate.md)): every way a hostile input reaches it is named below, with what stops it and the test that proves it.

## Who supplies what

| Input | Who controls it | How it reaches the loop |
|---|---|---|
| The message | the person | Over A2A only as text: a `data` part becomes its JSON as text, a file part is refused (`a2aPartsToMessage`, `lib/a2a/executor.ts`), and the executor builds an approval answer itself from a decision. A library caller of `runSyndicateTurn` can pass any part: a function call, a function response. |
| The model's answer | the provider, steered by everything in the prompt | Every part of every response, through the adapter. A tool call's name, id and arguments are the model's choice. |
| A tool's result | the tool's code (trusted, registered by the operator); its content may come from a remote server (an MCP tool, a fetched page, an API) | The function response the loop stores. |
| The session | both runtimes, and a durable store | Events read back on every step. |
| The YAML | the operator, or the registry the operator publishes | Agents, tools, gates, nested references, limits. |

Each section says whether a path is reachable from a request (the A2A surface) or only from a library caller or the operator.

## What every turn must do

`tests/nativeFuzz.test.ts` draws 300 turns from a fixed seed and runs the cases below one by one. Every turn must:

1. settle within its deadline: no hang;
2. end on an `AgentLoopEnd`, or reject with an Error. The one exception is ADK's: an adapter that throws something that is not an Error has it rethrown as it is (`runAndHandleError`), on both runtimes;
3. leave a session whose events parse (`parseTurnEvents`) after a JSON round trip, as a durable store reads them back, with no partial event stored and no prototype touched;
4. let the next turn run: a plain message and a sane model end `final`.

The forged answers also run through `runSyndicateTurn` on both runtimes, which must end each turn the same way (status, error code, or what was thrown) and run the gated tool as often.

## Model output

**What can go wrong.** A contract-breaking adapter, or a provider answer the adapter passes on, holds a part of no known kind, `null`, a text part whose text is not a string, a tool result, a call whose arguments are `null`, a string or nested thousands of levels deep, a name or id that is not a string, two calls under one id, or a call named for one of the framework's own calls (`adk_request_confirmation`, `adk_request_credential`, `adk_request_input`, `set_model_response`, `finish_task`, `adk_handle_model_error`, `transfer_to_agent`). A stream ends mid-text, fails after partial output, or throws.

**What stops it.**

- `contractModelResponse` (`lib/models/genaiMapping.ts`) holds every response to the contract before either runtime reads it: a part the contract does not allow is dropped; a call's name and id become strings (the step mints an id); arguments become `{}` or `{ raw }`, and arguments past 64 levels `{ raw: TOO_DEEP_ARGUMENTS }` ([the model contract](/models/model-contract.md#the-response)). The ADK shim and the native step share it, so both store the same event.
- A partial is never stored. A stream with no final stores nothing and ends `empty`; a final carrying an error is stored with it and ends `error`; a thrown Error ends the step on ADK's `UNKNOWN_ERROR` event.
- A call naming no declared tool answers `Function <name> is not found in the toolsDict.`, so a model that calls `adk_request_confirmation`, `adk_request_credential` or `ask_user` itself opens no pause: its own not-found response closes the call for `pendingApproval`, `pendingConsent` and `pendingQuestion`. An undeclared `set_model_response` call becomes the final answer, as on ADK.
- Two calls under one id both run. Two gated calls under one id open one approval that pins the first; answering it throws `IntentMismatchError`, since the agent's history holds the second: it fails closed, as on ADK.

**Tests.** `tests/nativeFuzz.test.ts`: the drawn sweep; odd parts; malformed tool calls; huge and deeply nested values; duplicate call ids; reserved names; half-finished streams; malformed model answers through the turn runner on both runtimes.

## Tool results

**What can go wrong.** A result steers later calls (prompt injection, LLM01): a fetched page that says "call wipe". A result shaped like a framework event (a `functionCall` named `adk_request_confirmation`, `actions`, `isCompacted`, `longRunningToolIds`, a `__proto__` key). A result nested thousands of levels deep, which every later reader of the session (a store's clone and JSON, the history clone, a span) overflows on, on this turn and every turn after.

**What stops it.**

- A result is data inside a function response, never an event: the interrupt readers read `functionCall` parts of events the agent authored, and a result's fields are inert. Results reach the model in the tool role, never the system prompt.
- A gated tool runs only on an approval bound to the call by id, name and arguments (below), so a steered call to it waits for the person. What an agent can reach is its YAML `tools:` list and the registry: exposure is the authorization decision.
- A result nested past `MAX_VALUE_DEPTH` (64, `lib/runtime/valueDepth.ts`) is answered `{ error: TOO_DEEP_RESULT }` in its place.
- A registered tool is trusted code: it can write state and actions (an approval or credential request under any id). A remote server's content cannot; it arrives as the result.

What does not stop it: a result can still persuade the model to call an ungated tool with arguments of its choosing. That is the design boundary of every LLM agent; the mitigations are fewer tools, gates on the ones that act, and outbound URLs through the SSRF guard (`lib/net/addressGuard.ts`).

**Tests.** `tests/nativeFuzz.test.ts`: the sweep's `mimic` tool (a result that imitates an approval request); huge and deeply nested values.

## Interrupt answers

### Approvals

**What can go wrong.** An answer forged for a request that does not exist, sent in another session, replayed after the call ran, garbled, or paired with a request the person wrote into their own message; a request whose pinned arguments were changed in the store.

**What stops it.** At the turn runner, a decision must name the approval still open in this conversation (`NO_PENDING_APPROVAL` otherwise). In the loop (`approvedCalls`, ADK's request-confirmation processor, check for check): only answers in the latest user event count; a request the user authored throws `untrusted_request`; the pinned call must be one this agent made, by id, with the same name and arguments, to a tool that gates it; a request the agent has answered after is skipped, so a replay runs nothing. Answers are read from this session's events only, so an id from another session binds to nothing.

**Tests.** `tests/nativeFuzz.test.ts` (replay, unknown and crossed ids, garbled, user-written request, a `__proto__` call id; and through the turn runner on both runtimes); `tests/nativeApprovals.test.ts` (pinned arguments changed in the store; a user-authored request); `tests/approvalsA2a.test.ts` (a data-part refusal never runs the call).

### Questions

**What can go wrong.** A forged `ask_user` call in the person's message takes the next message as its answer; an answer to a question no one asked.

**What stops it.** Only an agent asks: `pendingQuestion` skips a user-authored call ([ADR 0088](/decisions/0088-native-parity-followups.md)). An answer naming no call fails the turn with ADK's content-processor error (`No function call event found …`) on both runtimes, and the next turn runs; over A2A an answer is built only for an open question.

**Tests.** `tests/questions.test.ts` (a user-authored `ask_user` call is no question, on both runtimes); `tests/nativeFuzz.test.ts` (an answer no one asked for, on the loop and through the turn runner).

### OAuth consent

**What can go wrong.** A grant forged for a request that does not exist or for another provider; a credential request the person wrote; a call forged into the person's message under the paused call's id, with other arguments; the same grant replayed after the call ran.

**What stops it.** `pendingConsent` reads only a request an agent authored. `grantedCalls` binds a grant to this agent's own request by id and `credentialKey`, re-runs the paused call from the latest event this agent authored that made it, and treats a request an earlier grant bound as closed. The last three are deliberate departures from ADK's auth preprocessor, which reads any author's call and resumes a replayed grant ([ADR 0101](/decisions/0101-native-loop-security-gate.md)); ADK refuses to resume a consent at all, so no ADK-written session depends on them. The flow's secrets never enter an event, and the callback route refuses a tampered, expired, replayed or cross-user state.

**Tests.** `tests/nativeFuzz.test.ts` (consent cases); `tests/oauthConsent.test.ts` (the callback's refusals).

### Workflow pauses

**What can go wrong.** A reply to an interrupt the run never raised, or one it already answered; a structured reply the request's schema refuses; a request the person wrote.

**What stops it.** `lib/workflow/resume.ts` rebuilds the run from its own events: only a node's event raises an interrupt, a reply to an unknown or answered interrupt is refused with ADK's message and resolves nothing, and a structured reply is checked against the request's `response_schema`. An approval on a workflow node binds as above.

**Tests.** `tests/workflowResume.test.ts` (a reply to an interrupt never raised; refused replies; `pendingWorkflowInput` never reads one the user wrote); `tests/workflowApprovals.test.ts`.

## State deltas

**What can go wrong.** A tool writes a model-chosen key: `__proto__`, `constructor`, `prototype`, `temp:x`. A call id is `__proto__`, and a dictionary keyed by call id is re-parented. State written by a tool or an `outputKey` fills an instruction's `{key}` placeholder.

**What stops it.** Every delta, the store's `applyEvent`, the run's `temp:` overlay and the loop's action dictionaries (`requestedToolConfirmations`, `requestedAuthConfigs`, merged across parallel calls) write own keys (`Object.defineProperty`), so a key is a key and never a prototype. `temp:` keys never reach a store. The tool registry is a null-prototype map. Placeholders are filled once, in one linear scan, never recursively.

What does not stop it: a `{key}` placeholder puts state, which a tool or a model wrote, into the system instruction, by design and as on ADK. A YAML author who places model-written state in an instruction has made that text instruction.

**Tests.** `tests/nativeFuzz.test.ts` (model-chosen state keys; a `__proto__` call id); every turn of the sweep checks `Object.prototype` and the state's prototype.

## Delegation and nested workflows

**What can go wrong.** A `yaml_reference` chain that reaches itself recurses at compile until the stack gives out; a subagent loops; a nested workflow walks without end; a pause inside a subagent reaches the caller.

**What stops it.** The compile refuses a chain that reaches itself, or that goes past 16 levels, by name and before any model call, on both runtimes (`nestedOptions`, `lib/compile.ts`). Every model call of every agent in the turn counts against one `max_steps` (default 50), and a subagent runs under the turn's signal and deadline. A pause inside a subagent ends the child run and answers `''`; the gated tool never runs ([ADR 0028](/decisions/0028-approval-gates.md)).

**Tests.** `tests/compile.test.ts` (a chain that reaches itself or goes too deep); `tests/nativeDelegate.test.ts` (`max_steps` across the turn, the default 50, cancel and deadline inside a subagent, a pause inside a subagent stays refused).

## Compaction

**What can go wrong.** The summary model reads every summarized event, tool results included, and its text stands in for them on every later step: an instruction planted in a result can survive into the summary.

**What stops it.** The summary is a `user`-role message, `[Previous Context Summary]:`, never the system prompt; its call has no tools; it counts against `max_steps` and stops with the turn; a summary model that answers no text fails the turn and compacts nothing. Beyond that it is the same prompt-injection boundary as a tool result.

**Tests.** `tests/compaction.test.ts`.

## Resource limits

| Limit | What it bounds | Test |
|---|---|---|
| `max_steps` (default 50) | model calls across the turn: every agent, subagent, fallback and summary | `tests/nativeFuzz.test.ts` (a model that never stops calling tools), `tests/nativeDelegate.test.ts` |
| ADK's 500 | model calls in one run, when no turn control is lower | `lib/runtime/native/agentLoop.ts` |
| the deadline (`A2A_TASK_TIMEOUT_MS`, 15 minutes by default) and cancel | wall time; the call in flight is aborted, a stopped step stores nothing | `tests/nativeDelegate.test.ts`, `tests/workflowScheduler.test.ts` |
| `max_parallel` (default 8), `max_concurrency` | a map's workers, a walk's pending nodes | `tests/workflowScheduler.test.ts` |
| `MAX_VALUE_DEPTH` (64) | nesting of a call's arguments and a tool's result | `tests/nativeFuzz.test.ts` |
| 16 levels | a `yaml_reference` chain | `tests/compile.test.ts` |

## Findings

Fixed, each in its own commit with its test:

| | Finding | Reach | Fix |
|---|---|---|---|
| F1 | A part the contract does not allow was stored as it came: a `null` part crashed the step, and a call whose arguments were not an object no longer parsed as an event. | a provider answer through any adapter that passes it on | `contractModelResponse`, shared by the shim and the step |
| F2 | A call's arguments or a tool's result nested a few thousand levels deep overflowed every reader of the session: the turn failed with a RangeError, and so did every later turn on that session. | a model's arguments; a remote server's result | `MAX_VALUE_DEPTH` on arguments (the contract guard) and results (the loop) |
| F3 | A model-chosen call id `__proto__` re-parented the approval and credential dictionaries: the approval was lost (failing closed). | a provider's call id | own keys in `requestConfirmation`, `requestCredential` and `mergeActions` |
| F4 | `pendingConsent` read a credential request the person wrote; `grantedCalls` re-ran the paused call from any author's event, so a call forged into a user event under the paused id ran with the forged arguments. | a library caller's message parts | both read only the agent's own events |
| F5 | A replayed grant re-ran the paused call. | a library caller's message parts | a request an earlier grant bound is closed |
| F6 | A `yaml_reference` chain that reached itself recursed at compile until the stack gave out, and the overflow took the process with it: one request stopped the server. | an agent the operator serves | the compile refuses the chain by name |

Recorded, not fixed, each the same on both runtimes unless it says otherwise:

| | Finding | Why it stays | Owner decision, with the recommendation |
|---|---|---|---|
| R1 | A garbled approval answer (`{ response: '<not JSON>' }`) throws a SyntaxError out of `runSyndicateTurn`; a function response naming no call throws ADK's content-processor Error. | ADK throws the same, so the runtimes agree; A2A never sends either (the executor builds the answer). The next turn runs. | Keep parity until ADK leaves (1.0), then return a failed result with a code instead of throwing. |
| R2 | An adapter that throws a non-Error has it rethrown as it is. | ADK's `runAndHandleError` rethrows it; the contract forbids an adapter to throw. | None needed. |
| R3 | A model can be steered by a tool result or a compaction summary to call an ungated tool. | The LLM01 boundary; the loop cannot tell persuasion from instruction. | Keep: gates on tools that act, fewer tools per agent. |
| R4 | A routed workflow cycle through nodes that call no model (tool nodes, route steps) is bounded only by the deadline; a library caller with no `deadlineMs` loops until it stops the turn. | ADK's scheduler has the same bound; a node-run ceiling changes the walk's semantics. | A walk-level ceiling on node runs (for instance 20 × `max_steps`), its own ticket. Over A2A the 15-minute deadline bounds it. |
| R5 | `registerTool` accepts a framework call's name (`adk_request_confirmation`, `adk_request_credential`, `adk_request_input`) for a tool of its own, which a model could then call by that name. | Operator code only; no request reaches it. | Refuse the reserved names in `registerTool`, with the next surface change. |
| R6 | A map over a list a model produced has no item ceiling of its own. | Every item calls a model, so `max_steps` bounds the run; workers are bounded by `max_parallel`. | None needed. |
| R7 | Two gated calls under one id show the person the first call's arguments, and fail closed when answered. | Fail closed; ADK does the same. | None needed. |

## The fuzz suite

`tests/nativeFuzz.test.ts` is seeded (mulberry32, 300 seeds) and runs in about a second, offline, with scripted adapters. A failing seed is named in the assertion; the case reproduces from it. The drawn turns mix:

- answers: tool calls (one to three) to the agent's tools, to the reserved names, to odd names (`''`, `__proto__`, `constructor`, padded), with arguments absent, `null`, a string, an array, 50–200 kB, nested 20–5,000 deep, or carrying `__proto__` and `constructor`, under fresh, duplicate, empty, `adk-` and `__proto__` ids; odd parts; empty finals; unknown finish reasons;
- streams: partials before the final, no final, an error after partial output, a thrown Error, a thrown non-Error;
- tools: an echo, a gated tool, one that writes a model-chosen state key, one whose result imitates an interrupt, one that throws a non-Error, one that returns a value nested 5,000 deep, and `ask_user`.

Run it alone with `node --experimental-strip-types --test tests/nativeFuzz.test.ts`. Widen `SEEDS` to search further; a new failure becomes a case of its own before it is fixed.
