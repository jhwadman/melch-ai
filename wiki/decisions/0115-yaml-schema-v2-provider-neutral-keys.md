---
type: decision
title: "ADR 0115: YAML schema v2: provider-neutral sampling, output and model_overrides keys"
description: "An agent's YAML says sampling, output and per-provider instruction nuances in provider-neutral v2 keys that the loader maps onto the existing engine form, with generateContentConfig and outputSchema kept as a deprecated spelling and a codemod to migrate."
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
  - resource: lib/loadSyndicate.ts
  - resource: lib/compile.ts
  - resource: scripts/yaml_codemod.ts
  - resource: tests/agentDialect.test.ts
  - resource: tests/yamlCodemod.test.ts
---

# ADR 0115: YAML schema v2: provider-neutral sampling, output and model_overrides keys

**Decided (2026-10-09):** Add v2 keys (`sampling`, `output`, `model_overrides`) that the loader folds into the engine form the runtime already reads, so a migrated file compiles to the same AgentSpec. `generateContentConfig` and `outputSchema` stay as a deprecated spelling with one warning per file; a v2 key beside its v1 spelling is a load error; `melchizedek-codemod` migrates files, and every shipped YAML is migrated.

**Instead of:** translating in each adapter now, a byte-exact codemod for thinking settings, neutral keys for fields no provider receives, a per-provider config passthrough, removing v1 in 1.1.0, warning on every load

How it works: [Native loop: the agent](/overview/native-loop.md#the-agent)
