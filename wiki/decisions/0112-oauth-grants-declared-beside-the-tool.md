---
type: decision
title: "ADR 0112: OAuth grants are declared beside the tool; authorization-code MCP connects per user"
description: "An OpenAPI entry's auth.oauth2 and an agent's mcp_auth.oauth2 declare a provider and grant beside the tool, and an authorization-code MCP server is reached on each user's own connection with its tools named in YAML."
tags:
  - decision
  - tools
  - security
  - protocols
status: stable
generated:
  by: claude-code/claude-opus-5-5
  at: 2026-10-18
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

# ADR 0112: OAuth grants are declared beside the tool; authorization-code MCP connects per user

**Decided (2026-10-09):** Declare an OAuth grant (`authorization_code` or `client_credentials`) beside the tool it protects, secrets named only as variables. Authorization code reads the run's user's token through the consent pause; client credentials is the server's own token, kept in memory. An authorization-code MCP server lists nothing at startup: `mcp_tools` names its tools and each user gets their own connection.

**Instead of:** a syndicate-level oauth_providers block, client configuration in code only, a startup listing with a server token, a connect tool or per-user toolsets, calling blind with guessed arguments, client-credentials tokens in the credential store
**Superseded by:** [ADR 0118](/decisions/0118-skill-scripts-and-oauth-consent-inside-delegated-subagents.md) (delegated subagents may raise the consent pause)

How it works: [Tool contracts: third-party access](/tools/tool-contracts.md#third-party-access-for-the-runs-user)
