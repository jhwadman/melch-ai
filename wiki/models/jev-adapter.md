---
type: model-provider
title: Jev adapter
description: "JevAdapter (lib/models/jevAdapter.ts) and the System One wire under it (lib/models/jev.ts): TypeSafe's Jev, a decision model, behind the engine's model contract. How an agent's output.schema becomes typed questions, what the state is, what the answer object holds, the direct and gateway routes and their model ids, the typed decide() call for code, failures, what the matrix says it cannot do, and what only a live run confirms."
tags:
  - models
  - runtime
  - contracts
generated:
  by: claude-code/claude-fable-5-1
  at: 2026-10-23
sources:
  - resource: lib/models/jev.ts
  - resource: lib/models/jevAdapter.ts
  - resource: lib/models/gateway.ts
  - resource: lib/models/capabilities.ts
  - resource: config/agents/examples/classifier.yaml
  - resource: tests/jev.test.ts
---

# Jev adapter

TypeSafe's Jev (https://typesafe.ai) is a System One model: it reads a `state` and a map of typed `questions`, and answers each question with a decision and calibrated probabilities, in about a tenth of a second, at $0.042 per million input tokens and nothing for output (`db/migrations/0022_typesafe_jev_pricing.sql`). It writes no prose, calls no tool and shows no reasoning, so it is the model of a classifier agent, never of an orchestrator. `JevAdapter` in `lib/models/jevAdapter.ts` puts it behind the engine's [model contract](/models/model-contract.md) ([ADR 0048](/decisions/0048-engine-owned-model-contract.md)); any `jev-*` id resolves to it ([provider routing](/models/provider-routing.md)). The decision is [ADR 0144](/decisions/0144-typesafe-jev-decision-provider.md).

## The schema is the request

`lib/models/jev.ts` `questionsFromSchema` reads the agent's `output.schema` (the contract's `outputSchema`, lowercase JSON Schema) and makes one question per property:

| Property | Question | Answer in the object |
|---|---|---|
| `type: boolean`, optionally a `oneOf` of `{ const: true, description }` and `{ const: false, description }` | `noul` (yes/no), the descriptions as its `criteria` | `true` when the probability of yes is 0.5 or above |
| `type: string` with `enum` | `choice`, each value its own criterion | the chosen string |
| `type: string` with a `oneOf` of `{ const, description }` | `choice`, each description a criterion (1 to 255) | the chosen string |
| `type: integer` with a `oneOf` of `{ const: 0, description }`, `{ const: 1, description }`, … in order (1 to 10) | `score`, the descriptions as its ordered `criteria` | the most probable level (the weighted mean is in the raw answer) |

The property's `description` is the question's `instructions`; without one, the property name in words. Anything else (a free string, a number without levels, an array, a nested object, a `oneOf` out of order, a property named `jev`) is refused before any call with `TYPESAFE_SCHEMA_UNSUPPORTED`, naming the property and the shapes Jev takes; no schema at all is `TYPESAFE_SCHEMA_REQUIRED`. So the same classifier YAML runs on Jev or on any chat model with structured output (the matrix's `structured_output` cell), with only `model:` changed; a chat model states no probabilities, so the `jev` key then does not appear.

The `state` is the request's system prompt (the agent's instruction), then every message's text in order: a user turn as written, an earlier assistant answer as `Earlier answer: …`, a tool result as `Tool result (<name>): <json>`. One string when that is all there is, else an array of strings. Image parts are dropped. Jev takes 64k tokens per request and 32k per question; the adapter sends no long-context header.

The final is one text part: the JSON object the schema describes, plus `jev`, a map from each property to Jev's raw answer (`noul` as the probability of yes; `choice`, `confidence`, `probabilities`; `score`, `confidence`, `legend`, `probabilities`). Code that calls the agent acts on the decisions and reads `jev.<name>.confidence` to decide when a person should look. `finishReason` is `stop`; `usage` is the call's input and output tokens. `examples/classifier.yaml` is the shipped pattern: a support-triage agent deciding department, urgency and whether a person must look.

## Routes and ids

