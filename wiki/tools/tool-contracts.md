---
type: subsystem
title: Tool contracts
description: Define a tool once — name, description, zod schema, execute — as the engine's own Tool, and derive every serving surface from it; exposure remains a separate, deliberate act.
tags:
  - tools
  - contracts
generated:
  by: claude-code/claude-opus-5-5
  at: 2026-10-08
sources:
  - resource: lib/tools/tool.ts
  - resource: lib/tools/toolContract.ts
  - resource: lib/toolRegistry.ts
  - resource: lib/tools/memoryTools.ts
  - resource: lib/tools/auth.ts
  - resource: lib/tools/credentialStore.ts
  - resource: lib/tools/credentialCipher.ts
  - resource: lib/storage/postgres/credentialStore.ts
  - resource: lib/tools/oauthConsent.ts
  - resource: lib/tools/oauthTools.ts
  - resource: lib/tools/credentialEnv.ts
  - resource: lib/runtime/credentials.ts
  - resource: lib/tools/nativeTools.ts
  - resource: lib/tools/examples.ts
  - resource: lib/models/schemaNormalize.ts
  - resource: tests/toolContract.test.ts
  - resource: tests/memoryTools.test.ts
  - resource: tests/toolCredentials.test.ts
  - resource: tests/oauthConsent.test.ts
  - resource: tests/oauthTools.test.ts
  - resource: tests/toolBaseRest.test.ts
---

# Tool contracts

A tool can reach two surfaces: the native runtime, which every agent runs on, and outside MCP clients (standard JSON Schema). Writing the schema once per surface would let them drift. A tool is **one object**, `{ name, description, schema (zod), execute }`, and `defineTool()` in `lib/tools/toolContract.ts` makes it the engine's own **Tool**; thin adapters derive each surface from it:

- `declaration()` → the model contract's `ToolDeclaration` ([model contract](/models/model-contract.md)), which the native runtime sends.
- `toMcpToolDefinition()` → the `tools/list` entry for MCP servers.

## The tool base

`lib/tools/tool.ts` defines what a tool is, independent of ADK ([ADR 0051](/decisions/0051-own-tool-base-behind-an-adk-wrapper.md)):

