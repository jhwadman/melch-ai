---
type: decision
title: "ADR 0117: tool_choice and the effort levels xhigh and max get v2 keys"
description: "tool_choice and reasoning levels xhigh and max became v2 YAML keys, a level above a model's ceiling is sent as its highest and marked weakened, and includeThoughts got no v2 key."
tags:
  - decision
  - agents
  - models
status: stable
generated:
  by: claude-code/claude-opus-5-5
  at: 2026-10-18
sources:
  - resource: lib/agentDialect.ts
  - resource: lib/syndicateSchema.ts
  - resource: lib/models/contract.ts
  - resource: lib/models/reasoning.ts
  - resource: lib/models/genaiMapping.ts
  - resource: lib/models/capabilities.ts
  - resource: lib/models/chatCompletionsAdapter.ts
  - resource: lib/models/gatewayAdapter.ts
  - resource: lib/models/kimiAdapter.ts
  - resource: lib/models/gptAdapter.ts
  - resource: lib/models/grokAdapter.ts
  - resource: lib/models/claudeAdapter.ts
  - resource: lib/models/geminiAdapter.ts
  - resource: scripts/yaml_codemod.ts
  - resource: tests/toolChoiceEffort.test.ts
  - resource: tests/yamlCodemod.test.ts
---

# ADR 0117: tool_choice and the effort levels xhigh and max get v2 keys

**Decided (2026-10-09):** An agent spells its tool choice as `tool_choice:` (`auto | none | required | { name }`) and may ask for `reasoning: xhigh | max`; a level a model lacks is sent as its highest setting and marked `llm.reasoning.weakened`, not refused. `includeThoughts`, read by nothing, gets no v2 key and the codemod drops it.

**Instead of:** a `{ only: [names] }` list, refusing a level a model lacks, clamping at compile time, a v2 key for `includeThoughts`, raising budgets above 16,384, a per-provider passthrough

How it works: [Provider routing](/models/provider-routing.md)
