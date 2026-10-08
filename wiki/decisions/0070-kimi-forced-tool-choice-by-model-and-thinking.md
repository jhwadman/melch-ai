---
type: decision
title: "ADR 0070: Kimi forces a tool choice per model and per thinking, and a refused named choice falls to required"
description: "The chat-completions base asks a subclass which forced tool choices it honours for the model and the request's reasoning, since Moonshot refuses forcing only while a model thinks. KimiAdapter follows the live check of 2026-10-08: kimi-k3 sends required as asked and a named tool as required; kimi-k2.6 forces both only under reasoning none; other Kimi ids weaken both to auto. A named choice the provider refuses falls to required where required holds, else to auto. Weakening K3's named choice to auto, a Kimi-only rule, and switching K2.6's thinking off to honour a forced choice were rejected."
tags:
  - decision
  - models
  - moonshot
status: stable
generated:
  by: claude-code/claude-opus-5-5
  at: 2026-10-08
sources:
  - resource: lib/models/kimiAdapter.ts
  - resource: lib/models/chatCompletionsAdapter.ts
  - resource: lib/models/contract.ts
  - resource: tests/chatCompletionsAdapter.test.ts
---

# ADR 0070: Kimi forces a tool choice per model and per thinking, and a refused named choice falls to required

## Context

The contract's `toolChoice` is a preference ([ADR 0048](/decisions/0048-engine-owned-model-contract.md)): an adapter sends it as asked where the provider allows and weakens it where the provider refuses, marking `llm.tool_choice.weakened`. The [chat-completions adapters](/models/chat-completions-adapters.md) ([ADR 0057](/decisions/0057-chat-completions-shims-keep-the-adk-shape.md)) asked each subclass for the modes it honours per model, and `KimiAdapter` weakened `required` and a named tool to auto until Moonshot was checked.

The orchestrator checked Moonshot live on 2026-10-08 (PR #87):

- `kimi-k3` honours `tool_choice: "required"` with thinking on. It refuses a named tool with thinking on (400 "tool_choice 'specified' is incompatible with thinking enabled") and ignores one with thinking off. K3 always thinks.
- `kimi-k2.6` refuses both forced modes with thinking on (400) and honours both with it off. Its thinking is on by default and switchable (`thinking: { type: 'disabled' }` under `reasoning: none`).

So what Moonshot honours depends on whether the model thinks, which the request's reasoning decides, and the hook knew only the model.

## Decision

1. **The hook takes the reasoning.** `toolChoiceModes(model, reasoning)` in `lib/models/chatCompletionsAdapter.ts` receives the request's `ReasoningSetting`. Subclasses that ignore it (the gateway, Ollama) are unchanged.
2. **A refused named choice falls to `required` where `required` holds**, else to auto, and the span is marked `named` either way. A named choice asks for a forced call of one tool; `required` keeps the forced call, of some declared tool, which is closer than auto. The rule sits in the base, so it holds for any subclass that honours `required` without `named`; today that is only Kimi K3.
3. **KimiAdapter per model.** `kimi-k3` honours auto, none and `required`, so a named tool goes as `required`. `kimi-k2.6` honours all four when the request's reasoning is `none` (or a budget of 0), which also sends `thinking: disabled`, and auto and none otherwise. Other ids (`kimi-k2.7-code` and its highspeed variant, unchecked and always thinking) honour auto and none.

## Alternatives considered

- **Weaken K3's named choice to auto**, as every other refusal. Rejected: K3 honours `required`, and a request that names a tool wants a forced call; auto lets the model answer in text instead.
- **A Kimi-only override of the body** in place of a base rule. Rejected: the base already owns the weakening and its span mark, and the rule is provider-neutral; a second weakening path would need its own mark.
- **Turn K2.6's thinking off whenever a forced choice is asked**, so the choice is always honoured. Rejected: the agent's `reasoning:` is its own setting, and silently dropping thinking changes the answer more than weakening the choice does. An agent that needs a forced call on K2.6 sets `reasoning: none`.
- **Honour forcing on K2.7 Code by analogy with K3.** Rejected until it is checked live; it stays weakened, which is safe.

## Consequences

- A K3 agent asking for a named tool gets a forced call of some declared tool; with one tool declared that is the named tool.
- A K2.6 agent forces a tool only at `reasoning: none`; at any other setting the span shows the choice was weakened.
- A provider whose forced-choice support depends on thinking states it through the same hook.