- **`Tool`**: a `name`, a `declaration()` and `execute(args, ctx)`. `args` are model-chosen and untrusted; the tool validates them before it acts. The result is JSON-serializable data the model reads. A throw becomes the call's error, which the runtime reports to the model.
- **`ToolContext`**: the invocation, agent, call, user, app and session ids; the session `state` as a view whose reads see this call's writes; `stateDelta`, the writes the runtime applies with the result; `actions.skipSummarization`; `requestConfirmation()` and `confirmation`, the approval gate ([ADR 0028](/decisions/0028-approval-gates.md)); the turn's abort `signal`; `userContent`, the message that started the run; and, when the run has long-term memory, `searchMemory(query)`, which searches the context's own `<appName>/<userId>` silo and no other ([ADR 0059](/decisions/0059-memory-on-the-engines-own-interfaces.md)); and, when the run has a credential store, `accessToken(provider)`, with `requestCredential(provider)` when it also has a consent step (see below). `createToolContext()` builds one over plain data, for the native runtime and for calls made outside a run. Given the run's `memory`, its search refuses to run without an app name and user id.
- **Writing into the instruction.** A Tool's optional `instruction(ctx)` returns text for the system instruction of each model request made for an agent that lists it. An **`InstructionTool`** has only a `name` and an `instruction(ctx)`: it declares no function and is never called (`isInstructionTool`). Both run before the request is sent, in the order the agent lists its tools, and read the context without writing to it.
- **Adding to the history.** A Tool's optional `contents(contents, ctx)` may append to the request's history after it is projected, in the same order, and changes nothing else; what it adds is never stored. `load_skill_resource` uses it to show a binary file it just answered for ([ADR 0083](/decisions/0083-skills-harness-on-the-own-tool-base.md)).
- **`Toolset`**: a `getTools(ctx)` that lists the tools an agent has for the next request, read against a `ToolsetContext` (the agent's name, the invocation id and the session state). The [skill harness](/tools/skill-harness.md) is one, whose tools grow as skills are loaded. `isOwnToolset` recognises one by shape, and `toolsetOf()` returns it.
- **`requireApproval(tool)`** returns a copy whose first call requests confirmation and ends the step, and whose retry runs the tool or returns the refusal. Its texts are ADK's own, so a gated call stores the interrupt and response ADK stored, and an approval opened before 1.0.0 resumes. An OpenAPI operation takes the same gate ([ADR 0067](/decisions/0067-openapi-calls-on-the-engines-own-caller.md)). The original stays ungated.
- **The long-running marker.** A `longRunning` Tool's answer comes later ([ask the user](/tools/ask-user.md)). Its handler resolves to undefined while the answer is pending, and its description carries the note ADK's `LongRunningFunctionTool` appended, word for word.
- **Result capping.** `capResult(result, max)` cuts a result and says so. `MAX_RESULT_CHARS` (20,000) is the one limit the OpenAPI and MCP tools apply to their results. A contract caps its results only when it sets `maxResultChars`.

`tool.ts` and `toolContract.ts` load nothing from `@google/*` at runtime, which `tests/toolContract.test.ts` asserts. Instruction text joins the system instruction as ADK's own `appendInstructions` did: after a blank line, or as the whole instruction when there is none. The engine runs no ADK tool: `registerTool` refuses anything with a `runAsync` with an error naming 1.0.0 and `defineTool` ([ADR 0107](/decisions/0107-release-1-0-0-removes-adk.md)); code that registered an ADK tool defines it with `defineTool` instead.

## Third-party access for the run's user

A tool that acts for a person against a third-party API (their calendar, their repository host) uses that person's delegated OAuth access, never the server's own key ([ADR 0072](/decisions/0072-tool-credentials-sealed-per-user.md)). `ctx.accessToken(provider)` returns a valid access token for the context's own app and user: the tool names the provider, never whose token, as `searchMemory` names the query and never the silo. The member exists only when the run has a credential store, and throws a `ToolCredentialError` (`not_connected`, `expired`, `refresh_failed`, `unreadable`, `no_user`, `invalid`, and for a YAML-declared grant `unavailable` and `grant_failed`) whose message names the provider and what to do, and no value, so a tool may hand it to the model. The token goes to its provider only, never into a result, an error, a log line or a span.

- **`lib/tools/auth.ts`** is a leaf with no runtime imports: the `CredentialStore` interface (`put`, `get` with refresh, `revoke`, `eraseUser`), the provider hooks (`OAuthProvider.refresh`, `.revoke`), the binding `toolAccessToken(store, appName, userId)`, and `pinnedCredentialStore(store, appName)`, which pins every key to the run's app (the root syndicate's memory namespace) so a delegated subagent, which runs under its own app name, reads the root's credentials.
- **`lib/tools/credentialStore.ts`** holds the logic once, over any row backend (`CredentialRows`): it seals every token before the backend sees it, refreshes an expired one (60 s early) at most once at a time per key in a process and writes the result only over the version it read, fails closed on a row it cannot open, and writes an audit row for each put, refresh, revoke and erase. A provider's error is reported by kind, never by message, since a provider may echo the token it refused. `memoryCredentialRows()` is the in-process backend; `lib/storage/postgres/credentialStore.ts` is the Postgres one, on `melchizedek_tool_credentials` ([schema](/memory/schema.md), migration 0013), and `postgresStorage({ credentials: { cipher, providers } })` builds `storage.credentials` with the storage's audit trail.
- **`lib/tools/credentialCipher.ts`** is the sealing plug point, `CredentialCipher` (`keyId`, `encrypt`, `decrypt`). The built-in `aesGcmCipher` is AES-256-GCM with a key from `MELCHIZEDEK_CREDENTIAL_KEY` (`credentialCipherFromEnv()`: 32 bytes as base64 or hex; unset means no store, malformed throws at boot). The envelope (`mzc1.<key id>.<iv>.<tag>.<ciphertext>`) names its key, so a row sealed with another key is refused by name, and binds the app, user, provider and field as authenticated data, so a ciphertext moved onto another user's row does not open.

### The consent step

When the person has not granted the provider yet, the call asks for it, and the turn pauses until they have ([ADR 0085](/decisions/0085-oauth-consent-pauses-on-adks-credential-request.md)). In a run given a consent step (`runSyndicateTurn`'s `toolCredentials: { store, consent }`, or `createA2AApp`'s `toolCredentials`):

