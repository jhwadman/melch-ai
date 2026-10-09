---
type: syndicate
title: Systems Operator
description: The Systems Operator syndicate.
tags:
  - syndicate
generated:
  by: process:wiki-build
  at: 2026-09-27
sources:
  - resource: config/agents/templates/systems_operator.yaml
---

# Systems Operator

<!-- wiki:fill slot="charter" -->
Systems Operator puts an agent in front of your own systems (orders, tickets, inventory, a CRM, an internal API) without writing a tool into this repo. Your systems publish their operations as an MCP server. The Systems subagent declares that server in `mcp_server_url`; at startup the framework asks it for its tools and wraps each one (`lib/tools/mcpToolFactory.ts`). An unreachable server gives an empty tool list and a warning. `MCP_BEARER_TOKENS` sends a bearer token only to its exact host and only over https, and loopback or private addresses need `ALLOW_PRIVATE_MCP=true`. An OAuth-protected server is declared on Systems with `mcp_auth: { oauth2 }` (the template carries a commented client-credentials block; [ADR 0112](/decisions/0112-oauth-grants-declared-beside-the-tool.md)). The authorization-code form, each person's own token, works on Systems too: a person who has not connected gets an authorization link and the turn pauses, and their next message after the grant resumes Systems' call ([ADR 0118](/decisions/0118-skill-scripts-and-oauth-consent-inside-delegated-subagents.md)). It needs `mcp_tools` and an operator allowlist ([ADR 0114](/decisions/0114-oauth-tokens-go-only-to-hosts-the-operator-binds.md)). `npm run doctor` lists the tool as needing a grant.

The safety shape is read, plan, confirm, write. A QUESTION gets a read and an answer. A CHANGE gets a read and a PLAN, one line per call, and no write in that turn. On the next turn's "confirm", the Operator reads the records again. If anything the plan rested on has moved, it writes nothing and proposes a new plan; otherwise Systems makes exactly the planned calls. Any other message while a plan is pending cancels it. Both agents know the write operations from the `write_operations` variable, so a READ request can never reach a write operation whose name does not look like one. Memory is `session-only`, so a plan survives until the next turn.

Try it against the demo catalog: run `npm run mcp:demo`, then `ALLOW_PRIVATE_MCP=true npm run chat:syndicate -- --syndicate systems_operator`. Serve it with `npm run start:a2a` at `/systems_operator/a2a/rest/v1/message:send`, with `A2A_SERVER_SECRET` as the callers' bearer token. To adopt it, set `systems_mcp_url` to your server and list your write operations in `write_operations`.
<!-- /wiki:fill -->

<!-- wiki:generated section="composition" source="config/agents/templates/systems_operator.yaml" -->
- memory: `session-only` · max_steps: 16
- orchestrator: **Operator** (`gemini-3.8-flash`)

| Subagent | Model | Tools | MCP |
|---|---|---|---|
| Systems | `gemini-3.8-flash` | — | `mcp_server_url` |
<!-- /wiki:generated -->
