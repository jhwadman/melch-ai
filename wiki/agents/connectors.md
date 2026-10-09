---
type: syndicate
title: Connectors
description: The Connectors syndicate.
tags:
  - syndicate
generated:
  by: process:wiki-build
  at: 2026-10-09
sources:
  - resource: config/agents/examples/connectors.yaml
---

# Connectors

<!-- wiki:fill slot="charter" -->
The Connectors syndicate is the starter pack's specimen for one agent reaching several [MCP](/protocols/mcp.md) servers at once (`mcp_servers:`, [ADR 0124](/decisions/0124-mcp-client-streamable-http-several-servers-and-dynamic-registration.md)). Its one agent, Desk, lists two servers, the demo library catalog and this knowledge bundle, and names the tools it may use from each; a tool name on two servers, or shared with the agent's own tools, would be refused when the file loads. The specimen only reads; a write such as the catalog's `borrow_scroll` would be listed under `require_approval`, which may name any server's tool, so it waits for a person. Each server is reached over Streamable HTTP and falls back to the legacy SSE transport on the spec's signal; both local servers are SSE servers, so `auto` finds that.

The header comment and a commented entry show an official remote MCP server reached by URL with `client_registration: dynamic`: the authorization server is discovered from the MCP server and the deployment registers itself as a client, every discovered host held to `MELCHIZEDEK_OAUTH_HOSTS`. Run it with `npm run mcp:demo` and `npm run mcp:wiki` in two terminals and `ALLOW_PRIVATE_MCP=true`, then `node --experimental-strip-types scripts/syndicate_chat.ts --syndicate connectors`.
<!-- /wiki:fill -->

<!-- wiki:generated section="composition" source="config/agents/examples/connectors.yaml" -->
- memory: `internal-only`
- orchestrator: **Desk** (`gemini-3.8-flash`)

| Subagent | Model | Tools | MCP |
|---|---|---|---|
<!-- /wiki:generated -->
