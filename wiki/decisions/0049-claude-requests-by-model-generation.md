---
type: decision
title: "ADR 0049: Claude requests follow the model generation"
description: "The Claude adapter shapes each request from a per-generation table keyed by the model id, so one reasoning setting works on every Claude model."
tags:
  - decision
  - models
status: stable
generated:
  by: claude-code/claude-opus-5-5
  at: 2026-10-18
sources:
  - resource: lib/models/claudeModels.ts
  - resource: lib/models/claudeLlm.ts
  - resource: lib/models/capabilities.ts
  - resource: tests/claudeCurrentApi.test.ts
  - resource: tests/capabilityMatrix.test.ts
---

# ADR 0049: Claude requests follow the model generation

**Decided (2026-10-07):** The Claude adapter reads a per-generation table keyed by the model id (unknown ids get the newest row): a thinking budget on Claude 4.6 and earlier, adaptive thinking with an effort word after, each model's own off switch for `none` (adaptive at `low` on Opus 5), `output_config.format` for structured output where documented, `drop_block` on every request to conversation-bound models so a resumed turn degrades instead of failing, and URL images dropped on Bedrock and Vertex AI.

**Instead of:** leaving a paused turn's events untrimmed, dropping replay after an elided result, a client-side prefix digest, sorted-key tool results, fetching URL images server-side, `none` as `low` effort everywhere, moving the 4.6 models to adaptive now

**Supersedes:** [ADR 0047](/decisions/0047-provider-neutral-reasoning-key.md) (that the Claude adapter never reads the effort word)

**Superseded by:** [ADR 0109](/decisions/0109-structured-output-beside-tools.md) (a schema beside tools)

**Open:** moving Claude 4.6 models to adaptive thinking; a prefix digest if lost reasoning on resumed turns shows in quality; live confirmation of the behaviour verified only against documentation

How it works: [Claude adapter](/models/claude-adapter.md)
