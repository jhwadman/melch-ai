---
type: subsystem
title: Tool contracts
description: Define a tool once — name, description, zod schema, execute — as the engine's own Tool, and derive every serving surface from it; exposure remains a separate, deliberate act.
tags:
  - tools
  - contracts
generated:
  by: claude-code/claude-opus-5-5
  at: 2026-10-07
sources:
  - resource: lib/tools/tool.ts
  - resource: lib/tools/toolContract.ts
  - resource: lib/tools/adkTool.ts
  - resource: lib/models/schemaNormalize.ts
  - resource: tests/toolContract.test.ts
---

# Tool contracts

A native tool can reach three surfaces: the native runtime, the ADK runtime (a `FunctionTool` with a Gemini-dialect schema) and outside MCP clients (standard JSON Schema). Writing the schema once per surface would let them drift. A tool is **one object**, `{ name, description, schema (zod), execute }`, and `defineTool()` in `lib/tools/toolContract.ts` makes it the engine's own **Tool**; thin adapters derive each surface from it:

- `declaration()` → the model contract's `ToolDeclaration` ([model contract](/models/model-contract.md)), which the native runtime sends.
- `toFunctionTool()` (`lib/tools/adkTool.ts`) → a live ADK tool for the ADK runtime.
- `toMcpToolDefinition()` → the `tools/list` entry for MCP servers.

## The tool base

`lib/tools/tool.ts` defines what a tool is, independent of ADK ([ADR 0051](/decisions/0051-own-tool-base-behind-an-adk-wrapper.md)):

- **`Tool`**: a `name`, a `declaration()` and `execute(args, ctx)`. `args` are model-chosen and untrusted; the tool validates them before it acts. The result is JSON-serializable data the model reads. A throw becomes the call's error, which the runtime reports to the model.
- **`ToolContext`**: the invocation, agent, call, user, app and session ids; the session `state` as a view whose reads see this call's writes; `stateDelta`, the writes the runtime applies with the result; `actions.skipSummarization`; `requestConfirmation()` and `confirmation`, the approval gate ([ADR 0028](/decisions/0028-approval-gates.md)); and the turn's abort `signal`. `createToolContext()` builds one over plain data, for the native runtime and for calls made outside a run.
- **`requireApproval(tool)`** returns a copy whose first call requests confirmation and ends the step, and whose retry runs the tool or returns the refusal. Its texts are ADK's own, so a gated call stores the same interrupt and response on either runtime. The original stays ungated.
- **The long-running marker.** A `longRunning` Tool's answer comes later ([ask the user](/tools/ask-user.md)). Its handler resolves to undefined while the answer is pending, and its description carries the note ADK's `LongRunningFunctionTool` appends, word for word.
- **Result capping.** `capResult(result, max)` cuts a result and says so. `MAX_RESULT_CHARS` (20,000) is the one limit the OpenAPI and MCP tools already apply to their results. A contract caps its results only when it sets `maxResultChars`.

`tool.ts` and `toolContract.ts` load nothing from `@google/*` at runtime, which `tests/toolContract.test.ts` asserts. `lib/tools/adkTool.ts` is the one module that turns a Tool into an ADK tool: the `FunctionTool` gets the Tool's declaration in Gemini's dialect and hands the Tool a `ToolContext` that reads through to ADK's `Context`, and it carries the Tool, which `toolOf()` reads back.

## Validation

A defined Tool validates in its own `execute`. Arguments the schema refuses return an **error string, never a throw**: the calling model sees what to fix and retries. The handler gets the parsed input, defaults applied, and a complete `ToolContext` on every surface. A defined Tool is still a `ToolContract`, so `executeContract()` and the MCP server run it unchanged, validating once.

## The dialect bridge

`zodInputJsonSchema()` in `lib/models/schemaNormalize.ts` is the one place a zod schema becomes JSON Schema: the schema's input side, which is what MCP and four of the five providers natively want. `toGeminiSchema()` derives the ADK dialect from it (types UPPERCASED, the `default` keyword and a boolean `additionalProperties` dropped); `lib/models/schemaNormalize.ts` reverses the case change, lowercasing FunctionTool schemas back at request-build time for the non-Gemini providers in [provider routing](/models/provider-routing.md). On both paths a field with a default is optional to the model, a property named `additionalProperties` or `default` keeps its schema because each walk follows schema keywords rather than key names, and a record keeps its value schema. `tests/models.test.ts` covers the lowercasing.

## Exposure is deliberate

Defining a contract publishes nothing. An agent sees a tool only when its name is registered — in `lib/toolRegistry.ts`, or by a package consumer's own call to `registerTool(name, tool)` with a contract, an own Tool or an ADK tool — **and** declared in the syndicate YAML; an MCP client sees it only when a server script lists it in the `contracts` it passes to `serveContracts()` (`lib/tools/mcpServe.ts`; see [MCP](/protocols/mcp.md)). Every widening of the surface is a line of code someone chose; YAML can name only what code registered, never load it. The registry is a null-prototype map, so a name like `constructor` resolves to nothing and gets the unknown-tool warning.

Every client-side tool the registry holds is an own Tool behind its `FunctionTool`, except ADK's `load_memory`. The [wiki tools](/tools/wiki-tools.md), the [clinical-evidence tools](/tools/evidence-tools.md), the [task tools](/tools/task-tools.md), the [web tools](/tools/web-tools.md)' `web_extract` and `x_api_search`, `generate_image`, `inspect_image` and `ask_user` are contracts under this pattern. The server-side search sentinels and the memory tools are ADK objects.
