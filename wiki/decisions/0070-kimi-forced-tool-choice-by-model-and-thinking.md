---
type: decision
title: "ADR 0070: Kimi forces a tool choice per model and thinking; refused named falls to required"
description: "Which forced tool choices Kimi honours depends on the model and the request's reasoning, and a refused named choice falls to required where required holds."
tags:
  - decision
  - models
  - moonshot
status: stable
generated:
  by: claude-code/claude-opus-5-5
  at: 2026-10-18
sources:
  - resource: lib/models/kimiAdapter.ts
  - resource: lib/models/chatCompletionsAdapter.ts
  - resource: lib/models/contract.ts
  - resource: tests/chatCompletionsAdapter.test.ts
---

# ADR 0070: Kimi forces a tool choice per model and thinking; refused named falls to required

**Decided (2026-10-08):** The chat-completions base asks each subclass which forced tool choices it honours for the model and the request's reasoning. A refused named choice falls to `required` where `required` holds, else to auto. Kimi follows the live check of 2026-10-08: K3 sends a named tool as `required`; K2.6 forces only under `reasoning: none`; other Kimi ids weaken both to auto.

**Instead of:** weakening K3's named choice to auto, a Kimi-only body override, turning K2.6's thinking off to honour a forced choice, honouring forcing on K2.7 Code by analogy

**Open:** live check of forced tool choice on `kimi-k2.7-code`

How it works: [Chat-completions adapters](/models/chat-completions-adapters.md)
