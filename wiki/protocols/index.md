# Protocols

<!-- wiki:generated section="listing" source="directory contents" -->
- [A2A](/protocols/a2a.md) — Any syndicate served over A2A 1.0 (with 0.3 compatibility) and any A2A agent callable as a subagent — the plug points for identity and keys, which agents are served, limits, and the compile-time-bindings trap.
- [MCP server (melchizedek-mcp)](/protocols/mcp-server.md) — Syndicates served as MCP tools to Claude Code, Codex and any MCP client — one tool per syndicate, melch_resume for pauses, stdio and Streamable HTTP, every call one task through the A2A executor.
- [MCP](/protocols/mcp.md) — Reaching outward and serving outward over the Model Context Protocol — runtime tool discovery over Streamable HTTP or SSE from one or several servers per agent, OAuth with discovered and self-registered clients, contract-derived SSE servers, and the SSRF guard between them.
<!-- /wiki:generated -->
