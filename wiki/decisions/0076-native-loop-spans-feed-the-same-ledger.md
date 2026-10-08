---
type: decision
title: "ADR 0076: The native loop opens its own agent, model-call and tool spans, and the ledger reads both runtimes' names"
description: "A native run writes the ledger rows an ADK run writes. The loop opens agent.invoke <name>, model.call and tool.execute <name> spans in its own scope (melchizedek.runtime), nested as ADK nests invoke_agent, call_llm and execute_tool, with ADK's gen_ai.* attributes. The tracer's lineage and the exporter's payload tier read both naming schemes through lib/observability/lineage.ts. A step's payload row comes from the engine's own llm.payload.* attributes on model.call, only for a call that did not fail; a failed call's payload stays on its llm.request on both runtimes. Reusing ADK's names and scope, recording ADK's genai request shape, and a payload on every model.call were rejected."
tags:
  - decision
  - runtime
  - observability
status: stable
generated:
  by: claude-code/claude-opus-5-5
  at: 2026-10-08
sources:
  - resource: lib/runtime/native/telemetry.ts
  - resource: lib/runtime/native/agentLoop.ts
  - resource: lib/observability/lineage.ts
  - resource: lib/observability/tracer.ts
  - resource: lib/observability/supabaseSpanExporter.ts
  - resource: tests/nativeLedger.test.ts
---

# ADR 0076: The native loop opens its own agent, model-call and tool spans, and the ledger reads both runtimes' names

## Context

The ledger ([ADR 0009](/decisions/0009-observability-ledger.md)) is a projection of a turn's spans: `adk_turns` from the root span, `adk_telemetry` from the root and every `llm.request`, `adk_payloads` from the spans that carry a model call's request and response. On the ADK runtime three of ADK's spans feed it:

- `invoke_agent <name>` around an agent's run. The tracer's lineage walks up from an `llm.request` to it, which fills the `agent` column of every telemetry row.
- `call_llm` around each step's model call. It carries ADK's request and response (`gcp.vertex.agent.llm_request`, `.llm_response`), and is the payload row of a call that did not fail. A failed `call_llm` never ends, so a failed call's payload comes from its `llm.request` ([ADR 0053](/decisions/0053-adapter-caller-charges-and-traces.md)).
- `execute_tool <name>` around each tool call. Its duration is the turn's `tool_ms`.

The native loop ([ADR 0071](/decisions/0071-native-loop-runs-calls-as-adk-stores-them.md)) opened none of them. The step's `llm.request` span already matched ([ADR 0066](/decisions/0066-native-step-sends-the-adk-request.md)), but on a native run it had no agent to walk up to, tool time was zero, and a call that did not fail left no payload. [ADR 0045](/decisions/0045-own-runtime-behind-the-seam.md) requires a native run to write the same ledger rows as an ADK run.

## Decision

1. **The loop opens three spans of its own, in scope `melchizedek.runtime`** (`lib/runtime/native/telemetry.ts`):
   - `agent.invoke <name>` around `runAgentLoop`, opened when the run starts, so it is a child of the turn's root span;
   - `model.call` around each step, the parent of the step's `llm.request` (two of them when a fallback model answers);
   - `tool.execute <name>` around each tool call, under the agent span (a step's calls run side by side).

   They carry ADK's `gen_ai.*` attributes: operation, agent name and description, conversation id, tool name and call id, request model, usage, finish reason. `agentLoop.ts` calls three hooks: `traceAgentInvocation`, `traceModelCall` and `traceToolCall`.
2. **The tracer and the exporter read both naming schemes.** `lib/observability/lineage.ts` names them: `agentOfSpanName` (`invoke_agent X`, `agent.invoke X`), `isToolSpanName` (`execute_tool `, `tool.execute `) and `isModelCallSpan` (`call_llm` in ADK's scope, `model.call` in the loop's). `agentForSpan`, the tool-time sum, the agent stamp on a model-call span and `isPayloadSpan` use them. The console exporter keeps the loop's scope quiet, as it keeps ADK's.
3. **A step's payload comes from the engine's own attributes.** A `model.call` whose call did not fail carries `llm.payload.request` (the `ModelRequest` as the adapter got it, its signal left out) and `llm.payload.response` (the adapter's final `FinalModelResponse`), capped as a failed call's are. A failed step carries no payload: its `llm.request` carries the failed call's, as on the ADK runtime. With `TELEMETRY_PAYLOADS=off` no payload is recorded. `isPayloadSpan` takes a `model.call` only when it carries one.
4. **Model-call attributes mean what ADK's mean.** `gen_ai.request.model` is the agent's model, as on `call_llm`, also when a fallback answered; the `llm.request` span and the payload's request name the model that answered. `gen_ai.system` is the provider of the adapter that answered, where `call_llm` names ADK's own scope.
5. **Tool spans carry no arguments and no results.** The root span's `ToolCall` and `ToolResponse` events are where the ledger keeps them. A tool span records `tool.error` for an error response, and `tool.pending` for a long-running call that answered nothing.

## Alternatives considered

- **Reuse ADK's names and scope** (`invoke_agent`, `call_llm`, `execute_tool`, `gcp.vertex.agent`). The ledger would need no reader change. But the engine's spans would claim to be ADK's in every trace viewer, and the names would have to outlive ADK in the engine. Reading both schemes costs three helpers.
- **Record ADK's request shape on `model.call`** (`gcp.vertex.agent.llm_request`, genai contents and config). The payload rows would be byte-identical. But it means mapping every request into a shape the engine does not hold, with ADK's own additions (its `adk_agent_name` label), only to store it. A failed call's row already holds a `ModelRequest` on both runtimes.
- **A payload on every `model.call`, failed or not.** A failed call would then write two payload rows on the native runtime and one on ADK.
- **One `model.call` per leaf call instead of per step.** It would sit in `step.ts`, beside `llm.request`. But ADK's `call_llm` covers the step, including a fallback's second call, and the loop is where the step is.

## Consequences

- `tests/nativeLedger.test.ts` runs the same conversation on both runtimes and hands each run's spans to the exporter. `adk_turns`, `adk_telemetry` and `adk_payloads` hold the same rows, ids, times and durations aside, for a turn with a tool call, a failed call, a throwing tool and a fallback. A step's own payload row differs in three columns: `request` and `response` are the engine's shapes, and `provider` names the provider where ADK's row says `gcp.vertex.agent`.
- A step's calls run side by side on the native loop, so `tool_ms` sums their durations. On ADK the calls run one after another, so the sum is wall time.
- WS2-10 wraps the native stream in `traceAgentRun` as `runSyndicateTurn` wraps ADK's, with the same metadata. The root span then reads the native events as it reads ADK's.
- `melchizedek-agents/observability/lineage` exports the scope names and the three helpers (CHANGELOG).
