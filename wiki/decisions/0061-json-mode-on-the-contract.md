---
type: decision
title: "ADR 0061: JSON mode without a schema is a contract field, outputFormat: 'json'"
description: "ModelRequest gains outputFormat: 'json', sent as each provider's JSON mode; Claude, which has none, sends nothing."
tags:
  - decision
  - models
  - contracts
status: stable
generated:
  by: claude-code/claude-opus-5-5
  at: 2026-10-18
sources:
  - resource: lib/models/contract.ts
  - resource: lib/models/genaiMapping.ts
  - resource: lib/models/gptAdapter.ts
  - resource: lib/models/chatCompletionsAdapter.ts
  - resource: lib/models/openAiCompatibleLlm.ts
  - resource: lib/models/geminiAdapter.ts
  - resource: lib/models/claudeAdapter.ts
  - resource: tests/genaiMapping.test.ts
  - resource: tests/responsesAdapter.test.ts
  - resource: tests/chatCompletionsAdapter.test.ts
---

# ADR 0061: JSON mode without a schema is a contract field, outputFormat: 'json'

**Decided (2026-10-07):** JSON mode without a schema is `ModelRequest.outputFormat: 'json'` (an `outputSchema` wins over it). Each adapter sends its provider's JSON mode; Claude, which has none, sends nothing and the prompt carries the request.

**Instead of:** an empty `outputSchema`, a wider `outputFormat` union replacing `outputSchema`, a MIME-type field, JSON mode on the ADK path only, emulating JSON mode on Claude

How it works: [Model contract](/models/model-contract.md)
