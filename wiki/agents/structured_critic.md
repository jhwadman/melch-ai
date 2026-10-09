---
type: syndicate
title: Structured Critic
description: "Asks a Drafter for a draft, then grades it in its own JSON schema: a polished message, a confidence score and the issues."
tags:
  - syndicate
generated:
  by: process:wiki-build
  at: 2026-10-09
sources:
  - resource: config/agents/examples/structured_critic.yaml
---

# Structured Critic

<!-- wiki:fill slot="charter" -->
The Structured Critic is the critic as one agent ([ADR 0109](/decisions/0109-structured-output-beside-tools.md)). The Critic orchestrator passes the user's question to a DrafterAgent, grades the draft, and ends its turn on one JSON object in its own `output.schema`: a polished `message`, a `confidence` score from 0 to 100, and an `issues` list quoting the words at fault. No relay leaf and no plan-dispatch block sit between the team and the schema.

The Critic runs on `claude-opus-5-5`, whose path takes the schema in the same request as its delegation tool (`output_config.format`, the capability matrix's `structured_output_with_tools`); the Drafter holds no schema and runs on the cheaper `claude-haiku-5-5`. On a degraded path (the Gemini API, xAI, Moonshot, Ollama, the gateway) the engine declares a `set_model_response` tool beside the delegation tool instead, and `npm run doctor` names the gap. It makes one pass; [Critic Review Workflow](/agents/critic.md) is the graded draft-and-revise loop with the schema on a leaf. Run this syndicate to see an orchestrator answer in its own structured judgment of what its team returned. It needs only `ANTHROPIC_API_KEY`.
<!-- /wiki:fill -->

<!-- wiki:generated section="composition" source="config/agents/examples/structured_critic.yaml" -->
Run: `npm run syndicate:structured-critic`

- memory: `session-only` · max_steps: 8
- orchestrator: **Critic** (`claude-opus-5-5`)

| Subagent | Model | Tools | MCP |
|---|---|---|---|
| DrafterAgent | `claude-haiku-5-5` | — | — |
<!-- /wiki:generated -->
