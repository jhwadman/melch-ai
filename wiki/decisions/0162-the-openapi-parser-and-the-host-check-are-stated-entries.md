---
type: decision
title: "ADR 0162: The OpenAPI parser and the host check are stated entries of the package"
description: "parseOpenApiSpec and isReadOperation are exported as melchizedek-agents/openapi, checkHost and blockedHostReason as melchizedek-agents/net, and both from the main entry; an operation carries its summary and readOnly."
tags:
  - decision
  - tools
  - security
status: stable
generated:
  by: claude-code/claude-opus-5-5
  at: 2026-11-22
sources:
  - resource: package.json
  - resource: lib/index.ts
  - resource: lib/tools/openapi/parse.ts
  - resource: lib/net/addressGuard.ts
  - resource: tests/packageSurface.test.ts
---

# ADR 0162: The OpenAPI parser and the host check are stated entries of the package

**Decided (2026-11-22):** `melchizedek-agents/openapi` (the parser) and `melchizedek-agents/net` (the address guard) are exact keys of the exports map, and the main entry re-exports `parseOpenApiSpec`, `isReadOperation`, `checkHost` and `blockedHostReason`, so a consumer can show a spec's operations as the tools they become and refuse a spec URL's host with the engine's own rules. An operation gains `summary` and `readOnly`; `isReadOperation` is the one read/write rule the compile also uses.

**Instead of:** leaving the parser reachable only through the `./tools/*` pattern; a consumer's own parser or guard; a separate listing type beside `OpenApiOperation`; the main entry only (it loads the whole engine)

How it works: [OpenAPI tools](/tools/openapi-tools.md)
