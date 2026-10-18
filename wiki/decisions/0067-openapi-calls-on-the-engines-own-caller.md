---
type: decision
title: "ADR 0067: The engine calls OpenAPI operations itself, with the guard as a parameter"
description: "The engine builds and sends each OpenAPI call by RestApiTool's rules, with the redirect policy passed to the call, one approval gate, and no call without a required credential."
tags:
  - decision
  - tools
  - security
status: stable
generated:
  by: claude-code/claude-opus-5-5
  at: 2026-10-18
sources:
  - resource: lib/tools/openapi/call.ts
  - resource: lib/tools/openapiTools.ts
  - resource: lib/net/redirects.ts
  - resource: lib/compile.ts
  - resource: tests/openapiTools.test.ts
  - resource: tests/redirects.test.ts
---

# ADR 0067: The engine calls OpenAPI operations itself, with the guard as a parameter

**Decided (2026-10-08):** The engine builds and sends each OpenAPI call itself, rule for rule as ADK's `RestApiTool`, with the redirect policy a parameter of the call instead of a patched global `fetch`. Each operation is an own Tool under the one gate every tool takes. An operation whose spec requires a credential the entry lacks is not called; credential values are redacted from errors and responses are read up to 8 MiB.

**Instead of:** keeping `RestApiTool` under the fetch wrapper, a cleaner request builder, the OpenAPI-only gate, raising `adk_request_credential`, calling without the credential, redacting the whole result

**Supersedes:** [ADR 0036](/decisions/0036-redirects-under-the-ssrf-guard.md) (the global `fetch` wrapper mechanism; its policy stands); [ADR 0063](/decisions/0063-openapi-parser-on-the-engines-own-types.md) (the call through `RestApiTool`)

How it works: [OpenAPI tools](/tools/openapi-tools.md)
