---
type: decision
title: "ADR 0074: Native delegation runs a subagent as a child loop in its own session, as ADK's AgentTool does"
description: "On the native loop a subagent is a tool (subagentTool, lib/runtime/native/delegate.ts) whose call runs the subagent on its own runAgentLoop. The child run keeps ADK's AgentTool's shape exactly: a session of its own under the subagent's name (created from the caller's state, then continued), the request as a user message under a fresh invocation id, its state writes recorded on the caller's response, and the last event's text as the result. Calls to subagents in one step run one after another. A pause inside a subagent stays swallowed, as ADR 0028 says. An ADK AgentTool listed on a native agent fails the run with a message. A branch of the caller's session, running subagents in parallel, and converting an ADK AgentTool by shape were rejected."
tags:
  - decision
  - runtime
  - tools
status: stable
generated:
  by: claude-code/claude-opus-5-5
  at: 2026-10-08
sources:
  - resource: lib/runtime/native/delegate.ts
  - resource: lib/runtime/native/agentLoop.ts
  - resource: tests/nativeDelegate.test.ts
  - resource: tests/syndicateTurn.test.ts
---

# ADR 0074: Native delegation runs a subagent as a child loop in its own session, as ADK's AgentTool does

## Context

A DELEGATE syndicate lists each subagent on its orchestrator as ADK's `AgentTool` (`lib/compile.ts`), and a `yaml_reference` subagent is the nested syndicate's orchestrator under the entry's name. The native loop ([ADR 0071](/decisions/0071-native-loop-runs-calls-as-adk-stores-them.md)) ran a single agent: an `AgentTool` it met took the generic path for ADK tools and failed into an error answer. A session either runtime wrote must be one the other continues ([ADR 0045](/decisions/0045-own-runtime-behind-the-seam.md)), so a delegated call must store what `AgentTool` stores.

Running ADK showed what that is. `AgentTool.runAsync` starts a `Runner` of its own, with the subagent's name as the app name and the caller's session service. Its session has the caller's user id and session id. `getOrCreateSession` creates it from the caller's state on the first call and continues it afterwards. The run is not a branch of the caller's session: no event of the subagent's reaches the caller's session, and no branch is set. The caller's session gets only the call and its response, and the response carries the child's state writes.

Three choices had real alternatives: where the child's events live, whether a step's subagent calls run together, and what to do with an ADK `AgentTool` listed on a native agent.

## Decision

1. **The child keeps AgentTool's session.** A subagent tool's call runs the subagent on `runAgentLoop` in the session `{ appName: <subagent>, userId, sessionId }` of the caller's store. It is created with the caller's state (the session's, then the call's writes, `temp:` keys dropped) and continued by every later call. The request is stored as a user event under a fresh `e-<uuid>` invocation id. The child runs as its run's root, not streamed, under the turn's controls and signal, with the caller's memory. Each event's state writes, `temp:` keys aside, go into the call's state delta. The result is the last event's non-thought text joined by newlines, `''` for none, and parsed as JSON under an output schema. A turn that stops ends the call as ADK's Runner ends it: no further events are read, and the caller stores no response.
2. **A step's subagent calls run one after another, in call order**, as ADK runs them. Other calls in the step still run in parallel (ADR 0071, Decision 2).
3. **A pause inside a subagent stays swallowed** ([ADR 0028](/decisions/0028-approval-gates.md)). The child run ends paused and its last event carries no text, so the call answers `''` and the gated tool never runs. WS6-2a lifts it.
4. **An ADK AgentTool listed on a native agent fails the run**, with a message that names `subagentTool`. A subagent reaches the native loop as `subagentTool(agent)`, or as any tool carrying the `SUBAGENT` symbol with a `NativeAgent`.
5. **The hook in the loop is one call.** `runCall` asks `subagentOf(tool)` before the generic path, and `runSubagent` does the rest in `delegate.ts`. The DELEGATE relay fallback stays in `runSyndicateTurn`: it reads the drained run, from either runtime.

> **Note (2026-10-09):** [ADR 0110](/decisions/0110-pauses-inside-delegated-subagents-reach-the-turn.md) supersedes Decision 3: a child run that ends paused leaves the call open, the caller ends paused, the turn reports the pause with the agent path, and the answer resumes the child before the caller's next step.

> **Note (2026-10-09):** [ADR 0111](/decisions/0111-pauses-inside-nested-syndicates.md) supersedes Decision 1's session key: the child session is filed under the agent path (`<app>/<caller>/<subagent>`), and one stored under the subagent's name is still continued.

> **Note (2026-10-09):** [ADR 0116](/decisions/0116-a-steps-subagent-calls-run-at-once-under-max-concurrency.md) supersedes Decision 2: a step's subagent calls run at once, under the syndicate's `max_concurrency` (default 4; `1` keeps this order), two calls to one subagent one after the other, and the responses stored in call order.

## Alternatives considered

- **Run the child on a branch of the caller's session** (ADK's `ParallelAgent` naming, `<caller>.<subagent>`). It keeps one session per conversation. But ADK's AgentTool does not do it, so a session written by one runtime would not be one the other continues: on ADK the subagent would lose its own history, and the caller's projection would meet branch events it never meets on ADK.
- **Run a step's subagent calls in parallel.** It is faster for the council's two specialists. But two calls to one subagent would race on its session. The order of model calls, and so where `max_steps` stops a turn, would differ from ADK. Concurrent subagents are WS6.
- **Read an ADK AgentTool's LlmAgent by shape.** It would let a native agent list compile's `AgentTool` today. But the LlmAgent holds a resolved model instance where the native loop takes a model id and resolves the adapter itself. Building the `NativeAgent` from the YAML is the compile split's job (WS2-10).

## Consequences

- The compile split (WS2-10) builds a DELEGATE orchestrator's `NativeAgent` with each subagent as `subagentTool(...)` first, then the orchestrator's own tools, as `compileGraph` orders them. A nested syndicate is its orchestrator under the entry's name and description.
- `tests/nativeDelegate.test.ts` runs the boundary suite's delegation cases, a nested syndicate and the council example on both runtimes. It requires the same events in every session, ids, times and minted invocation ids aside, and the same requests to every model.
- The loop now stores no response when the turn stopped while a step's calls ran, as ADK's `LlmAgent` does after a step's calls. This holds for every tool, not only a subagent.
- Under the default `retries`, ADK's reflect-and-retry plugin adds its own tool to the caller's requests. The native requests match once WS2-8 brings self-correction.
