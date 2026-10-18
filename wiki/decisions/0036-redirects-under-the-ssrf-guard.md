---
type: decision
title: "ADR 0036: OpenAPI calls follow redirects one hop at a time, under the SSRF guard"
description: "Each redirect hop of an OpenAPI call is checked before it is fetched: same-origin hops under the server's rule, cross-origin hops under the full guard without credentials."
tags:
  - decision
  - tools
  - security
status: stable
generated:
  by: claude-code/claude-opus-5-5
  at: 2026-10-18
sources:
  - resource: lib/net/redirects.ts
  - resource: lib/tools/openapiTools.ts
  - resource: tests/redirects.test.ts
  - resource: tests/openapiTools.test.ts
---

# ADR 0036: OpenAPI calls follow redirects one hop at a time, under the SSRF guard

**Decided (2026-10-06):** OpenAPI calls follow redirects by hand, one hop at a time. A same-origin hop gets the server's own rule, and a cross-origin hop must pass the full SSRF guard with no development exception and is sent without credentials.

**Instead of:** refusing every redirect, re-implementing ADK's `RestApiTool`, swapping `globalThis.fetch` for the duration of a call
**Superseded by:** [ADR 0067](/decisions/0067-openapi-calls-on-the-engines-own-caller.md) (the context-scoped fetch wrapper is retired; the engine's own caller applies the same policy)
**Open:** DNS rebinding between the check and the connect

How it works: [OpenAPI tools](/tools/openapi-tools.md)
