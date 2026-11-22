---
type: decision
title: "ADR 0164: Registered tools are described by their shape, with one known condition"
description: "registeredTools() gives each registered tool's name, description and kind (function, conditional, provider, instruction, toolset), read from the tool itself; run_code alone carries a condition."
tags:
  - decision
  - tools
status: stable
generated:
  by: claude-code/claude-opus-5-5
  at: 2026-11-22
sources:
  - resource: lib/toolRegistry.ts
  - resource: tests/toolContract.test.ts
---

# ADR 0164: Registered tools are described by their shape, with one known condition

**Decided (2026-11-22):** `registeredTools()` describes every registered tool from what the registry holds: its kind from the tool's shape (a Tool, a NativeToolMarker, an InstructionTool, a Toolset), its description from the tool itself, and a `conditional` kind with its `condition` only where the registry knows one by identity (its own `run_code`, the code sandbox switch).

**Instead of:** three kinds, folding instruction tools and toolsets into function; kinds by name; metadata written beside each built-in (the keys a tool reads, the providers a marker runs on)

**Open:** which providers run a given marker, and the keys a function tool needs, are not listed

How it works: [Tool contracts](/tools/tool-contracts.md#exposure-is-deliberate)
