---
type: decision
title: "ADR 0161: Tool credentials a YAML names are read through the credential source"
description: "An OpenAPI bearer_env or api_key.env, and an oauth2 block's client_id_env and client_secret_env, are read by name through setCredentialSource before process.env, after the same allowlist check."
tags:
  - decision
  - tools
  - security
status: stable
generated:
  by: claude-code/claude-opus-5-5
  at: 2026-11-22
sources:
  - resource: lib/tools/credentialEnv.ts
  - resource: lib/tools/openapiTools.ts
  - resource: lib/tools/oauthTools.ts
  - resource: tests/openapiTools.test.ts
  - resource: tests/oauthTools.test.ts
---

# ADR 0161: Tool credentials a YAML names are read through the credential source

**Decided (2026-11-22):** Every credential variable a YAML names for a tool (an OpenAPI entry's `bearer_env` or `api_key.env`, an `oauth2` block's `client_id_env` and `client_secret_env`) is read through the credential source and then the environment, after `credentialEnvProblem`, as provider keys and `pass_env` are. An OpenAPI static credential is read at compile and again before each call; an OAuth client secret stays read once, at compile.

**Instead of:** the environment only for tool credentials; the source for OpenAPI keys but not OAuth client secrets; reading an OpenAPI key at compile only

**Open:** a client-credentials grant reads its secret again only when its tools compile again

How it works: [OpenAPI tools](/tools/openapi-tools.md), [Tool contracts](/tools/tool-contracts.md#grants-declared-in-yaml)
