---
type: decision
title: 'ADR 0028: A tool can require a human approval, per agent, through A2A input-required'
description: An agent lists in `require_approval` the tools it may call only after a person approves the exact call; the turn pauses on ADK's confirmation interrupt, the A2A task ends `input-required` with the pending call, and the caller's approve or reject resumes it. Gates run only on agents the turn runs directly (an orchestrator, a plan-dispatch route), never inside a delegated subagent.
tags:
  - decision
  - protocols
  - tools
status: stable
generated:
  by: claude-code/claude-opus-5-5
  at: 2026-10-02
sources:
  - resource: lib/compile.ts
  - resource: lib/runtime/syndicateTurn.ts
  - resource: lib/a2a/executor.ts
  - resource: lib/session/transcript.ts
  - resource: lib/syndicateSchema.ts
---

# ADR 0028: A tool can require a human approval, per agent, through A2A input-required

## Context

[ADR 0026](/decisions/0026-governance-policy-and-visibility.md) deferred approval gates for tools that write. A tool that sends, books, pays or deletes is an action a model chooses, with arguments a model chooses. An enterprise wants a person to see that exact action before it runs.

ADK 2.2 has the mechanism: a `FunctionTool` with `requireConfirmation` does not run when called. The turn instead raises an `adk_request_confirmation` call that pins the original call and its arguments. A later user message answering that call with `{ confirmed }` runs or refuses it. ADK fails closed when the answer does not bind to the pinned call (`IntentMismatchError`).

A2A has the matching state: a task in `input-required` waits for the client's next message.

Three facts constrain the design, each found by running ADK, not by reading it:

- **A delegated subagent cannot pause its caller.** Inside an `AgentTool`, the confirmation interrupt is swallowed: the subagent returns an empty result and the gated tool never runs. That is closed, but silent.
- **A plan-dispatch route reads history through a projection** that drops tool traffic ([session transcripts](/memory/architecture.md)). A resumed route would not find the pinned call.
- **Stored events lose `thoughtSignature`.** Gemini 3 rejects a replayed function call in the current turn without one, and a resume replays exactly that call.

## Decision

1. **Opt-in per tool, per agent, in YAML.** `require_approval: [send_email]` on an agent names tools from its own `tools:` list. Nothing is gated by default. The deployment decides, as it decides exposure ([tool contracts](/tools/tool-contracts.md)).
2. **ADK's own gate does the work.** Compile marks those `FunctionTool`s `requireConfirmation`. Approval binds to the exact call: ADK refuses an approval whose pinned call or arguments differ from the history.
3. **Only where a pause can reach the caller.** A gate is valid on the orchestrator, and on a subagent of a plan-dispatch syndicate, which runs as the turn's own agent. A gate on a delegated subagent, or anywhere inside a nested `yaml_reference` syndicate, is a load error, not a silent no-op.
4. **The turn reports `input-required`.** When the answering agent's run ends on an unanswered confirmation request, the turn returns `status: 'input-required'` with the pending call: id, agent, tool and arguments. Guards and memory ingestion wait for the completed turn.
5. **A2A carries it.** The task ends `input-required`, final. Its status message names the agent, the tool and the arguments, and carries a data part `{ type: 'approval_request', approval_id, agent, tool, args }`. The client answers on the same conversation with a data part `{ approval: { id, approved } }`, or with the text `approve` or `reject` when one call is pending. A message with no decision while a call is pending is answered with the same request again, without a model call.
6. **Resume runs the agent that asked.** A plan-dispatch resume skips classification and runs the route whose agent raised the request. The projection keeps the interrupted turn's events raw, so ADK finds the pinned call.
7. **Storage keeps replay valid.** A stored function-call part's thought signature becomes Gemini's documented `skip_thought_signature_validator` value instead of being dropped. The model loses its private reasoning for that step, not the ability to continue.

## Alternatives considered

- **Gate in the policy plug point** (`authorize` before every tool call). Rejected: it decides before the model's arguments are known to a person, and it has no way to wait for one.
- **Gate inside delegated subagents** by teaching `AgentTool` to surface interrupts. Rejected for now: it means re-implementing ADK's nested runner, and ADK may grow this itself.
- **Approval by tool author** (`defineTool({ requiresApproval })`). Rejected as the only switch: whether a write needs a person depends on the deployment, not the tool. A contract-level default can be added later without changing this decision.

## Consequences

- An approval is a second request on the same conversation. A client that only reads the final status still sees why the task stopped.
- A pending approval holds no lease and no worker. It waits in the session until it is answered or the conversation moves on.
- MCP tools and native-search sentinels cannot be gated; listing one is a compile error.
