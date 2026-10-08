---
type: tool
title: OpenAPI tools
description: "The `openapi:` agent key: an HTTP API with an OpenAPI 3 spec file becomes one tool per operation — GET operations unless others are named, credentials from environment variables, every server held to the SSRF guard, results bounded."
tags:
  - tools
status: stable
generated:
  by: claude-code/claude-opus-5-5
  at: 2026-10-08
sources:
  - resource: lib/tools/openapiTools.ts
  - resource: lib/tools/openapi/parse.ts
  - resource: config/agents/examples/weather.yaml
  - resource: tests/openapiTools.test.ts
---

# OpenAPI tools

An agent's `openapi:` list points at OpenAPI 3 spec files, and each operation in them becomes a tool. The engine's parser, `lib/tools/openapi/parse.ts`, reads the spec into its own types ([ADR 0063](/decisions/0063-openapi-parser-on-the-engines-own-types.md)). Each operation gets a name, from its `operationId` in snake_case (`getForecast` → `get_forecast`, `<prefix>_` in front when the entry sets one, at most 60 characters). Its parameters and request body become the tool's arguments. Its `description`, or else its `summary`, is the text the model reads. Its `ToolDeclaration` is in lowercase JSON Schema. The parser follows ADK's OpenAPIToolset rules exactly, so the declarations match it, and the example specs' declarations are pinned in the tests. During the dual-runtime period, each operation is called through ADK's `RestApiTool`, built from the parse.

A spec is bounded, and a spec past any bound fails the compile with a readable error:

- 4 MiB on disk;
- 100 YAML aliases;
- a million values once its `$ref`s are resolved, since a ref used twice is copied twice;
- 128 levels of nesting, where following a ref counts as a level.

A ref cycle ends where it closes, and a ref to another file is refused. The [Weather](/agents/weather.md) example uses two hand-written subsets of Open-Meteo's keyless APIs.

Exposure is the engine's part ([ADR 0032](/decisions/0032-openapi-tools.md)). Without `operations`, only GET operations become tools; a write is exposed by naming it, and a named operation can be listed under `require_approval` so a person approves each call ([ADR 0028](/decisions/0028-approval-gates.md)). `auth` names an environment variable (`bearer_env`, or `api_key: { env, in, name }`), never a value; an unset variable fails the compile, and a static token is never stored in session state. Because the YAML (possibly registry-stored) chooses both the variable and the host, it may never name one of the framework's own settings (`credentialEnvProblem`: the `A2A_`, `SUPABASE_`, `DATABASE_`, provider and other prefixes, which a test checks against every variable in `.env.example`); `OPENAPI_CREDENTIAL_ENVS` makes the rule an exact allowlist ([ADR 0041](/decisions/0041-tool-vendors-get-least-privilege.md)). Every server must be http(s) and pass `lib/net/addressGuard.ts`: its literal rules at compile, the full check with DNS before each call; `ALLOW_PRIVATE_OPENAPI=true` permits private hosts for local development. ADK's call uses `globalThis.fetch`, which follows redirects, so each call runs under `lib/net/redirects.ts`: redirects are followed one hop at a time, a hop on the same origin gets the server's own check, and a hop to another origin must pass the full guard (with no development exception) and keeps only content-negotiation headers, so a credential never follows it. More than five hops is an error. A result over 20,000 characters is cut and marked; a network failure returns an error to the model.

Specs are files, resolved beside the syndicate file, never URLs. Trim a spec to the operations the agent needs and write each `summary` for the model: it is the tool's only prompt.
