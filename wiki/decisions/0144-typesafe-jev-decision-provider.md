---
type: decision
title: "ADR 0144: TypeSafe Jev is a provider whose request is the agent's output schema; a gateway serves it on its own route"
description: "jev-* ids get a direct TypeSafe adapter on the engine's model contract that turns an agent's output.schema into Jev's typed questions and answers with the schema's object plus the raw probabilities; Vercel AI Gateway and OpenRouter serve it on their System One routes when the key is absent; the gateway settings are read through the credential source; the setup leads with one gateway key."
tags:
  - decision
  - models
status: stable
generated:
  by: claude-code/claude-fable-5-1
  at: 2026-10-23
sources:
  - resource: lib/models/jev.ts
  - resource: lib/models/jevAdapter.ts
  - resource: lib/models/gateway.ts
  - resource: lib/models/providerMap.ts
  - resource: lib/models/capabilities.ts
  - resource: config/agents/examples/classifier.yaml
  - resource: db/migrations/0022_typesafe_jev_pricing.sql
  - resource: tests/jev.test.ts
  - resource: tests/capabilityMatrix.test.ts
---

# ADR 0144: TypeSafe Jev is a provider whose request is the agent's output schema; a gateway serves it on its own route

**Decided (2026-10-23):** `jev-*` ids get a direct TypeSafe provider (`TYPESAFE_API_KEY`, `https://api.typesafe.ai/v1/systemone`, `TYPESAFE_BASE_URL` for a proxy) on the engine's model contract, `jev-latest` the default. Jev is a decision model, not a chat model, so its adapter does not speak chat completions: an agent's `output.schema` is translated into Jev's typed questions, one per property (boolean → noul, string with `enum` or a `oneOf` of described constants → choice, integer whose `oneOf` describes the levels 0..n-1 → score; the description is the instruction), the instruction and the conversation's text are the state, and the final is the schema's object with the raw answers, probabilities included, under a reserved `jev` key. A schema Jev cannot answer fails before any call, naming the property. Tools, delegation, reasoning, streaming and images are stated unsupported in its matrix row; the row applies on both transports. With no TypeSafe key, a configured gateway serves `jev-*` ids on its own System One route (`GatewayInfo.systemOne`: Vercel at `/typesafe/v1/systemone` as `typesafe-ai/jev`, OpenRouter at `/api/v1/systemone` as `typesafe/jev-1.14`), under the same fallback rule as every cloud id. `MODEL_GATEWAY`, its base URL and its model map are read through the credential source, as the key already was, so a host's keychain can turn the gateway on. `.env.example`, the README's cloud quick start and the keys onboarding skill lead with one gateway key; the routing rule is unchanged. Price rows (migration 0022) hold $0.042 input and $0 output.

**Instead of:** a `questions:` YAML key of Jev's own (a provider-specific agent shape; the schema already says what the reply is, and the same file then runs on a chat model); a decision *tool* a chat agent calls (an LLM in front of every decision, which is the cost Jev removes); the chat gateway adapter for `jev-*` on a gateway (a gateway cannot turn a chat request into a System One one); returning the weighted mean for a score (an integer property; the most probable level is returned and the mean stays in the raw answer); dropping the probabilities to keep the object strictly the schema's (the calibration is the point; `jev` is reserved); reordering the setup's numbered levels to put the gateway first (the level ids and numbers are cited by the skills and the docs; the emphasis moves instead)

**Supersedes:** none ([ADR 0012](/decisions/0012-direct-adapters-canonical.md) still holds: a direct key wins, the gateway stands in)

**Open:** OpenRouter's System One route (not run live; Vercel's was, on 2026-10-23: `typesafe-ai/jev` for the aliases and `jev-1.14.0`, `jev-1.13.0` as written all answered, 150 to 500 ms); TypeSafe's own API with a direct key (not run live; the same wire); Jev's image mode (box questions) and long-context header; a `fallback_model` from a Jev agent to a chat model when confidence is low (today the caller reads `jev.<name>.confidence`)

How it works: [Jev adapter](/models/jev-adapter.md)
