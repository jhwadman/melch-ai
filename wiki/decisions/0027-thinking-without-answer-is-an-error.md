---
type: decision
title: "ADR 0027: A chat-completions turn that thinks but never answers is a named error"
description: "An OpenAI-compatible turn that ends with reasoning or a length cut-off and no reply or tool call yields <PROVIDER>_MAX_TOKENS or <PROVIDER>_EMPTY_RESPONSE, never an empty final."
tags:
  - decision
  - models
status: stable
generated:
  by: claude-code/claude-opus-5-5
  at: 2026-10-18
sources:
  - resource: lib/models/openAiCompatibleLlm.ts
  - resource: lib/models/ollamaLlm.ts
  - resource: config/agents/examples/model_zoo.yaml
  - resource: tests/models.test.ts
---

# ADR 0027: A chat-completions turn that thinks but never answers is a named error

**Decided (2026-10-01):** When an OpenAI-compatible provider ends a turn with reasoning, or with `finish_reason: length`, and neither reply text nor a tool call, the adapter yields a named error (`<PROVIDER>_MAX_TOKENS` or `<PROVIDER>_EMPTY_RESPONSE`) rather than an empty final. Whether an agent thinks stays a choice in its own YAML; only the Ollama adapter retries once with thinking off (added 2026-10-02).

**Instead of:** returning the reasoning as the answer, raising the context per request through Ollama's native `/api/chat`, a default `reasoning_effort` in the Ollama adapter, an error on every empty final
**Open:** a non-streaming Ollama call that thinks past 300 s hits Node's fetch headers timeout and is reported as `OLLAMA_UNREACHABLE`

How it works: [Chat-completions adapters](/models/chat-completions-adapters.md)
