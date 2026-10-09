---
type: decision
title: "ADR 0109: An output schema beside tools travels in the provider's own field where the path takes both, as set_model_response elsewhere"
description: "WS6-1. An orchestrator may hold an outputSchema beside its subagent tools: it delegates, then answers in the schema. The capability matrix gains structured_output_with_tools. Where it is supported for the model's generation (Claude from Opus 4.8, Sonnet 5 and Haiku 5.5 on, every OpenAI id, Gemini 2 and later on Vertex AI), and on the agent's fallback_model too, the native loop sends the schema in the provider's structured-output field in the same request as the tools; anywhere else it keeps ADK's set_model_response tool. Plan-dispatch stays, as a choice. Forcing the schema to a leaf, set_model_response on every path, and the native field on every provider that accepts the request were rejected."
tags:
  - decision
  - models
  - runtime
  - orchestration
status: stable
generated:
  by: claude-code/claude-opus-5-5
  at: 2026-10-09
sources:
  - resource: lib/models/capabilities.ts
  - resource: lib/runtime/native/request.ts
  - resource: lib/syndicateSchema.ts
  - resource: lib/dispatch.ts
  - resource: tests/capabilityMatrix.test.ts
  - resource: tests/structuredOrchestrator.test.ts
  - resource: tests/fixtures/structured-critic.yaml
---

# ADR 0109: An output schema beside tools travels in the provider's own field where the path takes both, as set_model_response elsewhere

## Context

An agent that holds an `outputSchema` ends its turn on one JSON object matching it. Under ADK an orchestrator could not hold one beside its subagents: `LlmAgent` refused an output schema with transfer, and an orchestrator holding both deadlocked. The shipped examples therefore put the schema on a tool-less leaf (`config/agents/examples/critic.yaml`, `scribe.yaml`, `image_production.yaml`), and plan-dispatch (`lib/dispatch.ts`) made the router a tool-less classifier whose JSON code reads. The YAML's own description told authors to hold a schema on a leaf.

The engine's loop ([ADR 0045](/decisions/0045-own-runtime-behind-the-seam.md)) delegates through subagent tools, never through transfer, and it already handles a schema beside tools the way ADK's request processors did ([ADR 0066](/decisions/0066-native-step-sends-the-adk-request.md)): the schema goes in the request only for Gemini 2 and later on Vertex AI, and on every other model the loop declares a `set_model_response` tool whose parameters are the schema, asks for it in the instruction, and ends the turn on its arguments. That works on every path, but the model is asked, not held, to answer in the schema: a tool's parameters are not the provider's structured-output guarantee, and the model may answer in text instead.

Most providers now take a structured-output field and tools in one request: Claude's `output_config.format` from Opus 4.8, Sonnet 5 and Haiku 5.5 on ([ADR 0049](/decisions/0049-claude-requests-by-model-generation.md)), OpenAI's `text.format`, Gemini's `responseJsonSchema` (on Vertex AI from Gemini 2, on the Gemini API documented for Gemini 3). The adapters already send a `ModelRequest`'s `outputSchema` beside its `tools` unchanged; only the request builder kept the schema out.

## Decision

1. **An orchestrator may hold an `outputSchema` beside its subagents.** The syndicate schema never refused it; its description now says what happens: the agent calls its tools and delegates first, then ends its turn on the JSON. Nothing else in the YAML changes, and no key is added.
2. **The capability matrix gains `structured_output_with_tools`.** Its cell says how a schema travels for an agent that calls tools or delegates:
   - *supported*: the schema goes in the provider's own structured-output field, in the same request as the tools. Anthropic (from Opus 4.8, Sonnet 5 and Haiku 5.5; earlier generations get set_model_response, said in the note), OpenAI, and Gemini on Vertex AI (a platform cell: Gemini 2 and later).
   - *degraded*: the schema is the `set_model_response` tool beside the agent's tools. The Gemini API, xAI, Moonshot, Ollama (grammar-constrained decoding to the schema would hold back the tool calls) and the gateway (upstream support varies).
   `requiredCapabilities` asks for it when an agent with an `outputSchema` lists tools or delegates, so the doctor names a degraded path.
3. **The request builder reads the matrix.** `outputSchemaBesideTools(model)` (`lib/models/capabilities.ts`) is true where the cell is supported on the path the model takes (`planTransport`, the platform) and the model's generation takes it (`claudeGeneration(model).structuredOutput === 'output_format'`; a `gemini-<n>` id with n ≥ 2). `buildModelRequest` sends the schema beside the tools when that holds, or ADK's own Gemini rule does, for the agent's model AND its `fallback_model`, since a fallback answers the same request. Otherwise it declares `set_model_response` exactly as before. A path that cannot be planned answers false, the form that works everywhere. `mode: task` is unchanged: `finish_task` carries the schema there and ADK's rule still decides the instruction line.
4. **Plan-dispatch stays, as a choice.** It is for a turn whose answer IS the specialist's: code runs the route and its output is the reply. A schema on a delegating orchestrator is for a turn whose answer is the orchestrator's own structured judgment of what its team returned. Neither is forced; `lib/dispatch.ts` says so.
5. **The shipped examples are not restructured.** `critic.yaml` keeps its leaf; `tests/fixtures/structured-critic.yaml` is the critic as one agent, run offline on Claude and GPT through `runSyndicateTurn` by `tests/structuredOrchestrator.test.ts`.

## Alternatives rejected

- **Refuse the schema on an orchestrator that delegates (or warn).** The engine runs it correctly on every path; a refusal would keep ADK's limit after ADK is gone and force a relay leaf or plan-dispatch where neither fits.
- **`set_model_response` on every path.** It works everywhere and changes nothing, but leaves the provider's structured-output guarantee unused on exactly the providers that offer it beside tools, and costs nothing to keep where they do not.
- **The native field wherever the provider accepts the request.** Ollama accepts `format` and tools together, but decoding constrained to the schema keeps the model from emitting a tool call; the gateway's upstream varies by model; xAI, Moonshot and the Gemini API (Gemini 3) are documented to take both but have no live run behind them yet. Each moves to *supported* by changing its cell, with a live check, without touching the request builder.
- **Decide per adapter at request time.** The adapters already send whatever `ModelRequest` they receive; deciding in the request builder from the matrix keeps one table that the doctor, the ledger and the request read alike, as [ADR 0019](/decisions/0019-multi-model-parity-matrix.md) asks.

## Consequences

- An agent with an `outputSchema` and tools on Claude's current generations or OpenAI no longer sees `set_model_response` or its instruction line; its final step answers in text, which the provider holds to the schema, and the loop's `outputKey` parsing and validation are unchanged. No shipped syndicate holds a schema beside tools on those providers.
- Claude: a schema the SDK's strict transform refuses falls back, in the adapter, to a `structured_output` tool offered under `auto` beside the other tools ([ADR 0049](/decisions/0049-claude-requests-by-model-generation.md)), with its one-time warning.
- The decision reads the environment's path for the model id (key present, gateway, platform), as the doctor does. A BYOK caller's key is not visible to it, so a path the server would route through the gateway gets `set_model_response`, which works there.
- `CAPABILITIES`, `Capability` and `CAPABILITY_MATRIX` (published under `melchizedek-agents/models/*`) gain a member; code that builds a `Record<Capability, …>` must add it. The CHANGELOG's Unreleased section says so.