Direct: `POST https://api.typesafe.ai/v1/systemone` with `Authorization: Bearer $TYPESAFE_API_KEY` (a caller's BYOK key wins over the environment's), `TYPESAFE_BASE_URL` for a proxy speaking the same wire; the id goes as the YAML names it. The ids are `jev-latest` (`DEFAULT_JEV_MODEL`, TypeSafe's alias for the newest stable release), `jev-preview`, `jev-1.14.0` and `jev-1.13.0`; `GET /v1/models` lists them.

Gateway: with no TypeSafe key and `MODEL_GATEWAY` set with its key, `planTransport` says `gateway` and `resolveAdapter` builds `JevAdapter` with `transport: 'gateway'`, never the chat-completions `GatewayAdapter`, because a gateway serves Jev on a System One route of its own (`GatewayInfo.systemOne` in `lib/models/gateway.ts`). Vercel AI Gateway: `https://ai-gateway.vercel.sh/typesafe/v1/systemone`, the aliases as `typesafe-ai/jev` (the id Vercel documents), the versioned ids as `GET /typesafe/v1/models` lists them. OpenRouter: `https://openrouter.ai/api/v1/systemone`, `typesafe/jev-1.14` (the patch dropped), the aliases as `~typesafe/jev-latest`. `MODEL_GATEWAY_MODEL_MAP` overrides either (`gatewaySystemOneModel`). The bearer is `MODEL_GATEWAY_API_KEY`; `provider` stays `typesafe` for attribution and the span's `llm.transport` is `gateway:<id>`. `MODEL_GATEWAY_BASE_URL` applies to the chat-completions route only. The matrix row is Jev's on either transport (`capabilityOf`).

## The typed call for code

`decide(request, { endpoint?, signal? })` from `melchizedek-agents/model` is the same call without an agent: `noul(instructions, criteria?)`, `choice(instructions, { option: description })` and `score(instructions, [level descriptions])` build the questions, and the answers are typed on them (`answers.department.choice` is the union of the criteria's keys). `jevEndpointFromEnv()` applies the transport rule; `questionsFromSchema` and `objectFromAnswers` are the two translations the adapter uses. It throws `JevError` (`code`, `retryable`, `status`), which the adapter turns into error finals.

## Failures

Error finals, never throws, with no parts: `TYPESAFE_MISSING_KEY` (no key and no funded gateway, before any request), `TYPESAFE_SCHEMA_REQUIRED` and `TYPESAFE_SCHEMA_UNSUPPORTED` (before any request), `TYPESAFE_HTTP_ERROR` (a non-2xx status, `status` set, retryable when `lib/models/retry.ts` retries it; through a gateway a 404 or 422 names `MODEL_GATEWAY_MODEL_MAP` and the gateway's models route as the fix), `TYPESAFE_UNREACHABLE` (the endpoint could not be reached, retryable), `TYPESAFE_BAD_ANSWER` (an answer that is not JSON or lacks a question's decision). A cancelled call is never retryable. Transient failures are retried on the request by `fetchWithRetry`, and `llm.retries` counts them. Messages never carry the key.

## What the matrix says

`structured_output` is the one supported cell: the schema is the request. `delegation`, `memory_tools` and `structured_output_with_tools` are unsupported (no tool reaches Jev; a request that carries tools is answered and the tools are dropped, marked `llm.capability.dropped`), as are `thinking_with_tools` (Jev does not reason; `reasoning:` is ignored and `REASONING_ABOVE_HIGH` says so), `streaming` (the final is the only response), `vision` and `native_search`. `npm run doctor` names an agent with tools or subagents on a Jev id as a gap before it runs. `tests/capabilityMatrix.test.ts` asserts each cell on the body the adapter posts and the final it makes; `tests/jev.test.ts` covers the routing, the wire ids, the credential source, the mapping and the failures.

## What a live run confirmed, and what remains

Run live on 2026-10-23 through Vercel AI Gateway with only the gateway key set: `examples/classifier.yaml` on `jev-latest` answered an outage message as technical, urgency 2, no person needed (probabilities 1.0, 1.0, 0.08) in 715 ms and a pricing question as sales, urgency 0 in 228 ms, each one System One call of about 770 input tokens; `decide()` on `jev-latest`, `jev-preview`, `jev-1.14.0` and `jev-1.13.0` all answered (the aliases as `typesafe-ai/jev`, the versions as written; 150 to 500 ms). Vercel reports a non-zero `output_tokens` (20 for one noul question), which the price row bills at zero. Not run live: OpenRouter's System One route (`~typesafe/jev-latest`, `typesafe/jev-1.14`) and TypeSafe's own API with a direct key, which speaks the same wire. The adapter validates the type and the decision value of each answer and nothing more.
