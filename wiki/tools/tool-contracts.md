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
  - resource: lib/tools/memoryTools.ts
  - resource: lib/tools/auth.ts
  - resource: lib/tools/credentialStore.ts
  - resource: lib/tools/credentialCipher.ts
  - resource: lib/storage/postgres/credentialStore.ts
  - resource: lib/tools/nativeTools.ts
  - resource: lib/tools/examples.ts
  - resource: lib/models/schemaNormalize.ts
  - resource: tests/toolContract.test.ts
  - resource: tests/memoryTools.test.ts
  - resource: tests/toolCredentials.test.ts
  - resource: tests/toolBaseRest.test.ts
---

# Tool contracts

A native tool can reach three surfaces: the native runtime, the ADK runtime (a `FunctionTool` with a Gemini-dialect schema) and outside MCP clients (standard JSON Schema). Writing the schema once per surface would let them drift. A tool is **one object**, `{ name, description, schema (zod), execute }`, and `defineTool()` in `lib/tools/toolContract.ts` makes it the engine's own **Tool**; thin adapters derive each surface from it:

- `declaration()` → the model contract's `ToolDeclaration` ([model contract](/models/model-contract.md)), which the native runtime sends.
- `toFunctionTool()` (`lib/tools/adkTool.ts`) → a live ADK tool for the ADK runtime.
- `toMcpToolDefinition()` → the `tools/list` entry for MCP servers.

## The tool base

`lib/tools/tool.ts` defines what a tool is, independent of ADK ([ADR 0051](/decisions/0051-own-tool-base-behind-an-adk-wrapper.md)):

