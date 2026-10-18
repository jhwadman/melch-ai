---
type: decision
title: "ADR 0059: Memory and its tools are the engine's own"
description: "The memory service implements the engine's MemoryService, tools recall through a context search bound to the run's own silo, and load_memory and preload_memory are own tools that write into the instruction."
tags:
  - decision
  - memory
  - tools
status: stable
generated:
  by: claude-code/claude-opus-5-5
  at: 2026-10-18
sources:
  - resource: lib/memory/supabaseMemoryService.ts
  - resource: lib/memory/namespace.ts
  - resource: lib/runtime/memoryService.ts
  - resource: lib/tools/tool.ts
  - resource: lib/tools/adkTool.ts
  - resource: lib/tools/memoryTools.ts
  - resource: lib/toolRegistry.ts
  - resource: tests/memoryTools.test.ts
---

# ADR 0059: Memory and its tools are the engine's own

**Decided (2026-10-07):** The memory service implements the engine's `MemoryService`. A tool recalls through `ToolContext.searchMemory`, bound to the run's own `<appName>/<userId>` silo. A Tool may add text to the system instruction, and an `InstructionTool` only does that; `load_memory` and `preload_memory` are such own tools, sending the model what ADK's sent word for word. Until 1.0.0 the service kept ADK's two method names as well.

**Instead of:** renaming the service's methods and adapting at the Runner, a separate adapter object, the whole service on the tool context, a per-run memory tool, memory as a special case in the loop, two parallel implementations, `preload_memory` with an empty declaration, an ADK `BaseTool` for `load_memory`

**Superseded by:** [ADR 0107](/decisions/0107-release-1-0-0-removes-adk.md) (ADK's method names removed)

How it works: [Tool contracts](/tools/tool-contracts.md)