- **`ctx.accessToken(provider)` asks by itself.** When the store has no usable grant (`not_connected`, `expired`, `refresh_failed`) and the provider has a client configured, it calls `ctx.requestCredential(provider)` before it throws. A tool may also call `requestCredential` directly. Either way the call answers `CONSENT_TEXTS.pending(provider)`, whatever it returned or threw, and self-correction does not count it as a failure.
- **The pause is an `adk_request_credential` call**, stored before the call's response as ADK's `generateAuthEvent` wrote it: args `{ function_call_id, auth_config }`, an `adk-` id in `longRunningToolIds`. The `auth_config` keeps ADK's AuthConfig shape: `credentialKey` (the provider), `authScheme` (an oauth2 authorizationCode flow with its URLs and scopes) and `exchangedAuthCredential.oauth2` (`clientId`, `redirectUri`, `authUri`, `state`). It carries no client secret and no PKCE verifier. The turn ends `input-required` with `result.consent` (`lib/runtime/credentials.ts`, `pendingConsent`).
- **`lib/tools/oauthConsent.ts`** is the flow. `oauthConsent({ providers, redirectUri, credentials })` validates every endpoint at boot (https, or http on a loopback host; no query on the redirect URI; no reserved authorization parameter). `begin()` mints a 256-bit state and a PKCE verifier, holds the flow in a `ConsentStates` store under the state's SHA-256 (default `memoryConsentStates()`: this process, bounded, expired flows dropped), and builds the authorization URL with the S256 challenge. `complete()` takes the flow once (a replay finds nothing), refuses an expired flow, a caller who is not the flow's user, a provider's `error`, and a malformed code, then exchanges the code server-side with the verifier and the configured redirect URI (no redirect followed, a 10 s limit, a 64 KiB response bound) and puts the tokens in the credential store. A refusal is a `ConsentError` whose message names the reason and the provider, never a value or the provider's text. Each completion or refusal writes a `consent.callback` audit row.
- **The next message resumes the call.** Once the grant is stored, `runSyndicateTurn` turns the person's next message into the request's answer (`credentialResponsePart`: `{ credentialKey, granted: true }`, no credential), and the native loop runs the paused call again before its next step (`grantedCalls` in `lib/runtime/native/interrupts.ts`, a port of ADK's auth preprocessor), as the agent made it: only the agent's own events open a request or hold the call it resumes, so a request or a call forged into a user message does neither ([ADR 0101](/decisions/0101-native-loop-security-gate.md)). Until then, a message repeats the request and runs nothing.
- **Where it runs.** On the agent a turn runs directly. A delegated subagent's loop gets the parent's credentials but no consent step.

### Grants declared in YAML

An [OpenAPI](/tools/openapi-tools.md) entry's `auth: { oauth2 }` and an [MCP](/protocols/mcp.md) server's `mcp_auth: { oauth2 }` say which provider's token a tool sends ([ADR 0112](/decisions/0112-oauth-grants-declared-beside-the-tool.md)). `lib/tools/oauthTools.ts` turns the block into the token each call carries:

- **`authorization_code`**: the run's user's own token, read through `ctx.accessToken(provider)` at each call, so the consent pause above asks for it when the user has not granted it. A run with no credential store answers `unavailable`.
- **`client_credentials`**: the server's own token, from the token endpoint with the client id and secret (`clientCredentialsGrant`): held in process memory until 60 s before it expires, one request at a time, no redirect followed, a 10 s limit and a 64 KiB response bound, the endpoint held to the SSRF guard. It never enters the credential store, since no user owns it. A refusal is `grant_failed`, never the provider's text.
- **Secrets are variable names.** `client_id_env` and `client_secret_env` pass `credentialEnvProblem` (`lib/tools/credentialEnv.ts`), the rule OpenAPI `auth` already followed, so a YAML cannot send a framework secret to a token endpoint. A client-credentials variable that is not set fails the compile, naming the variable.
- **Where a token goes.** Only over https, or http to a loopback host (`tokenTransportProblem`), to the server the YAML names.
- **The consent step's clients.** `oauthClientsFor(configs)` builds `oauthConsent({ providers })` from the same YAML's authorization-code blocks, reading the client ids and secrets from their variables. Two declarations of one provider must agree, or it throws. `oauthRefreshProviders(clients)` gives the credential store (`credentialStore({ providers })`) the matching refresh hooks, so an expired user token is renewed at the same token endpoint with its refresh token (same guard and bounds, `grant_failed` on a refusal) rather than asking the person again.
- **The doctor** lists every tool that needs a grant: the agent, the provider, the grant, the scopes, and which of its variables are not set (names only).

## Server-side tools are markers

`web_search`, `x_search`, `url_context`, `collections_search` and `google_search` run on the provider's side, so they declare no function. Each is a **NativeToolMarker** (`lib/tools/tool.ts`, the instances in `lib/tools/nativeTools.ts`): a name, a description for a reader, and the `NativeTool` it stands for under the global symbol `melchizedek.nativeTool` ([ADR 0062](/decisions/0062-server-side-tools-as-markers.md)). `nativeToolMarkerOf()` reads it, and so does `nativeToolOf()` in `lib/models/schemaNormalize.ts`: the marker, never the class or the name, so a client-side tool registered as `web_search` stays a client-side tool, and a second copy of the module still matches. Code execution is not a marker: it is the agent's `code_execution: gemini`.

## Validation

A defined Tool validates in its own `execute`. Arguments the schema refuses return an **error string, never a throw**: the calling model sees what to fix and retries. The handler gets the parsed input, defaults applied, and a complete `ToolContext` on every surface. A defined Tool is still a `ToolContract`, so `executeContract()` and the MCP server run it unchanged, validating once.

## Schema dialects

`zodInputJsonSchema()` in `lib/models/schemaNormalize.ts` is the one place a zod schema becomes JSON Schema: the schema's input side, which is what MCP and the providers want. `toGeminiSchema()` derives Gemini's dialect from it (types UPPERCASED, the `default` keyword and a boolean `additionalProperties` dropped), which the [MCP](/protocols/mcp.md) parameters pass through once; `toContractJsonSchema()` lowercases a Gemini-dialect schema, such as a YAML `outputSchema` written in it, for every provider in [provider routing](/models/provider-routing.md). On both walks a field with a default is optional to the model, a property named `additionalProperties` or `default` keeps its schema because each walk follows schema keywords rather than key names, and a record keeps its value schema. A record's `propertyNames: { type: 'string' }` is left out at the source, since JSON keys are always strings and the Gemini API refuses the keyword with a 400; `toGeminiSchema` drops any other `propertyNames` for the same reason. `tests/models.test.ts` covers the lowercasing.

## Exposure is deliberate

Defining a contract publishes nothing. An agent sees a tool only when its name is registered — in `lib/toolRegistry.ts`, or by a package consumer's own call to `registerTool(name, tool)` with a contract, an own Tool or an InstructionTool — **and** declared in the syndicate YAML; an MCP client sees it only when a server script lists it in the `contracts` it passes to `serveContracts()` (`lib/tools/mcpServe.ts`; see [MCP](/protocols/mcp.md)). Every widening of the surface is a line of code someone chose; YAML can name only what code registered, never load it. The registry is a null-prototype map, so a name like `constructor` resolves to nothing and gets the unknown-tool warning. `registerTool` refuses the framework's reserved names (`RESERVED_TOOL_NAMES`: `adk_request_confirmation`, `adk_request_credential`, `adk_request_input`, `adk_handle_model_error`, `transfer_to_agent`, `set_model_response`, `finish_task`, and `ask_user` unless it is the framework's own tool), as the registry name or the tool's own, even with `{ override: true }`: a tool under one of them would be read as the framework's interrupt, delegation or answer.

Every client-side tool the registry holds is an own Tool. The [wiki tools](/tools/wiki-tools.md), the [clinical-evidence tools](/tools/evidence-tools.md), the [task tools](/tools/task-tools.md), the [web tools](/tools/web-tools.md)' `web_extract` and `x_api_search`, `generate_image`, `inspect_image`, `ask_user` and `load_memory` are contracts under this pattern. `preload_memory` and an agent's `examples:` are own InstructionTools. The server-side tools are own markers. Outside the registry, the [MCP](/protocols/mcp.md) tools and the [remote A2A agent](/protocols/a2a.md) tool are own Tools too.

## The examples block

An agent's `examples:` (input and output pairs) is an InstructionTool built by `examplesInstructionTool()` in `lib/tools/examples.ts`, named `example_tool`. Before each request it adds a few-shot `<EXAMPLES>` block to the instruction, each exchange numbered with its `[user]` and `[model]` text, word for word as ADK's `ExampleTool` rendered text examples, and only when the message that started the run begins with text. `tests/toolBaseRest.test.ts` compares the request with ADK's `ExampleTool`'s, recorded in `tests/fixtures/adk-reference/`, across models, instructions and messages.

## The memory tools

`lib/tools/memoryTools.ts` holds long-term memory's two tools ([memory architecture](/memory/architecture.md), [ADR 0059](/decisions/0059-memory-on-the-engines-own-interfaces.md)):

- **`load_memory`** takes a `query` and returns `{ memories: [{ content, author, timestamp }] }`, each memory's text parts joined by a space. While the run has memory, its `instruction` adds a note saying that memory exists and that `load_memory` searches it. With no memory service a call fails with `Memory service is not initialized.`
- **`preload_memory`** searches with the first text part of the message that started the run, and writes what it recalls into the instruction inside a `<PAST_CONVERSATIONS>` block: each memory's time on its own line, then its text after its author. It writes nothing when that part has no text, the run has no memory, nothing is recalled, or the search fails.

Both search through `ctx.searchMemory`, so a model's query chooses what to recall and never whose. The declaration, the note, the result and the block are word for word what ADK's `LoadMemoryTool` and `PreloadMemoryTool` produced. `tests/memoryTools.test.ts` compares each with ADK's tool as recorded in `tests/fixtures/adk-reference/` and runs one turn with each pair. Neither tool logs the query.
