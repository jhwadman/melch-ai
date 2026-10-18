---
type: decision
title: "ADR 0114: OAuth tokens go only to operator-bound hosts; the server wires credentials from env"
description: "An operator allowlist binds each OAuth provider to the hosts its tokens and client secret may reach, checked at load, compile and call, and melchizedek-serve builds the credential store and consent step from the environment."
tags:
  - decision
  - tools
  - security
  - operations
status: stable
generated:
  by: claude-code/claude-opus-5-5
  at: 2026-10-18
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

# ADR 0114: OAuth tokens go only to operator-bound hosts; the server wires credentials from env

**Decided (2026-10-09):** The operator, not the YAML, binds each provider to its hosts (`MELCHIZEDEK_OAUTH_HOSTS` or `oauthHosts`): with no list, authorization-code grants are refused and client credentials allowed; with one, it is the whole list; checked at load, compile and each call. `melchizedek-serve` wires the credential store and consent step from the environment, consent clients from served files only.

**Instead of:** a binding in the YAML, a provider-only list, permissive until configured, refusing client_credentials by default, a credential key per namespace, consent clients from registry rows, checking only at compile

How it works: [Tool contracts: third-party access](/tools/tool-contracts.md#third-party-access-for-the-runs-user)