- **`Tool`**: a `name`, a `declaration()` and `execute(args, ctx)`. `args` are model-chosen and untrusted; the tool validates them before it acts. The result is JSON-serializable data the model reads. A throw becomes the call's error, which the runtime reports to the model.
- **`ToolContext`**: the invocation, agent, call, user, app and session ids; the session `state` as a view whose reads see this call's writes; `stateDelta`, the writes the runtime applies with the result; `actions.skipSummarization`; `requestConfirmation()` and `confirmation`, the approval gate ([ADR 0028](/decisions/0028-approval-gates.md)); the turn's abort `signal`; `userContent`, the message that started the run; and, when the run has long-term memory, `searchMemory(query)`, which searches the context's own `<appName>/<userId>` silo and no other ([ADR 0059](/decisions/0059-memory-on-the-engines-own-interfaces.md)); and, when the run has a credential store, `accessToken(provider)` (see below). `createToolContext()` builds one over plain data, for the native runtime and for calls made outside a run. Given the run's `memory`, its search refuses to run without an app name and user id.
- **Writing into the instruction.** A Tool's optional `instruction(ctx)` returns text for the system instruction of each model request made for an agent that lists it. An **`InstructionTool`** has only a `name` and an `instruction(ctx)`: it declares no function and is never called (`isInstructionTool`). Both run before the request is sent, in the order the agent lists its tools, and read the context without writing to it.
- **Adding to the history.** A Tool's optional `contents(contents, ctx)` may append to the request's history after it is projected, in the same order, and changes nothing else; what it adds is never stored. `load_skill_resource` uses it to show a binary file it just answered for ([ADR 0083](/decisions/0083-skills-harness-on-the-own-tool-base.md)).
- **`Toolset`**: a `getTools(ctx)` that lists the tools an agent has for the next request, read against a `ToolsetContext` (the agent's name, the invocation id and the session state). The [skill harness](/tools/skill-harness.md) is one, whose tools grow as skills are loaded. `isOwnToolset` recognises one by shape; `toolsetOf()` reads one back from its ADK form.
- **`requireApproval(tool)`** returns a copy whose first call requests confirmation and ends the step, and whose retry runs the tool or returns the refusal. Its texts are ADK's own, so a gated call stores the same interrupt and response on either runtime. An OpenAPI operation takes the same gate ([ADR 0067](/decisions/0067-openapi-calls-on-the-engines-own-caller.md)). The original stays ungated.
- **The long-running marker.** A `longRunning` Tool's answer comes later ([ask the user](/tools/ask-user.md)). Its handler resolves to undefined while the answer is pending, and its description carries the note ADK's `LongRunningFunctionTool` appends, word for word.
- **Result capping.** `capResult(result, max)` cuts a result and says so. `MAX_RESULT_CHARS` (20,000) is the one limit the OpenAPI and MCP tools apply to their results. A contract caps its results only when it sets `maxResultChars`.

`tool.ts` and `toolContract.ts` load nothing from `@google/*` at runtime, which `tests/toolContract.test.ts` asserts. `lib/tools/adkTool.ts` is the one module that turns a Tool into an ADK tool: the `FunctionTool` gets the Tool's declaration in Gemini's dialect and hands the Tool a `ToolContext` that reads through to ADK's `Context`, memory search included, and it carries the Tool, which `toolOf()` reads back. A Tool with an `instruction` or a `contents` hook becomes a `FunctionTool` subclass that appends the text, and then adds to the history, in `processLlmRequest`, after declaring itself. An own Toolset becomes a `BaseToolset` whose `getTools` hands it ADK's `ReadonlyContext` and returns each tool through `toAdkTool` (`toAdkToolset`). An InstructionTool becomes a `BaseTool` that declares nothing and appends its text the same way (`toAdkInstructionTool`); `instructionToolOf()` reads it back. Both join the text as ADK's own `appendInstructions` does: after a blank line, or as the whole instruction when there is none. A NativeToolMarker becomes the shared sentinel the ADK runtime runs for that server-side tool (`toAdkNativeTool`). `toAdkTool()` takes any of the four and picks the wrapper, and passes an ADK tool through.

## Third-party access for the run's user

A tool that acts for a person against a third-party API (their calendar, their repository host) uses that person's delegated OAuth access, never the server's own key ([ADR 0072](/decisions/0072-tool-credentials-sealed-per-user.md)). `ctx.accessToken(provider)` returns a valid access token for the context's own app and user: the tool names the provider, never whose token, as `searchMemory` names the query and never the silo. The member exists only when the run has a credential store, and throws a `ToolCredentialError` (`not_connected`, `expired`, `refresh_failed`, `unreadable`, `no_user`, `invalid`) whose message names the provider and what to do, and no value, so a tool may hand it to the model. The token goes to its provider only, never into a result, an error, a log line or a span.

- **`lib/tools/auth.ts`** is a leaf with no runtime imports: the `CredentialStore` interface (`put`, `get` with refresh, `revoke`, `eraseUser`), the provider hooks (`OAuthProvider.refresh`, `.revoke`), the binding `toolAccessToken(store, appName, userId)`, and `pinnedCredentialStore(store, appName)`, which pins every key to the run's app (the root syndicate's memory namespace) so a delegated subagent, which ADK runs under its own app name, reads the root's credentials.
- **`lib/tools/credentialStore.ts`** holds the logic once, over any row backend (`CredentialRows`): it seals every token before the backend sees it, refreshes an expired one (60 s early) at most once at a time per key in a process and writes the result only over the version it read, fails closed on a row it cannot open, and writes an audit row for each put, refresh, revoke and erase. A provider's error is reported by kind, never by message, since a provider may echo the token it refused. `memoryCredentialRows()` is the in-process backend; `lib/storage/postgres/credentialStore.ts` is the Postgres one, on `melchizedek_tool_credentials` ([schema](/memory/schema.md), migration 0013), and `postgresStorage({ credentials: { cipher, providers } })` builds `storage.credentials` with the storage's audit trail.
- **`lib/tools/credentialCipher.ts`** is the sealing plug point, `CredentialCipher` (`keyId`, `encrypt`, `decrypt`). The built-in `aesGcmCipher` is AES-256-GCM with a key from `MELCHIZEDEK_CREDENTIAL_KEY` (`credentialCipherFromEnv()`: 32 bytes as base64 or hex; unset means no store, malformed throws at boot). The envelope (`mzc1.<key id>.<iv>.<tag>.<ciphertext>`) names its key, so a row sealed with another key is refused by name, and binds the app, user, provider and field as authenticated data, so a ciphertext moved onto another user's row does not open.

The ADK runtime's context has no `accessToken` yet, and no registry tool uses it; the consent route that puts a token and the YAML that lets an agent use a provider come with WS6-3b and WS6-3c.

## Server-side tools are markers

`web_search`, `x_search`, `url_context`, `collections_search` and `google_search` run on the provider's side, so they declare no function. Each is a **NativeToolMarker** (`lib/tools/tool.ts`, the instances in `lib/tools/nativeTools.ts`): a name, a description for a reader, and the `NativeTool` it stands for under the global symbol `melchizedek.nativeTool` ([ADR 0062](/decisions/0062-server-side-tools-as-markers.md)). `nativeToolMarkerOf()` reads it. The ADK runtime's sentinels (`lib/tools/webSearchTool.ts` and its siblings) carry the same symbol, and ADK's own `GOOGLE_SEARCH` is recognised by ADK's marker. `nativeToolOf()` in `lib/models/schemaNormalize.ts` and the `wants*`/`is*Sentinel` helpers read the marker, never the class or the name, so a client-side tool registered as `web_search` stays a client-side tool, and a second copy of a sentinel module still matches. Code execution is not a marker: it is the agent's `code_execution: gemini`.

