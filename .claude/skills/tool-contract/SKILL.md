---
name: tool-contract
description: How a tool is written, validated and exposed — one defineTool contract, the zod schema as the single source of truth, readable errors, and exposure as a deliberate act. Use when adding or changing a tool, its schema, or who can reach it.
---

# The tool contract

A tool is **one object, defined once**: name, description, zod schema,
`execute`. `defineTool` (`lib/tools/toolContract.ts`) makes it the engine's own
`Tool` (`lib/tools/tool.ts`), and every surface derives from that —

```
defineTool(...) ──► declaration()          syndicate agents (the native loop)
               └──► toMcpToolDefinition()  MCP tools/list entry
```

The zod schema is the single source of truth. zod v4's `z.toJSONSchema()` emits
standard JSON Schema (what MCP and every non-Gemini provider want), and
`toGeminiSchema()` derives Gemini's dialect from that. Hand-writing a schema in
either dialect reintroduces the drift this file was built to end.

## Writing one

1. **`defineTool` in `lib/tools/`**, one file per family, exporting contracts.
2. **The `description` is prompt text, not developer docs.** It is the only
   thing steering when a model reaches for the tool: say what it is for and
   when not to use it.
3. **Validate at the boundary.** Tool arguments are **model-chosen**, which
   makes them untrusted input: a tool that interpolates a model-supplied string
   into SQL, a path, a URL or a shell is the injection this framework can ship.
   Constrain in the schema — enums, bounds, patterns. Outbound URLs go through
   the SSRF guard (`lib/net/addressGuard.ts`).
4. **`execute` returns a string the model will read.** Errors are returned as
   readable text, not thrown into the runner. A tool that failed must say it
   failed rather than return something that looks like an answer.
5. **Never let a key reach the return value** — not in an error, not in a
   debug line (`secrets-hygiene`).

## Exposure is separate, and deliberate

Defining a contract publishes nothing. A tool becomes reachable only by:

- **an agent** — the name registered (`TOOL_MAP`, or `registerTool` from an
  adopter's code) *and* declared in the syndicate YAML's `tools:` list; and
- **an MCP client** — a server script explicitly listing it
  (`lib/tools/mcpServe.ts`).

Keep both acts in files a reviewer reads. A registry that auto-enumerated a
directory would make the exposure surface invisible.

## Before you finish

- Is the schema the only place the shape is written?
- Does `npm test` pass?
- Is the tool registered only if an agent should have it?
- `wiki/tools/` updated (`sync-wiki`)?
