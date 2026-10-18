---
type: decision
title: "ADR 0096: Ollama structured output sends the schema as strict json_schema"
description: "An output schema on an ollama/ model goes as strict response_format json_schema, as on Kimi and the gateway, with Ollama 0.5.0 the documented minimum and no version probe or fallback."
tags:
  - decision
  - models
  - contracts
status: stable
generated:
  by: claude-code/claude-opus-5-5
  at: 2026-10-18
sources:
  - resource: lib/models/ollamaAdapter.ts
  - resource: lib/models/chatCompletionsAdapter.ts
  - resource: lib/models/capabilities.ts
  - resource: tests/chatCompletionsAdapter.test.ts
  - resource: tests/doctor.test.ts
---

# ADR 0096: Ollama structured output sends the schema as strict json_schema

**Decided (2026-10-08):** Send an Ollama agent's output schema as strict `json_schema`, exactly as for Kimi and the gateway, and mark Ollama's structured output supported. Ollama 0.5.0 is the documented minimum; the adapter neither probes the version nor falls back to `json_object`.

**Instead of:** a version probe with a clear error, a probe with a json_object fallback, keeping json_object
**Open:** servers older than 0.5.0 and Ollama Cloud do not enforce the schema (no check; a doctor check if it ever matters)

How it works: [Chat-completions adapters](/models/chat-completions-adapters.md)
