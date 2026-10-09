---
type: decision
title: "ADR 0122: Static credentials go only to hosts the operator binds to their variable"
description: "A second operator allowlist, MELCHIZEDEK_CREDENTIAL_HOSTS (or createA2AApp's credentialHosts), binds each static credential variable a YAML sends (bearer_env, api_key.env, client_secret_env) to the hosts its value may reach. Unset, nothing changes and the server's boot and the doctor name every unbound variable; set, it is the whole list. Checked when a served syndicate loads, when its tools compile and before each send. One unified allowlist with ADR 0114's, a YAML-declared binding, an allowlist that binds only what it lists, refusing unbound credentials by default, and covering MCP_BEARER_TOKENS and client_id_env were rejected."
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
  - resource: lib/tools/credentialHosts.ts
  - resource: lib/tools/credentialUses.ts
  - resource: lib/tools/openapiTools.ts
  - resource: lib/tools/oauthTools.ts
  - resource: lib/tools/oauthConsent.ts
  - resource: lib/a2a/oauthSetup.ts
  - resource: lib/a2a/app.ts
  - resource: scripts/a2a_server.ts
  - resource: lib/doctor.ts
  - resource: tests/credentialHosts.test.ts
---

# ADR 0122: Static credentials go only to hosts the operator binds to their variable

## Context

[ADR 0114](/decisions/0114-oauth-tokens-go-only-to-hosts-the-operator-binds.md) binds an OAuth provider's tokens to the hosts the operator names, and left the static credentials as they were. A syndicate YAML, possibly a registry row, names a credential variable and, beside it, the host its value goes to: an OpenAPI entry's `bearer_env` or `api_key.env` goes to the spec's server or `base_url`, and an `oauth2` block's `client_secret_env` goes to its `token_url`. `credentialEnvProblem` ([ADR 0041](/decisions/0041-tool-vendors-get-least-privilege.md)) keeps the framework's own variables out of reach, and `OPENAPI_CREDENTIAL_ENVS` can narrow the names, but nothing tied a name to a host. A registry row that names `TRACKER_TOKEN` and points `base_url` at its own host receives the tracker's token. A client-credentials secret, with no OAuth allowlist configured, goes to whatever token endpoint the YAML names.

## Decision

1. **The operator binds each credential variable to its hosts.** `MELCHIZEDEK_CREDENTIAL_HOSTS="TRACKER_TOKEN=api.tracker.example.com;WEATHER_KEY=api.weather.example.com,*.weather.example.com"`, or `createA2AApp({ credentialHosts })`, which wins and is set for the process (`lib/tools/credentialHosts.ts`). The format is ADR 0114's with a variable name in place of a provider: entries separated by `;` or a newline, hosts by `,`, each host a hostname, `*.domain`, IPv4 or `[IPv6]` (the same `hostPatternProblem`). A malformed list throws at boot, naming the variable and the host.
2. **It covers what a YAML sends:** `bearer_env`, `api_key.env`, and `client_secret_env` of both grants (the client-credentials token request, the consent step's code exchange and its refresh). Not `client_id_env`, which is not a secret. Not `MCP_BEARER_TOKENS`, which already maps each token to its exact host and is the operator's own writing.
3. **Unset, nothing changes.** Each credential goes to the host the YAML names, as before. The server binary's boot warns, and `npm run doctor` shows a `credentials` warning (not a `--check` failure), naming every variable a served YAML sends that no binding holds, by name only.
4. **Set, it is the whole list.** A variable not on it is sent nowhere; one on it only to its own hosts. Otherwise a registry row would name a variable the operator never listed.
5. **Checked three times**, beside ADR 0114's checks: when a syndicate is loaded to be served (`syndicateCredentialHostProblems`, in `createA2AApp` for the default and every dynamic route, and at the server binary's boot for the served files; an OpenAPI entry's hosts are its `base_url` or its spec's server, `openApiServers`); when its tools compile (`buildOpenApiOwnTools`, `oauthTokenSource`, `oauthClientsFor`); and before each send (`credentialCallProblem`). A call-time refusal sends nothing: an OpenAPI call answers `{ error }` naming the host, a client-credentials token request or a refresh throws `ToolCredentialError('host_refused')`, and the code exchange fails as `exchange_failed`. `oauthClientsFor` marks each consent client with the variable its secret came from, so the exchange and the refresh know what to check. A malformed allowlist refuses every call-time check.
6. **Two allowlists, layered.** With both configured, a client secret must pass both: its provider's hosts (ADR 0114) and its variable's.

## Alternatives considered

- **One unified allowlist** keyed by provider or variable (`tracker=…;env:TRACKER_TOKEN=…`). Rejected: the two bind different things (a provider's tokens, a variable's value), ADR 0114's format is deployed, and a prefix in the key would make a typo silently change which rule applies. Two variables in one format keep each readable.
- **The binding in the YAML** (`hosts:` beside `auth`). Rejected for ADR 0114's reason: the YAML is the party the binding constrains.
- **An allowlist that binds only what it lists**, unlisted variables unconstrained. Rejected: a registry row would name a variable the operator forgot, and the list would protect only what nobody attacks.
- **Refuse unbound credentials by default.** Rejected: every deployment that uses `bearer_env` today would stop at upgrade. A named warning moves operators to bind without breaking them; ADR 0114 refused unbound authorization-code grants because a user's token is not the operator's to risk, and a static credential is.
- **Cover `MCP_BEARER_TOKENS`.** Rejected: its keys are the hosts already, the operator writes both, and the transport sends it only over https to that exact host.
- **Fold the names into `OPENAPI_CREDENTIAL_ENVS`.** Rejected: that variable is a name list read only by `credentialEnvProblem`, and changing its meaning would change existing deployments.

## Consequences

- `tests/credentialHosts.test.ts` proves a bound credential refused to a foreign host at load (`createA2AApp` and the server binary's boot, for `bearer_env`, `api_key` through `base_url`, and a client secret), at compile (OpenAPI, the token endpoint, the consent clients) and at call time (OpenAPI bearer and query key, a client-credentials token request, the refresh hook and the code exchange) with no request reaching the mock; allowed to its own host; unbound credentials working as before with the server's warning and the doctor's, names only; and the server binary reading the setting (its `creds` banner line, a malformed value stopping the boot).
- A deployment that sets the allowlist lists every static credential variable its YAML sends, client secrets included.
- The allowlist is process-wide, like ADR 0114's.
- The load-time check reads an OpenAPI entry's spec only when an allowlist is configured; a spec that cannot be read is left to its compile, which fails on its own.
