---
type: decision
title: 'ADR 0032: Any HTTP API with an OpenAPI spec becomes an agent''s tools through `openapi:`, read-only by default'
description: An agent's `openapi:` list turns OpenAPI 3 spec files into one tool per operation on ADK's OpenAPIToolset; the engine exposes only GET operations unless others are named, takes credentials from environment variables only, holds every server to the SSRF guard, lets require_approval gate a named operation, bounds results, and resolves spec paths beside the syndicate file.
tags:
  - decision
  - tools
status: stable
generated:
  by: claude-code/claude-opus-5-5
  at: 2026-10-02
sources:
  - resource: lib/tools/openapiTools.ts
  - resource: lib/compile.ts
  - resource: lib/loadSyndicate.ts
  - resource: lib/syndicateSchema.ts
  - resource: config/agents/examples/weather.yaml
  - resource: tests/openapiTools.test.ts
---

# ADR 0032: Any HTTP API with an OpenAPI spec becomes an agent's tools

## Context

An agent reached an HTTP API only through code: a `defineTool` per endpoint, registered, named in YAML; or an MCP server someone had to run. The owner's audit of ADK listed the OpenAPI toolset third, as the accessibility win: most APIs a product team wants an agent to use already publish a spec. ADK 2.2's `OpenAPIToolset` parses an OpenAPI 3 document into one `RestApiTool` per operation (parameters and request body as the schema, the summary as the description), applies bearer or API-key credentials, URL-encodes path parameters and refuses dot segments in them.

What it does not decide is exposure: it exposes every operation, calls whatever host the spec names, and returns whatever the API answers.

## Decision

1. **An `openapi:` list on any agent,** each entry a spec **file** (`.yaml`, `.yml`, `.json`) with optional `operations`, `auth`, `base_url` and `prefix`. Spec paths resolve beside the syndicate file (the loader anchors them), so a file copied with its specs works from any working directory; a registry definition has no file and resolves against the cwd.
2. **Read-only by default.** Without `operations`, only GET operations become tools. An operation that writes is exposed by naming it (by `operationId` or tool name), and a named operation may be listed under `require_approval`: the engine gates it with the same confirmation interrupt ADR 0028 uses, now available to OpenAPI tools as well as registry function tools.
3. **Secrets from the environment only.** `auth.bearer_env` or `auth.api_key: { env, in, name }` name a variable; the schema refuses anything that is not a variable name, and an unset variable fails the compile. A static credential is applied to the request and never written to session state (ADK stores only exchanged credentials; the tests hold it to that).
4. **The SSRF guard on every server.** http(s) only; at compile, the guard's literal rules (no DNS, so a build stays offline and a DNS hiccup cannot fail startup); before each call, the full check with DNS, which guards the connection actually made. `ALLOW_PRIVATE_OPENAPI=true` permits private hosts for local development, mirroring `ALLOW_PRIVATE_MCP`.
5. **Bounded results and readable failures.** A response over 20,000 characters is cut and marked; a network failure returns `{ error }` to the model instead of throwing into the runner.
6. **Files, never URLs.** A spec fetched at compile would be a second outbound surface, and a spec that changes under a running agent changes its tools without review.

> **Note (2026-10-08):** Since 0.20.0 the native runtime is the default ([ADR 0102](/decisions/0102-native-default-and-optional-adk-peer.md)). OpenAPI tools are built on the engine's own types and caller ([ADR 0063](/decisions/0063-openapi-parser-on-the-engines-own-types.md), [ADR 0067](/decisions/0067-openapi-calls-on-the-engines-own-caller.md)), and item 2's confirmation interrupt is raised by the native loop; ADK takes part only on the optional adk runtime, which 1.0.0 removes ([ADR 0045](/decisions/0045-own-runtime-behind-the-seam.md)).

## Alternatives considered

- **Expose every operation by default** (ADK's behaviour). Rejected: a spec's DELETE would reach the model the moment a file is pointed at.
- **Credentials in YAML.** Rejected for the same reason `XAI_COLLECTION_IDS` and the task store path are deployment config: a syndicate file is shared and committed.
- **The full SSRF check (DNS) at compile.** Rejected: no connection is made at compile, and it made the offline test suite depend on DNS.
- **Spec URLs.** Rejected in 6.

## Consequences

- An agent's API reach is one reviewable list in YAML: which specs, which operations, which variables.
- ADK logs a line per experimental class and method the first time each runs (about fifteen at the first OpenAPI agent's compile). They are ADK's, not errors.
- Example specs ship as `.json`: every reader that enumerates `config/agents/**/*.yaml` treats a YAML file there as a syndicate.
- Open: OAuth flows (ADK supports them through its credential request, which needs a client to complete), spec-level `servers` per path, and response-schema validation.
