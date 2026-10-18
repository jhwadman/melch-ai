---
type: decision
title: "ADR 0051: Tools are the engine's own, with a delta-aware context"
description: "A tool is the engine's own name, declaration and execute; its context shows session state as a view whose writes land in a delta, and defineTool returns such a Tool."
tags:
  - decision
  - tools
status: stable
generated:
  by: claude-code/claude-opus-5-5
  at: 2026-10-18
sources:
  - resource: lib/tools/tool.ts
  - resource: lib/tools/toolContract.ts
  - resource: lib/tools/adkTool.ts
  - resource: lib/toolRegistry.ts
  - resource: tests/toolContract.test.ts
---

# ADR 0051: Tools are the engine's own, with a delta-aware context

**Decided (2026-10-07):** A tool is the engine's own `Tool` (a name, a contract `ToolDeclaration`, `execute(args, ctx)`). Its context shows session state as a view that reads its own writes and records every write in `stateDelta`, applied with the result. `defineTool` returns a Tool that is still a `ToolContract` and validates arguments first. Result capping is opt-in. Until 1.0.0 one wrapper module turned a Tool into an ADK `FunctionTool`.

**Instead of:** a frozen state snapshot plus a writable delta, state changes returned with the result, handing tools ADK's `Context`, a separate `toTool(contract)`, a `run` method beside `execute`, re-exporting `toFunctionTool` from `toolContract.ts`, a default 20,000-character cap

**Superseded by:** [ADR 0059](/decisions/0059-memory-on-the-engines-own-interfaces.md) (the `load_memory` exception closed); [ADR 0062](/decisions/0062-server-side-tools-as-markers.md) (server-side tools, MCP and remote-agent tools); [ADR 0107](/decisions/0107-release-1-0-0-removes-adk.md) (the ADK wrapper deleted)

How it works: [Tool contracts](/tools/tool-contracts.md)
