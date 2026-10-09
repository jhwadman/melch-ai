---
type: decision
title: "ADR 0114: OAuth tokens go only to hosts the operator binds to their provider, and the server binary wires tool credentials from the environment"
description: "An operator allowlist (MELCHIZEDEK_OAUTH_HOSTS, or createA2AApp's oauthHosts) binds each provider to the hosts its tokens and client secret may be sent to. With none, authorization_code grants are refused and client_credentials allowed; with one, it is the whole list. A served syndicate is checked when loaded, when compiled and at each call. melchizedek-serve builds the credential store and consent step from MELCHIZEDEK_CREDENTIAL_KEY, OAUTH_REDIRECT_URI, OAUTH_CALLBACK_IDENTITY and the allowlist, with the consent clients taken from the served files only. A YAML-declared binding, a provider-only list, a permissive default, a per-namespace credential key and registry-defined consent clients were rejected."
tags:
  - decision
  - tools
  - security
  - operations
status: stable
generated:
  by: claude-code/claude-opus-5-5
  at: 2026-10-09
sources:
  - resource: lib/tools/oauthHosts.ts
  - resource: lib/tools/oauthTools.ts
  - resource: lib/tools/mcpToolFactory.ts
  - resource: lib/tools/openapiTools.ts
  - resource: lib/a2a/oauthSetup.ts
  - resource: lib/a2a/app.ts
  - resource: scripts/a2a_server.ts
  - resource: lib/doctor.ts
  - resource: tests/oauthHosts.test.ts
---

# ADR 0114: OAuth tokens go only to hosts the operator binds to their provider, and the server binary wires tool credentials from the environment

## Context

[ADR 0112](/decisions/0112-oauth-grants-declared-beside-the-tool.md) lets a YAML declare an OAuth grant beside the tool it protects, and left one question open. The credential store keys a user's grant by app (the memory namespace), user and provider ([ADR 0072](/decisions/0072-tool-credentials-sealed-per-user.md)). Two syndicates in one namespace therefore share their users' grants. A registry-stored YAML that names a provider another syndicate's users granted, and points a tool at a host of its own, would receive those users' tokens. The same YAML could aim a client-credentials token endpoint at its own host and receive a client secret the operator configured for another provider, or aim a consent client's token endpoint there and receive codes and refresh tokens.

Separately, `melchizedek-serve` built no credential store and no consent step, so a declared authorization-code grant worked only for an embedder who wrote that wiring.

## Decision

1. **The operator binds each provider to its hosts.** `MELCHIZEDEK_OAUTH_HOSTS="tracker=api.tracker.example.com,auth.tracker.example.com;…"`, or `createA2AApp({ oauthHosts })`, which wins and is set for the process (`lib/tools/oauthHosts.ts`). A host is a hostname, `*.domain` (any subdomain, not the apex), IPv4 or `[IPv6]`; no scheme, port or path. A malformed list throws at boot, naming the provider and host.
2. **The default with no allowlist: authorization_code refused, client_credentials allowed.** A user's token never goes to a host nobody bound. A client-credentials secret is the operator's, named by a variable the operator set, the trust `bearer_env` already gives a YAML (narrowed by `OPENAPI_CREDENTIAL_ENVS`).
3. **With an allowlist, it is the whole list.** Every grant's provider must be on it, client credentials included, and every host the grant sends to must be that provider's: the OpenAPI or MCP server, the token endpoint, and the authorization endpoint. Otherwise a YAML could declare a fresh client-credentials provider whose token endpoint is its own and name another provider's client secret.
4. **Checked three times.** When a syndicate is loaded to be served (`createA2AApp` for the default and every dynamic route, including registry rows, through `syndicateOAuthHostProblems`; the server binary at boot for the served files); when its tools compile (`oauthTokenSource`, and `oauthClientsFor` for the consent clients); and before each call sends a token (`oauthCallProblem`: the token source for the destination, every MCP request in `bearerFetch` where it actually goes, the client-credentials token endpoint, and the refresh hook). A call-time refusal is `ToolCredentialError('host_refused')`, which names the provider and no value, and nothing is sent.
5. **The server binary wires tool credentials** (`lib/a2a/oauthSetup.ts`, `serverOAuth` in `scripts/a2a_server.ts`): `MELCHIZEDEK_CREDENTIAL_KEY` seals rows in Postgres with `DATABASE_URL`, else in process memory (with a warning); `OAUTH_REDIRECT_URI` mounts the consent callback; the consent clients and the store's refresh hooks come from the grants the served syndicate **files** declare. A registry row may name a provider they declare, never define its endpoints or client. The server refuses to start on a malformed key, allowlist or redirect URI, a redirect URI without a key, or a served file whose grant the allowlist refuses.
6. **`OAUTH_CALLBACK_IDENTITY`** keeps ADR 0085's default, `required`: the browser that completes a grant must carry the flow's user's identity, which only a gateway's header (`A2A_AUTH=header`) gives a browser. `state` lets the single-use state alone bind the flow, for a deployment that accepts that a forwarded link can connect the wrong account. Both the server and the doctor say when `required` would refuse every callback.
7. **The doctor** prints an `oauth` line (which of the variables are set, never a value) with each problem by name (a declared authorization-code grant without the key, the redirect URI or the allowlist; a malformed key; a callback no browser can complete), and each grant's host refusals. `--check` fails on them.

## Alternatives considered

- **The binding in the YAML** (a `hosts:` list beside the grant). Rejected: the YAML is the party the binding constrains; a registry row would bind itself.
- **A list of allowed providers without hosts.** Rejected: the attack names an allowed provider and a host of its own.
- **Permissive until configured** (warn only). Rejected for authorization_code: the first deployment that serves a registry row would expose its users' tokens before anyone read a warning.
- **Refuse client_credentials too until configured.** Rejected as the default: its secret is the operator's, and the static `bearer_env` already sends one to a YAML-chosen host. Once an allowlist exists it covers both (item 3).
- **One credential key per memory namespace**, so namespaces cannot read each other's grants. Rejected: the attack is two syndicates in the same namespace, which share grants by design ([ADR 0020](/decisions/0020-memory-contract.md)).
- **Consent clients from registry rows too.** Rejected: a row would define the endpoints a user's code and refresh token go to.
- **Check only at compile.** Rejected: an MCP server names its own message endpoint, and the allowlist can change; the call-time check costs a URL parse.

## Consequences

- `tests/oauthHosts.test.ts` proves a foreign host refused at load (the server wiring and `createA2AApp`, default and dynamic route), at compile (MCP, OpenAPI, token endpoint, consent clients) and at call time (OpenAPI and MCP, both grants, and the refresh hook), with no request carrying a token; drives an allowlisted grant end to end through `serverOAuth` and `createA2AApp` (consent pause, mock provider, callback, resumed call with the user's own token at the mock MCP server); and shows the doctor naming a missing key, redirect URI and allowlist.
- A deployment that sets an allowlist lists its client-credentials providers too.
- The allowlist is process-wide: two `createA2AApp`s in one process share it.
- The consent clients cover the served files only. With `A2A_SERVED_AGENTS` unset, every root file is served, so every root file's grant is checked at boot.
