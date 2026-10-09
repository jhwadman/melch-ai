---
type: decision
title: "ADR 0112: OAuth grants are declared beside the tool they protect, and an authorization-code MCP server is reached on each user's own connection"
description: "An OpenAPI entry's auth.oauth2 and an MCP server's mcp_auth.oauth2 name a provider, a grant (authorization_code or client_credentials), its endpoints and scopes, and the client id and secret as environment variable names. authorization_code reads the run's user's token through ctx.accessToken, so the consent pause asks for it; client_credentials holds the server's own token in process memory. An authorization-code MCP server lists nothing at startup: mcp_tools names its tools, each runs on its user's own connection, and the parameters come from the first listing. The consent step's clients are built from the same YAML, and the doctor lists every tool that needs a grant. A provider block of its own, client config in code only, a startup listing with the server's token, a connect tool and per-user toolsets were rejected."
tags:
  - decision
  - tools
  - security
  - protocols
status: stable
generated:
  by: claude-code/claude-opus-5-5
  at: 2026-10-09
sources:
  - resource: lib/tools/oauthTools.ts
  - resource: lib/tools/credentialEnv.ts
  - resource: lib/tools/openapiTools.ts
  - resource: lib/tools/mcpToolFactory.ts
  - resource: lib/syndicateSchema.ts
  - resource: lib/doctor.ts
  - resource: config/agents/templates/systems_operator.yaml
  - resource: tests/oauthTools.test.ts
---

# ADR 0112: OAuth grants are declared beside the tool they protect, and an authorization-code MCP server is reached on each user's own connection

## Context

[ADR 0072](/decisions/0072-tool-credentials-sealed-per-user.md) gave tools a sealed per-user token store and `ctx.accessToken(provider)`. [ADR 0085](/decisions/0085-oauth-consent-pauses-on-adks-credential-request.md) gave the turn a consent pause that puts a grant there. Neither said which tool sends which provider's token. A tool had to be written in code to call `accessToken`, and the consent step's OAuth clients were configured in code too. An OpenAPI entry or an MCP server, the two ways a YAML reaches someone else's API, had only static secrets: `bearer_env`, `api_key`, `MCP_BEARER_TOKENS`.

Three constraints shape the YAML:

- **Secrets stay out of it.** A YAML may be registry-stored. It names variables, never values, and may not name one of the framework's own (`credentialEnvProblem`, [ADR 0041](/decisions/0041-tool-vendors-get-least-privilege.md)).
- **Two grants.** A tool that acts for a person needs that person's token (authorization code, through consent). A tool that acts as the deployment needs the deployment's own (client credentials).
- **An MCP server lists its tools over the same protected connection.** With a per-user token, no token exists when the agent compiles.

## Decision

1. **The grant sits beside the tool.** An OpenAPI entry's `auth` gains a third form, `oauth2`, exclusive with `bearer_env` and `api_key`. An agent gains `mcp_auth: { oauth2 }` beside `mcp_server_url`, which replaces `MCP_BEARER_TOKENS` for that server. Both take the same block: `provider` (the credential store's name), `grant`, `authorization_url` (authorization code only), `token_url`, `client_id` or `client_id_env`, `client_secret_env` (required for client credentials), `scopes`, and `authorization_params` (authorization code only, never a reserved parameter). The schema checks each rule with the key path.
2. **authorization_code reads the run's user's token at each call** through `ctx.accessToken(provider)`. A user who has not granted it is asked by the consent pause, unchanged. Without a credential store the call answers `unavailable`.
3. **client_credentials is the server's own token**, fetched from the token endpoint and held in process memory until 60 s before it expires, one request at a time. It never enters the credential store, since no user owns it. No redirect is followed, the request has a time limit and a response bound, and the endpoint passes the SSRF guard (`ALLOW_PRIVATE_OPENAPI` or `ALLOW_PRIVATE_MCP` for development). A refusal is `grant_failed`, never the provider's text. An unset variable fails the compile, naming the variable.
4. **A token goes only over https**, or http to a loopback host, to the server the YAML names.
5. **An authorization-code MCP server lists nothing at startup.** `mcp_tools` is required and names its tools. Each runs on its user's own connection, keyed by app and user, its requests carrying that user's current token, at most 64 per server, the least recently used closed first. The parameters come from the first listing any user's connection makes. Until then a tool declares none, and its first call connects and tells the model to call again with the parameters it now has.
6. **The consent step's clients come from the same YAML.** `oauthClientsFor(configs)` returns `oauthConsent({ providers })`'s map from the authorization-code blocks, reading ids and secrets from their variables. Two declarations of one provider must agree. `oauthRefreshProviders(clients)` gives the credential store the matching refresh hooks (RFC 6749 6), so an expired grant is renewed rather than asked for again.
7. **The doctor lists every tool that needs a grant**: the agent, the provider, the grant, the scopes and which variables are unset, names only.

> **Note (2026-10-09):** [ADR 0118](/decisions/0118-skill-scripts-and-oauth-consent-inside-delegated-subagents.md) lets a delegated subagent's authorization-code tool ask for consent: the pause reaches the turn through the open call, and the next message after the grant resumes the subagent's call. The Consequences line saying only the orchestrator or a dispatch route raises the consent pause no longer holds, and the systems_operator template's comment says so.

## Alternatives considered

- **A syndicate-level `oauth_providers:` block that tools reference by name.** Rejected for now. It keeps one provider in one place, but splits a tool from its grant across the file, and the doctor and the reader then join two places. Rule 6's agreement check gives the one-provider guarantee without it.
- **Client configuration in code only** (the host builds `oauthConsent`'s providers). Rejected as the only way: the YAML would name a provider whose endpoints live elsewhere, and a template could not declare a working grant. `oauthConsent` still takes any map, so a host may write its own.
- **List an authorization-code MCP server at startup with a server token.** Rejected. It needs a second credential for every server, and a user's grant may expose different tools from the server's.
- **A `connect_<provider>` tool, or a toolset that lists each user's tools per request.** Rejected. A connect tool puts the model in an authorization decision ADR 0085 kept it out of. A per-user toolset needs credentials in the toolset context, which reaches into the native loop and its parity suites, for a gain the named tools already give.
- **Call the server blind with whatever arguments the first call carried.** Rejected. A write with guessed arguments is worse than one extra model step.
- **Client-credentials tokens in the credential store under a server user.** Rejected. The store's keys and erasure are per end user, and a server token sealed there would be erased with nobody.

## Consequences

- `tests/oauthTools.test.ts` drives authorization code through consent to a mock MCP server that refuses any request without a valid bearer, and client credentials against a mock token endpoint, for MCP and OpenAPI. It also covers the schema, the consent clients and the doctor.
- The consent pause is raised only by an agent the turn runs directly: the orchestrator, or a dispatch route. In a delegate syndicate such as the systems_operator template, a subagent's authorization-code tool reads a grant the person made elsewhere but cannot ask for one. The template's commented block therefore shows client credentials.
- The token goes to the host the YAML names: the trust `bearer_env` already gives a YAML. A registry-stored YAML that names a provider another syndicate's users granted, and a host of its own, under the same memory namespace, could receive those users' tokens. Binding a provider to its hosts is an open question for the owner.
- An authorization-code MCP server's declarations are the first listing's, shared by every user of that compiled agent.
