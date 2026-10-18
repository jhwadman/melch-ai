---
type: decision
title: "ADR 0122: Static credentials go only to hosts the operator binds"
description: "MELCHIZEDEK_CREDENTIAL_HOSTS binds each static credential variable a YAML sends to the hosts its value may reach."
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

# ADR 0122: Static credentials go only to hosts the operator binds

**Decided (2026-10-09):** A second operator allowlist, `MELCHIZEDEK_CREDENTIAL_HOSTS`, binds each static credential variable a YAML sends (`bearer_env`, `api_key.env`, `client_secret_env`) to its hosts. Unset, credentials flow as before with a named warning; set, it is the whole list, checked at load, at compile and before each send.

**Instead of:** one unified allowlist with ADR 0114's, the binding in the YAML, an allowlist binding only what it lists, refusing unbound credentials by default, covering `MCP_BEARER_TOKENS`, folding into `OPENAPI_CREDENTIAL_ENVS`

How it works: [Tool contracts](/tools/tool-contracts.md)
