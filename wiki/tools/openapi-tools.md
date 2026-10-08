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
  - resource: lib/tools/openapi/call.ts
  - resource: config/agents/examples/weather.yaml
  - resource: tests/openapiTools.test.ts
---

# OpenAPI tools

An agent's `openapi:` list points at OpenAPI 3 spec files, and each operation in them becomes a tool. The engine's parser, `lib/tools/openapi/parse.ts`, reads the spec into its own types ([ADR 0063](/decisions/0063-openapi-parser-on-the-engines-own-types.md)). Each operation gets a name, from its `operationId` in snake_case (`getForecast` → `get_forecast`, `<prefix>_` in front when the entry sets one, at most 60 characters). Its parameters and request body become the tool's arguments. Its `description`, or else its `summary`, is the text the model reads. Its `ToolDeclaration` is in lowercase JSON Schema. The parser follows ADK's OpenAPIToolset rules exactly, so the declarations match it, and the example specs' declarations are pinned in the tests.

Each operation is an own Tool (`buildOpenApiOwnTools`), which the native loop runs directly and the optional adk runtime runs through `toFunctionTool` (`buildOpenApiTools`). The engine's caller, `lib/tools/openapi/call.ts`, makes the call ([ADR 0067](/decisions/0067-openapi-calls-on-the-engines-own-caller.md)). It builds the request by ADK's RestApiTool rules, and a differential test holds the two equal:

- a path argument is URL-encoded whole, and `.` or `..` is refused, so the model chooses a segment, never the path;
- a query argument that is empty is left out;
- header and cookie arguments are sent as text;
- the body is encoded by the request body's first media type (JSON, form, multipart, octet-stream or plain text);
- the credential is applied after the arguments.

A status of 400 or more comes back as an error with the API's body. Any other body is its JSON, or else `{ text }`.

A spec is bounded, and a spec past any bound fails the compile with a readable error:

- 4 MiB on disk;
- 100 YAML aliases;
- a million values once its `$ref`s are resolved, since a ref used twice is copied twice;
- 128 levels of nesting, where following a ref counts as a level.

Only OpenAPI 3.x is read: a Swagger 2.0 spec, or one without an `openapi` version, fails the compile. A `$ref` is a JSON pointer (`~1` is `/`, `~0` is `~`). A ref cycle ends where it closes, and a ref to another file is refused. The [Weather](/agents/weather.md) example uses two hand-written subsets of Open-Meteo's keyless APIs.

Exposure is the engine's part ([ADR 0032](/decisions/0032-openapi-tools.md)). Without `operations`, only GET operations become tools; a write is exposed by naming it. A named operation can be listed under `require_approval`, by its operationId or its tool name, so a person approves each call ([ADR 0028](/decisions/0028-approval-gates.md)). It takes the gate every registry tool takes, with the same texts on both runtimes, and nothing is sent until the call is approved.

`auth` names an environment variable (`bearer_env`, or `api_key: { env, in, name }`), never a value. An unset variable fails the compile, and a credential is held by the tool, never stored in session state. Because the YAML (possibly registry-stored) chooses both the variable and the host, it may never name one of the framework's own settings (`credentialEnvProblem`: the `A2A_`, `SUPABASE_`, `DATABASE_`, provider and other prefixes, which a test checks against every variable in `.env.example`); `OPENAPI_CREDENTIAL_ENVS` makes the rule an exact allowlist ([ADR 0041](/decisions/0041-tool-vendors-get-least-privilege.md)). When an operation's spec requires a credential and the entry sets no `auth`, the call returns an error and sends nothing. A credential's value, plain or URL-encoded, is replaced with `[redacted]` in every error the model reads.

Every server must be http(s) and pass `lib/net/addressGuard.ts`: its literal rules at compile, the full check with DNS before each call. `ALLOW_PRIVATE_OPENAPI=true` permits private hosts for local development. A call follows redirects by hand under `lib/net/redirects.ts` ([ADR 0036](/decisions/0036-redirects-under-the-ssrf-guard.md)). A hop on the same origin gets the server's own check. A hop to another origin must pass the full guard (with no development exception) and keeps only content-negotiation headers, so a credential never follows it. More than five hops is an error. At most 8 MiB of a response is read, a result over 20,000 characters is cut and marked, and a network failure returns an error to the model. The turn's abort signal reaches the request.

Specs are files, resolved beside the syndicate file, never URLs. Trim a spec to the operations the agent needs and write each `summary` for the model: it is the tool's only prompt.