## Validation

A defined Tool validates in its own `execute`. Arguments the schema refuses return an **error string, never a throw**: the calling model sees what to fix and retries. The handler gets the parsed input, defaults applied, and a complete `ToolContext` on every surface. A defined Tool is still a `ToolContract`, so `executeContract()` and the MCP server run it unchanged, validating once.

## The dialect bridge

`zodInputJsonSchema()` in `lib/models/schemaNormalize.ts` is the one place a zod schema becomes JSON Schema: the schema's input side, which is what MCP and four of the five providers natively want. `toGeminiSchema()` derives the ADK dialect from it (types UPPERCASED, the `default` keyword and a boolean `additionalProperties` dropped); `lib/models/schemaNormalize.ts` reverses the case change, lowercasing FunctionTool schemas back at request-build time for the non-Gemini providers in [provider routing](/models/provider-routing.md). On both paths a field with a default is optional to the model, a property named `additionalProperties` or `default` keeps its schema because each walk follows schema keywords rather than key names, and a record keeps its value schema. A record's `propertyNames: { type: 'string' }` is left out at the source, since JSON keys are always strings and the Gemini API refuses the keyword with a 400; `toGeminiSchema` drops any other `propertyNames` for the same reason. `tests/models.test.ts` covers the lowercasing.

## Exposure is deliberate

Defining a contract publishes nothing. An agent sees a tool only when its name is registered — in `lib/toolRegistry.ts`, or by a package consumer's own call to `registerTool(name, tool)` with a contract, an own Tool, an InstructionTool or an ADK tool — **and** declared in the syndicate YAML; an MCP client sees it only when a server script lists it in the `contracts` it passes to `serveContracts()` (`lib/tools/mcpServe.ts`; see [MCP](/protocols/mcp.md)). Every widening of the surface is a line of code someone chose; YAML can name only what code registered, never load it. The registry is a null-prototype map, so a name like `constructor` resolves to nothing and gets the unknown-tool warning.

Every client-side tool the registry holds is an own Tool behind its `FunctionTool`. The [wiki tools](/tools/wiki-tools.md), the [clinical-evidence tools](/tools/evidence-tools.md), the [task tools](/tools/task-tools.md), the [web tools](/tools/web-tools.md)' `web_extract` and `x_api_search`, `generate_image`, `inspect_image`, `ask_user` and `load_memory` are contracts under this pattern. `preload_memory` and an agent's `examples:` are own InstructionTools. The server-side tools are own markers behind their ADK sentinels. Outside the registry, the [MCP](/protocols/mcp.md) tools and the [remote A2A agent](/protocols/a2a.md) tool are own Tools behind their `FunctionTool`s too.

## The examples block

An agent's `examples:` (input and output pairs) is an InstructionTool built by `examplesInstructionTool()` in `lib/tools/examples.ts`, named `example_tool`. Before each request it adds a few-shot `<EXAMPLES>` block to the instruction, each exchange numbered with its `[user]` and `[model]` text, word for word as ADK's `ExampleTool` rendered text examples, and only when the message that started the run begins with text. `lib/compile.ts` hands the ADK runtime the `toAdkInstructionTool` form. `tests/toolBaseRest.test.ts` compares the request with ADK's `ExampleTool` across models, instructions and messages.

## The memory tools

`lib/tools/memoryTools.ts` holds long-term memory's two tools ([memory architecture](/memory/architecture.md), [ADR 0059](/decisions/0059-memory-on-the-engines-own-interfaces.md)):

- **`load_memory`** takes a `query` and returns `{ memories: [{ content, author, timestamp }] }`, each memory's text parts joined by a space. While the run has memory, its `instruction` adds a note saying that memory exists and that `load_memory` searches it. With no memory service a call fails with `Memory service is not initialized.`
- **`preload_memory`** searches with the first text part of the message that started the run, and writes what it recalls into the instruction inside a `<PAST_CONVERSATIONS>` block: each memory's time on its own line, then its text after its author. It writes nothing when that part has no text, the run has no memory, nothing is recalled, or the search fails.

Both search through `ctx.searchMemory`, so a model's query chooses what to recall and never whose. The declaration, the note, the result and the block are word for word what ADK's `LoadMemoryTool` and `PreloadMemoryTool` produced. `tests/memoryTools.test.ts` compares each with ADK's tool and runs one turn with each pair. A failed `load_memory` call on the ADK runtime reads `Error in tool 'load_memory': …`, as every own Tool's does. Neither tool logs the query.
