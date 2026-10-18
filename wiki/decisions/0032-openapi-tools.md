---
type: decision
title: "ADR 0032: An OpenAPI spec file becomes an agent's tools, read-only by default"
description: "An agent's openapi: list turns OpenAPI 3 spec files into one tool per operation, GET only unless others are named, with credentials from environment variables and every server under the SSRF guard."
tags:
  - decision
  - tools
status: stable
generated:
  by: claude-code/claude-opus-5-5
  at: 2026-10-18
sources:
  - resource: lib/tools/openapiTools.ts
  - resource: lib/compile.ts
  - resource: lib/loadSyndicate.ts
  - resource: lib/syndicateSchema.ts
  - resource: config/agents/examples/weather.yaml
  - resource: tests/openapiTools.test.ts
---

# ADR 0032: An OpenAPI spec file becomes an agent's tools, read-only by default

**Decided (2026-10-02):** An agent's `openapi:` list turns local OpenAPI 3 spec files into one tool per operation. Only GET operations are exposed unless others are named. Credentials come from environment variables only, and every server is held to the SSRF guard.

**Instead of:** exposing every operation, credentials in YAML, the full SSRF check with DNS at compile, spec URLs
**Superseded by:** [ADR 0063](/decisions/0063-openapi-parser-on-the-engines-own-types.md) and [ADR 0067](/decisions/0067-openapi-calls-on-the-engines-own-caller.md) (the engine's own parser and caller replace ADK's toolset), [ADR 0112](/decisions/0112-oauth-grants-declared-beside-the-tool.md) (OAuth grants)
**Open:** per-path `servers` (only `servers[0]` is read); response-schema validation

How it works: [OpenAPI tools](/tools/openapi-tools.md)
