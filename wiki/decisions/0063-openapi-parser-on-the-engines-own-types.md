---
type: decision
title: "ADR 0063: The engine parses OpenAPI specs itself, by ADK's rules, with bounds"
description: "The engine's own OpenAPI parser reproduces ADK 2.2's naming and declaration rules exactly and bounds a spec's size, aliases, resolved values and depth."
tags:
  - decision
  - tools
status: stable
generated:
  by: claude-code/claude-opus-5-5
  at: 2026-10-18
sources:
  - resource: lib/tools/openapi/parse.ts
  - resource: lib/tools/openapiTools.ts
  - resource: tests/openapiTools.test.ts
---

# ADR 0063: The engine parses OpenAPI specs itself, by ADK's rules, with bounds

**Decided (2026-10-08):** The engine parses OpenAPI specs itself into its own operations and `ToolDeclaration`s, reproducing ADK 2.2's naming, argument and declaration rules exactly, quirks included, so no tool name or declaration changes. A spec is bounded (size, YAML aliases, resolved values, depth), and YAML is read with the package's own `yaml` reader.

**Instead of:** declaring a cleaner schema, keeping `OpenAPIToolset` as the parser, parsing twice side by side, depending on js-yaml

**Superseded by:** [ADR 0067](/decisions/0067-openapi-calls-on-the-engines-own-caller.md) (the call leaves ADK's `RestApiTool`; ref escapes and Swagger 2 refusal closed)

**Open:** declaration clean-ups (empty-object placeholder, query parameter descriptions, nullable types, the extra `object` beside `anyOf`)

How it works: [OpenAPI tools](/tools/openapi-tools.md)
