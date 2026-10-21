---
type: decision
title: "ADR 0076: The native loop opens its own spans; the ledger reads both naming schemes"
description: "The native loop opens its own agent, model-call and tool spans in its own scope, and the ledger's readers accept both its names and ADK's."
tags:
  - decision
  - runtime
  - observability
status: stable
generated:
  by: claude-code/claude-opus-5-5
  at: 2026-10-18
sources:
  - resource: lib/runtime/native/telemetry.ts
  - resource: lib/runtime/native/agentLoop.ts
  - resource: lib/observability/lineage.ts
  - resource: lib/observability/tracer.ts
  - resource: lib/observability/supabaseSpanExporter.ts
  - resource: tests/nativeLedger.test.ts
---

# ADR 0076: The native loop opens its own spans; the ledger reads both naming schemes

**Decided (2026-10-08):** The loop opens `agent.invoke <name>`, `model.call` and `tool.execute <name>` in scope `melchizedek.runtime`, nested as ADK's spans were and carrying `gen_ai.*` attributes, and `lib/observability/lineage.ts` reads both naming schemes. A step's payload row comes from the engine's own `llm.payload.*` attributes, only for a call that did not fail.

**Instead of:** reusing ADK's span names and scope, recording ADK's request shape, a payload on every model.call, one model.call per leaf call
**Superseded by:** [ADR 0139](/decisions/0139-the-ledger-keeps-the-span-tree.md) (tool spans now carry their arguments and the start of their result)

How it works: [Native loop](/overview/native-loop.md)
