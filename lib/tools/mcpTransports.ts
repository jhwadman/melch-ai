/**
 * lib/tools/mcpTransports.ts — the transports an agent may name for an MCP
 * server (ADR 0124), in a module light enough for the YAML schema to import
 * without loading the MCP SDK.
 *
 * `auto` (the default) posts the initialize request over Streamable HTTP, the
 * spec's current transport, and falls back to the legacy HTTP+SSE transport
 * on the spec's signal (lib/tools/mcpToolFactory.ts isSseFallbackSignal);
 * `streamable_http` and `sse` use that one transport only.
 */
export const MCP_TRANSPORTS = ['auto', 'streamable_http', 'sse'] as const;
export type McpTransportKind = (typeof MCP_TRANSPORTS)[number];
