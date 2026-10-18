---
type: decision
title: "ADR 0057: One chat-completions adapter base for Ollama, Kimi and the gateway"
description: "Ollama, Kimi and the gateway are ModelAdapters on one ChatCompletionsAdapter base; their ADK shims, which kept the ADK shape and older spelling, are gone."
tags:
  - decision
  - models
  - runtime
  - contracts
status: stable
generated:
  by: claude-code/claude-opus-5-5
  at: 2026-10-18
sources:
  - resource: lib/models/chatCompletionsAdapter.ts
  - resource: lib/models/ollamaAdapter.ts
  - resource: lib/models/kimiAdapter.ts
  - resource: lib/models/gatewayAdapter.ts
  - resource: lib/models/openAiCompatibleLlm.ts
  - resource: lib/models/adkShim.ts
  - resource: tests/chatCompletionsAdapter.test.ts
---

# ADR 0057: One chat-completions adapter base for Ollama, Kimi and the gateway

**Decided (2026-10-07):** Ollama, Kimi and the gateway share one `ChatCompletionsAdapter` base on the model contract; each subclass supplies only its endpoint, headers, wire name, reasoning field, honoured tool choices and error wording. Until 1.0.0 their ADK shims carried the older spelling the contract dropped and kept usage with reasoning included.

**Instead of:** the plain shim with Gemini's usage meaning, a contract field for provider effort words, a second translation beside the adapter, overriding `generateContentAsync` or an `AsyncLocalStorage` side channel

**Superseded by:** [ADR 0061](/decisions/0061-json-mode-on-the-contract.md) (JSON mode left the older spelling); [ADR 0107](/decisions/0107-release-1-0-0-removes-adk.md) (the shims removed; one usage meaning on the ledger)

How it works: [Chat-completions adapters](/models/chat-completions-adapters.md)
