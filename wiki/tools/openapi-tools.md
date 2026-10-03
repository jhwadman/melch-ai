---
type: tool
title: OpenAPI tools
description: "The `openapi:` agent key: an HTTP API with an OpenAPI 3 spec file becomes one tool per operation — GET operations unless others are named, credentials from environment variables, every server held to the SSRF guard, results bounded."
tags:
  - tools
status: stable
generated:
  by: claude-code/claude-opus-5-5
  at: 2026-10-02
sources:
  - resource: lib/tools/openapiTools.ts
  - resource: config/agents/examples/weather.yaml
  - resource: tests/openapiTools.test.ts
---

# OpenAPI tools

An agent's `openapi:` list points at OpenAPI 3 spec files, and each operation in them becomes a tool through ADK's `OpenAPIToolset`: named from its `operationId` in snake_case (`getForecast` → `get_forecast`), its parameters and request body the tool's arguments, its `summary` the description the model reads. The [Weather](/agents/weather.md) example uses two hand-written subsets of Open-Meteo's keyless APIs.

Exposure is the engine's part ([ADR 0032](/decisions/0032-openapi-tools.md)). Without `operations`, only GET operations become tools; a write is exposed by naming it, and a named operation can be listed under `require_approval` so a person approves each call ([ADR 0028](/decisions/0028-approval-gates.md)). `auth` names an environment variable (`bearer_env`, or `api_key: { env, in, name }`), never a value; an unset variable fails the compile, and a static token is never stored in session state. Every server must be http(s) and pass `lib/net/addressGuard.ts`: its literal rules at compile, the full check with DNS before each call; `ALLOW_PRIVATE_OPENAPI=true` permits private hosts for local development. A result over 20,000 characters is cut and marked; a network failure returns an error to the model.

Specs are files, resolved beside the syndicate file, never URLs. Trim a spec to the operations the agent needs and write each `summary` for the model: it is the tool's only prompt.
