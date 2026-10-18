---
type: decision
title: "ADR 0062: Server-side tools are markers; MCP, remote-agent and examples tools are own"
description: "Server-side tools are NativeToolMarkers detected by a global symbol; MCP tools, the remote A2A agent tool and an agent's examples are the engine's own tools."
tags:
  - decision
  - tools
status: stable
generated:
  by: claude-code/claude-opus-5-5
  at: 2026-10-18
sources:
  - resource: lib/tools/tool.ts
  - resource: lib/tools/nativeTools.ts
  - resource: lib/tools/adkTool.ts
  - resource: lib/tools/webSearchTool.ts
  - resource: lib/tools/xSearchTool.ts
  - resource: lib/tools/urlContextTool.ts
  - resource: lib/tools/collectionsSearchTool.ts
  - resource: lib/tools/mcpToolFactory.ts
  - resource: lib/tools/examples.ts
  - resource: lib/a2a/remoteAgent.ts
  - resource: lib/models/schemaNormalize.ts
  - resource: lib/toolRegistry.ts
  - resource: lib/compile.ts
  - resource: tests/toolBaseRest.test.ts
  - resource: tests/capabilityMatrix.test.ts
---

# ADR 0062: Server-side tools are markers; MCP, remote-agent and examples tools are own

**Decided (2026-10-08):** `web_search`, `x_search`, `url_context`, `collections_search` and `google_search` are `NativeToolMarker`s that declare no function and carry their `NativeTool` under a global symbol; every reader detects the marker, never a class or shape. MCP tools and the remote A2A agent tool are own Tools whose schema passes through one conversion, and an agent's `examples:` is an InstructionTool writing ExampleTool's block word for word.

**Instead of:** detection by name and shape, an own Tool with an empty declaration, moving the sentinel classes into `adkTool.ts`, keeping MCP's own Gemini conversion, folding examples into the compiled instruction

**Superseded by:** [ADR 0107](/decisions/0107-release-1-0-0-removes-adk.md) (the ADK sentinels and wrappers removed)

How it works: [Tool contracts](/tools/tool-contracts.md)
