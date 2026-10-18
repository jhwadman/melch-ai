---
type: decision
title: "ADR 0047: One provider-neutral reasoning key, mapped to each provider's field"
description: "An agent states how hard it reasons with one portable `reasoning:` key, mapped to each provider's own field, rounding up where a level is missing."
tags:
  - decision
  - models
  - agents
status: stable
generated:
  by: claude-code/claude-opus-5-5
  at: 2026-10-18
sources:
  - resource: lib/compile.ts
  - resource: lib/syndicateSchema.ts
  - resource: lib/models/gptLlm.ts
  - resource: lib/models/grokLlm.ts
  - resource: lib/models/capabilities.ts
  - resource: tests/reasoningKey.test.ts
---

# ADR 0047: One provider-neutral reasoning key, mapped to each provider's field

**Decided (2026-10-07):** An agent states how hard it reasons with one portable key, `reasoning: none | low | medium | high | { budget_tokens }`, which is mapped to whatever field the agent's provider reads; the effort word is always written so a gateway-served id keeps its level. A level a provider lacks rounds up, never down, and the provider-specific spelling may not sit beside the key on one agent.

**Instead of:** translating only inside each adapter (then), writing only the provider's native field, refusing a budget on effort-only providers, mapping Kimi K3 `high` to `max`, letting `reasoning` override the older spelling

**Superseded by:** [ADR 0049](/decisions/0049-claude-requests-by-model-generation.md) (the Claude adapter reads the effort word on its adaptive generations); [ADR 0115](/decisions/0115-yaml-schema-v2-provider-neutral-keys.md) (v1 `thinkingConfig`/`reasoningEffort` deprecated); [ADR 0117](/decisions/0117-tool-choice-and-effort-above-high-in-v2.md) (`xhigh` and `max` become levels)

How it works: [Provider routing](/models/provider-routing.md)
