# Changelog — melchizedek-agents (the npm package)

Consumers of the package read this file; it records changes to the
**published API surface** (the exports map in `package.json`, the bins,
the starter pack and the templates), not the repo's full history.

## Unreleased

### Added

- **An orchestrator that delegates can answer in its own `outputSchema`**
  (ADR 0109). An agent holding an `outputSchema` beside subagents or tools
  calls them first, then ends its turn on one JSON object matching the
  schema; no relay leaf or `dispatch:` block is needed (plan-dispatch stays
  available). On Claude from Opus 4.8, Sonnet 5 and Haiku 5.5, on every
  OpenAI id, and on Gemini 2 and later through Vertex AI, the schema now
  travels in the provider's own structured-output field in the same request
  as the tools (`output_config.format`, `text.format`, `responseJsonSchema`)
  instead of as a `set_model_response` tool, on the agent's `fallback_model`
  too; every other path keeps `set_model_response`. No YAML key changes.
- **The capability matrix gains `structured_output_with_tools`**
  (`melchizedek-agents/models/capabilities`): supported on Anthropic and
  OpenAI (and Gemini on Vertex AI), degraded (`set_model_response`) on the
  Gemini API, xAI, Moonshot, Ollama and the gateway. `npm run doctor` names
  it as a gap for an agent with a schema beside tools on a degraded path.
  `outputSchemaBesideTools(model)` says whether a model's path takes both.
  `CAPABILITIES`, `Capability` and `CAPABILITY_MATRIX` gain the member, so
  code that builds a `Record<Capability, …>` must add it.
- **OAuth grants in YAML (`auth: { oauth2 }`, `mcp_auth: { oauth2 }`;
  ADR 0112).** An `openapi:` entry's `auth` takes a third form, `oauth2`,
  and an agent with `mcp_server_url` may declare `mcp_auth: { oauth2 }`.
  The block names a `provider`, a `grant` (`authorization_code` or
  `client_credentials`), `authorization_url`, `token_url`, `client_id` or
  `client_id_env`, `client_secret_env` and `scopes`; secrets are
  environment variable names, never values, under the same rule as
  `bearer_env`. `authorization_code` sends the run's user's own token
  (`ctx.accessToken`, so the consent pause asks a user who has not granted
  it); `client_credentials` sends the server's own token from the token
  endpoint, held in memory until shortly before it expires. A token goes
  only over https (or http to a loopback host). An authorization-code MCP
  server needs `mcp_tools` and runs each user on their own connection.
  `npm run doctor` lists every tool that needs a grant. New module
  `melchizedek-agents/tools/oauthTools` (`oauthClientsFor`, which builds
  `oauthConsent({ providers })` from the YAML, `oauthRefreshProviders`,
  which gives `credentialStore({ providers })` the matching refresh hooks,
  `clientCredentialsGrant`,
  `oauthTokenSource`, `tokenTransportProblem`) and
  `melchizedek-agents/tools/credentialEnv` (`credentialEnvProblem`, still
  exported from `tools/openapiTools`), both under the existing `./tools/*`
  export. `ToolCredentialError` gains the codes `unavailable` and
  `grant_failed`, and `createMcpTools` / `loadMcpTools` an optional second
  argument. The systems_operator template carries a commented
  `mcp_auth` block.

- **A pause inside a delegated subagent reaches the turn** (WS6-2a,
  [ADR 0110](./wiki/decisions/0110-pauses-inside-delegated-subagents-reach-the-turn.md)).
  `require_approval` and `ask_user` are allowed on a delegated subagent, and
  gates inside a nested delegate syndicate (`yaml_reference`) no longer fail
  to load. The turn ends `input-required` with the request or question; the
  decision or answer goes back down to the subagent, which finishes before
  its caller continues. Before, a gate there was a load error and a pause
  answered the call with an empty text.
- `PendingApproval.path` and `PendingInput.path` (optional): the agents from
  the turn's own agent down to the one that asked, set only for a pause
  inside a delegated subagent. The A2A `approval_request` and
  `input_request` data parts carry `path` beside their fields when it is set.
- `delegatedPauses`, `openCalls`, `resumedDelegations` in
  `lib/runtime/native/interrupts.ts` and `resumeSubagent`, `SubagentPause` in
  `lib/runtime/native/delegate.ts` (engine internals; no exports map entry).
- **Pauses inside nested syndicates reach the turn** (WS6-2b,
  [ADR 0111](./wiki/decisions/0111-pauses-inside-nested-syndicates.md)). An
  approval request or `ask_user` question raised inside a `yaml_reference`
  subagent ends the turn `input-required` with the agent path, over
  `runSyndicateTurn` and A2A, and the answer resumes it. A nested dispatch
  syndicate may gate its classifier (a gate on one of its routes, which never
  run nested, is refused by name). A nested workflow delegated to as a
  subagent may hold `ask_user` nodes and gated agent nodes; the path ends at
  the node. As a dispatch route or a workflow node, a nested workflow's
  pauses stay refused, with a message that says so.
- `resumeWorkflowSubagent`, `childAppName`, `legacyChild` in
  `lib/runtime/native/delegate.ts` (engine internals; no exports map entry).

- **An orchestrator that delegates can answer in its own `outputSchema`**
  (ADR 0109). An agent holding an `outputSchema` beside subagents or tools
  calls them first, then ends its turn on one JSON object matching the
  schema; no relay leaf or `dispatch:` block is needed (plan-dispatch stays
  available). On Claude from Opus 4.8, Sonnet 5 and Haiku 5.5, on every
  OpenAI id, and on Gemini 2 and later through Vertex AI, the schema now
  travels in the provider's own structured-output field in the same request
  as the tools (`output_config.format`, `text.format`, `responseJsonSchema`)
  instead of as a `set_model_response` tool, on the agent's `fallback_model`
  too; every other path keeps `set_model_response`. No YAML key changes.
- **The capability matrix gains `structured_output_with_tools`**
  (`melchizedek-agents/models/capabilities`): supported on Anthropic and
  OpenAI (and Gemini on Vertex AI), degraded (`set_model_response`) on the
  Gemini API, xAI, Moonshot, Ollama and the gateway. `npm run doctor` names
  it as a gap for an agent with a schema beside tools on a degraded path.
  `outputSchemaBesideTools(model)` says whether a model's path takes both.
  `CAPABILITIES`, `Capability` and `CAPABILITY_MATRIX` gain the member, so
  code that builds a `Record<Capability, …>` must add it.
- **OAuth grants in YAML (`auth: { oauth2 }`, `mcp_auth: { oauth2 }`;
  ADR 0112).** An `openapi:` entry's `auth` takes a third form, `oauth2`,
  and an agent with `mcp_server_url` may declare `mcp_auth: { oauth2 }`.
  The block names a `provider`, a `grant` (`authorization_code` or
  `client_credentials`), `authorization_url`, `token_url`, `client_id` or
  `client_id_env`, `client_secret_env` and `scopes`; secrets are
  environment variable names, never values, under the same rule as
  `bearer_env`. `authorization_code` sends the run's user's own token
  (`ctx.accessToken`, so the consent pause asks a user who has not granted
  it); `client_credentials` sends the server's own token from the token
  endpoint, held in memory until shortly before it expires. A token goes
  only over https (or http to a loopback host). An authorization-code MCP
  server needs `mcp_tools` and runs each user on their own connection.
  `npm run doctor` lists every tool that needs a grant. New module
  `melchizedek-agents/tools/oauthTools` (`oauthClientsFor`, which builds
  `oauthConsent({ providers })` from the YAML, `oauthRefreshProviders`,
  which gives `credentialStore({ providers })` the matching refresh hooks,
  `clientCredentialsGrant`,
  `oauthTokenSource`, `tokenTransportProblem`) and
  `melchizedek-agents/tools/credentialEnv` (`credentialEnvProblem`, still
  exported from `tools/openapiTools`), both under the existing `./tools/*`
  export. `ToolCredentialError` gains the codes `unavailable` and
  `grant_failed`, and `createMcpTools` / `loadMcpTools` an optional second
  argument. The systems_operator template carries a commented
  `mcp_auth` block.

- **A pause inside a delegated subagent reaches the turn** (WS6-2a,
  [ADR 0110](./wiki/decisions/0110-pauses-inside-delegated-subagents-reach-the-turn.md)).
  `require_approval` and `ask_user` are allowed on a delegated subagent, and
  gates inside a nested delegate syndicate (`yaml_reference`) no longer fail
  to load. The turn ends `input-required` with the request or question; the
  decision or answer goes back down to the subagent, which finishes before
  its caller continues. Before, a gate there was a load error and a pause
  answered the call with an empty text.
- `PendingApproval.path` and `PendingInput.path` (optional): the agents from
  the turn's own agent down to the one that asked, set only for a pause
  inside a delegated subagent. The A2A `approval_request` and
  `input_request` data parts carry `path` beside their fields when it is set.
- `delegatedPauses`, `openCalls`, `resumedDelegations` in
  `lib/runtime/native/interrupts.ts` and `resumeSubagent`, `SubagentPause` in
  `lib/runtime/native/delegate.ts` (engine internals; no exports map entry).

- **An orchestrator that delegates can answer in its own `outputSchema`**
  (ADR 0109). An agent holding an `outputSchema` beside subagents or tools
  calls them first, then ends its turn on one JSON object matching the
  schema; no relay leaf or `dispatch:` block is needed (plan-dispatch stays
  available). On Claude from Opus 4.8, Sonnet 5 and Haiku 5.5, on every
  OpenAI id, and on Gemini 2 and later through Vertex AI, the schema now
  travels in the provider's own structured-output field in the same request
  as the tools (`output_config.format`, `text.format`, `responseJsonSchema`)
  instead of as a `set_model_response` tool, on the agent's `fallback_model`
  too; every other path keeps `set_model_response`. No YAML key changes.
- **The capability matrix gains `structured_output_with_tools`**
  (`melchizedek-agents/models/capabilities`): supported on Anthropic and
  OpenAI (and Gemini on Vertex AI), degraded (`set_model_response`) on the
  Gemini API, xAI, Moonshot, Ollama and the gateway. `npm run doctor` names
  it as a gap for an agent with a schema beside tools on a degraded path.
  `outputSchemaBesideTools(model)` says whether a model's path takes both.
  `CAPABILITIES`, `Capability` and `CAPABILITY_MATRIX` gain the member, so
  code that builds a `Record<Capability, …>` must add it.
- **`turnUntraced()`** (`melchizedek-agents/runtime/turnControl`) says
  whether the running code belongs to a turn that opted out of tracing;
  `createTurnControl` takes `untraced`, and `TurnControl` carries it.
  **`startEngineSpan(tracerName, name, options?)`**
  (`melchizedek-agents/observability/tracer`) starts a span the way the
  engine does: a non-recording one, without starting the tracer, inside an
  untraced turn.

### Changed

- **A delegated subagent's own session is filed under its agent path**
  (WS6-2b, ADR 0111): `<app>/<caller>/<subagent>`, and below a nested
  syndicate `<app>/<caller>/<subagent>/<inner>`, instead of the subagent's
  name alone, so two syndicates with a same-named subagent on one
  conversation no longer share it. A conversation stored before keeps its
  subagents' sessions under the old key: they are still read, continued and
  resumed. Code that read a subagent's session directly by its name reads
  the path instead. The stored events do not change.
- **An OpenAPI `auth` that sets two forms** now reads "exactly one of
  bearer_env, api_key or oauth2" (was "exactly one of bearer_env or
  api_key").

### Durable long-running runs (WS6-5, ADR 0113)

Apply migration `0014_durable_runs` (`melchizedek-db apply`) before
upgrading a server or worker that uses `DATABASE_URL`: the Postgres task
store writes `adk_a2a_tasks.cancel_requested_at`, and the worker writes
`melchizedek_tasks.checkpoint`.

- **The worker resumes a job instead of starting over.** `melchizedek-worker`
  checkpoints each job's sessions beside the job at every step boundary
  (Postgres: the `checkpoint` column; the JSON store: `<store>.checkpoints.json`).
  A job claimed again after its worker stopped resumes from its last
  checkpoint. A dispatch syndicate checkpointed inside an agent route
  starts over, and its classifier runs again.
- **SIGTERM re-queues the job in hand** with its checkpoint, so the next
  worker finishes it. Before, the job was recorded as failed.
- **A running background job can be cancelled.** `task_update` with
  `status: cancelled` now accepts a running job. The worker stops at its
  next lease renewal or checkpoint save and writes no result.
- **`TaskBackend` (`melchizedek-agents/tools/taskTools`), additive only:**
  - new optional members `saveCheckpoint` and `loadCheckpoint`;
  - `renew` may resolve `false` when the claim is gone;
  - new export `taskCheckpointPath`.

  A backend you wrote yourself still type-checks. It just does not
  checkpoint.
- **New module `lib/runtime/native/checkpoint.ts`** (`runDurableTurn`,
  `checkpointingSessions`). It is the worker's runner and is not in the
  exports map.
- **A2A cancel works across replicas** (`melchizedek-agents/storage/postgres`):
  - A `tasks/cancel` that reaches a replica not running the task answers
    `canceled` and records the request.
  - The replica holding the task's lease aborts the run on its lease
    heartbeat.
  - The stored task stays `canceled`.
  - The reaper keeps a cancel that was already reported.
  - New: `PostgresTaskStore.requestCancel(taskId, context)`, the optional
    `leases.cancelRequested` on `postgresStorage()`, and the optional
    `storage.leases.cancelRequested` option of `createA2AApp`.
- **A2A task cancelled during the turn-lock wait:** a task cancelled while
  waiting for its conversation's turn lock now ends `canceled`, not
  `rejected`.

### Fixed

- **`runSyndicateTurn({ trace: false })` records nothing.** It used to drop
  only the turn's root span: the agent, model-step, `llm.request` and tool
  spans still started the global tracer, so with `TELEMETRY_SUPABASE=true`
  an untraced turn still wrote `adk_telemetry` rows (and could write
  `adk_payloads` rows), and with `OTEL_EXPORTER_OTLP_ENDPOINT` set it still
  exported. Now a turn with `trace: false` opens no span of any kind, sends
  nothing to the ledger, the console exporter, `onSpanEnd` listeners or an
  OTLP endpoint, and does not start the tracer. Its step budget and its
  `usage` are unchanged. The default (traced) is unchanged, and the A2A
  server and the chat bin trace as before.
- **`mcp_server_url` and `mcp_tools` on the orchestrator are honoured.**
  The schema accepted them there, but only subagents read them, so a
  one-agent syndicate with an MCP server on its orchestrator got no MCP
  tools and no warning. The orchestrator now resolves them as a subagent
  does (narrowed by `mcp_tools`, gateable by its `require_approval`). On a
  plan-dispatch syndicate the orchestrator is the classifier, and an MCP
  server declared there is now dialled at compile time.

## 1.0.3 — 2026-10-09

Dependency updates and one packaging fix. No export, bin, YAML key or
adapter behaviour changes; no source file under `lib/` changes.

### Fixed

- **`config/agents/syndicate.schema.json` ships in the package.** The
  shipped `config/agents/syndicateSchema.yaml` names it in its
  `yaml-language-server` modeline, and `melchizedek-init` locates the
  package root by it; it was missing from `files`, so editors could not
  resolve the schema and, in an installed package, `melchizedek-init`
  stopped with "config/agents/ not found next to this package".
  `tests/packageSurface.test.ts` now checks that `files` ships it and
  every shipped modeline's target.

### Changed — dependencies

- `@anthropic-ai/sdk` ^0.129.0 → ^0.131.0. Additive (Admin and Managed
  Agents endpoints). The SDK now marks `claude-sonnet-4-5` and
  `claude-sonnet-4-5-20250929` deprecated (end of life 2026-11-30) and
  logs a `console.warn` when a request names them; no shipped syndicate
  uses either id.
- `openai` ^7.23.0 → ^7.28.0. Additive (Agents, Realtime, Responses
  WebSocket features). The client now keeps a base URL's query string
  when joining endpoints; this reaches the GPT adapter only when
  an `OPENAI_BASE_URL` carries a query (the Azure and xAI base URLs carry none;
  the Kimi, Ollama and gateway adapters do not use the SDK).
- `@modelcontextprotocol/sdk` ^1.29.0 → ^1.32.1 (lock 1.31.0 → 1.32.1).
  The SDK's HTTP client transports now follow redirects only within the
  endpoint's origin unless `redirectPolicy: 'follow'` is set. The MCP
  client's own fetch (`mcpFetch`, `lib/net/redirects.ts`) already follows
  every hop itself under `MCP_REDIRECTS`, so the SDK sees the final
  response and redirect behaviour is unchanged.
- `@google/genai` 2.25.0 → 2.27.0, still pinned exact. Additive
  (`continuation_token` in GenerateContent and Interactions, new model
  enum values).
- `@types/node` ^22 → ^25 (dev only). `engines.node` stays `>=22.6.0`; the
  source type-checks against both the Node 22 and Node 25 types.
- Dockerfile base image `node:22-slim` → `node:25-slim`, pinned by digest.

## 1.0.2 — 2026-10-09

A test and documentation patch. Nothing a consumer imports, configures or
runs changes behaviour, and no YAML key is added, removed or renamed.

### Fixed

- **`npm test`, and so `npm publish`, pass again from 2026-10-09.** The
  harness-example parity test (`tests/skillHarness.test.ts`) compared a
  native run against a recording made on 2026-10-08, and the
  `{{current_date}}` the example's instruction resolves moved with the
  clock, so from 2026-10-09 the comparison failed. The test now pins
  `current_date` to the recording's date.
- **The SIGTERM test holds under load.** `tests/serverShutdown.test.ts`
  waits up to 30 seconds for the server to start, polls for readiness to
  fail after the signal instead of checking once after a fixed 300 ms,
  and runs with a 3-second delay and a 6-second grace budget, so a busy
  machine no longer fails it on timing.

### Changed

- **Wording only: the shipped files describe the engine, not ADK.** The
  example syndicates' comments (`critic.yaml`, `scribe.yaml`,
  `research.yaml`, `image_production.yaml`, `librarian.yaml`,
  `weather.yaml`, `pipeline.yaml`), `config/agents/syndicateSchema.yaml`,
  `DOCUMENTATION.md` and the `melchizedek-author` skill no longer describe
  Google ADK as running or enforcing anything; ADK appears only as history
  or as the origin of a key's spelling. The rule that an `outputSchema`
  belongs on a leaf is stated as what it is: the engine accepts the schema
  on an agent that delegates, and that agent then answers with the JSON
  instead of relaying a subagent's answer. The same wording reaches the
  schema descriptions in `lib/syndicateSchema.ts` and the generated
  `config/agents/syndicate.schema.json` (`outputSchema`, the root agent,
  the workflow `retry` defaults, `retries`), and the reserved-name message
  for an agent called `user`. No key, default or behaviour changes;
  `thinkingBudget` and the other older spellings are still accepted.

## 1.0.1 — 2026-10-08

### Fixed

- **The published package carries only this release's build.** `npm run
  build` (which `npm pack` and `npm publish` run) now empties `dist/`
  before compiling. 1.0.0 was packed from a checkout whose `dist/` still
  held files from older builds, so its tarball carried 40 stale modules the
  1.0.0 source no longer has (among them `models/adkShim`, the ADK
  `*Llm` classes, `models/tracedGemini`, `models/fallback`,
  `tools/adkTool`, `tools/webSearchTool`, `runtime/adkSessionBridge`).
  The `./models/*` and `./tools/*` export patterns made them importable,
  and they load `@google/adk`, which 1.0.0 removed. Everything 1.0.0
  documents was built from its own source; only those extra files were
  wrong. Use 1.0.1; 1.0.0 is deprecated.

## 1.0.0 — 2026-10-08

Release 1.0.0: Google ADK is gone (ADR 0107). Every turn runs on the
engine's own agent loop and workflow scheduler, which have been the default
since 0.20.0; the ADK runtime, the ADK peer dependency and everything that
existed only for them are removed. What a conversation stores does not
change: sessions written by ADK, or by 0.x on either runtime, resume.

### Breaking — read before upgrading

- **Breaking: the ADK runtime is removed.** `native` is the only runtime.
  `MELCHIZEDEK_RUNTIME=adk` is a startup error: `createA2AApp` (the A2A
  server), `melchizedek-chat` and `melchizedek-worker` throw the new
  `RuntimeRemovedError`, which names 1.0.0 and the fix, and
  `runSyndicateTurn` throws it for `runtime: 'adk'` before the session is
  touched. `melchizedek-doctor` reports it as a problem (`--check` fails).
  `MELCHIZEDEK_RUNTIME=native` is still accepted and changes nothing.
  `RuntimeName` is `'native'`; `RUNTIMES` is `['native']`.
- **Breaking: `@google/adk` is no longer used.** It is gone from
  `peerDependencies`, `peerDependenciesMeta` and `devDependencies`, and
  nothing in the package loads it: uninstall it. The package has no
  top-level `await` any more, so it loads from CommonJS through `require()`
  again (Node's `require(esm)`: on by default from Node 22.12, behind
  `--experimental-require-module` on 22.6–22.11). `@google/genai` stays a
  dependency, used only by the Gemini adapter, the image tools and memory
  embeddings.
- **Breaking: `runSyndicateTurn` takes the engine's session and memory
  interfaces.** `sessionService` is a `SessionService`
  (`lib/runtime/sessions.ts`: `create`, `get`, `list`, `delete`, `append`)
  and `memoryService` a `MemoryService` (`lib/runtime/memoryService.ts`:
  `ingest`, `search`), no longer ADK's `BaseSessionService` and
  `BaseMemoryService`. The parameter names, the option keys and the result
  are unchanged. `ingestTurnMemory` takes the same two interfaces and calls
  `memoryService.ingest`. `TurnEvents.onEvent` receives a `TurnEvent` (the
  JSON ADK's `Event` carried). `transformAgent` transformed ADK agents: any
  value is refused with `UnsupportedOnRuntimeError` before the session is
  touched.
- **Breaking: the stores and the memory service lose their ADK methods.**
  `InProcessSessionService`, `PostgresSessionService`,
  `SupabaseSessionService` and `ProjectedSessionService` are the engine's
  `SessionService` only: `createSession`, `getSession`, `listSessions`,
  `deleteSession` and `appendEvent` are gone (use `create`, `get`, `list`,
  `delete`, `append(session, event)`). `ProjectedSessionService` takes an
  engine store. `SupabaseVectorMemoryService` drops `addSessionToMemory`
  and `searchMemory` (use `ingest(session, { extractionRules,
  extractionModel })` and `search`); `namespacedMemoryService` pins `search`
  and `ingest`. The A2A app's `storage.sessionService` and
  `storage.memoryService` take the engine's interfaces. The stored rows are
  unchanged.
- **Breaking: `GEMINI_ADAPTER=adk` is an error.** Every Gemini id runs on
  the engine's `GeminiAdapter`. `GEMINI_ADAPTER=engine` (or
  `{ gemini: 'engine' }`) is accepted and changes nothing; `adk` throws an
  error naming 1.0.0. `GeminiAdapterChoice` is `'engine'`.
- **Breaking: removed exports.** From `melchizedek-agents`:
  `AdkNotInstalledError`, `adkInstalled`, `asAdkSessionService`,
  `asSessionService`, `compileGraph`, `compileSubagent`, `compileWorkflow`,
  `CompiledWorkflow`, `toFunctionTool`, `registerAvailableProviders`,
  `GatewayLlm`. From `melchizedek-agents/runtime`: the same runtime names,
  and `retryPlugins` (self-correction is the loop's own, from `retries:`).
  From `melchizedek-agents/compile`: `compileGraph`, `compileSubagent`,
  `requireApprovalOn`, `requireApprovalOnBaseTool` (gate an own Tool with
  `requireApproval`), and `CompileOptions.nodeConfig`. From
  `melchizedek-agents/models/registry`: `registerAvailableProviders`,
  `GatewayLlm`, `TracedGemini`. These subpaths resolved to deleted files and
  are gone: `melchizedek-agents/models/adkShim`, `models/adkGeminiAdapter`,
  `models/tracedGemini`, `models/claudeLlm`, `models/gptLlm`,
  `models/grokLlm`, `models/kimiLlm`, `models/ollamaLlm`, `models/gatewayLlm`,
  `models/openAiCompatibleLlm`, `models/fallback`, `tools/adkTool`,
  `tools/webSearchTool`, `tools/urlContextTool`, `tools/xSearchTool`,
  `tools/collectionsSearchTool` (the server-side tools are the markers in
  `melchizedek-agents/tools/nativeTools`). `lib/workflow.ts` keeps the
  `workflow:` block's contract; `compileWorkflow`, `assembleWorkflow`,
  `toRetryConfig` and `nodeSettings` are gone. The exports map's paths are
  unchanged.
- **Breaking: tools are the engine's own, and ADK tools are refused.** The
  registry holds the engine's `Tool`, `InstructionTool`, `NativeToolMarker`
  and `Toolset` (`lib/tools/tool.ts`), with no ADK `FunctionTool` around
  them. `webExtractTool`, `generateImageTool`, `inspectImageTool`,
  `xApiSearchTool`, `remoteAgentTool()`, `createMcpTools()` and
  `buildOpenApiTools()` return own `Tool`s (`declaration()`,
  `execute(args, ctx)`). `registerTool` refuses an ADK tool (anything with
  `runAsync`) with an error that names 1.0.0 and `defineTool`, and refuses
  an object that is not a tool. `toFunctionTool`'s replacement: define the
  tool with `defineTool` (a zod schema and `execute(args, ctx)`) and
  register it; a `defineTool` contract is the engine's `Tool`.
  `runWikiAgent` (`melchizedek-agents/wiki/agentRun`) takes `tools: Tool[]`.
- **Breaking: a model resolver returns an id or a `ModelAdapter`.**
  `CompileOptions.resolveModel` returns `string | ModelAdapter | undefined`
  (`melchizedek-agents/model`), and the registry's `resolveModel` returns
  the engine's `ModelAdapter`, with the same BYOK scoping. A resolver that
  returns an ADK model class is refused with `UnsupportedOnRuntimeError`
  before any model call. `registerAvailableProviders` is replaced by
  `logProviderStatuses(log?)`, which returns and logs the provider statuses
  and registers nothing: a model id resolves when an agent first calls it.
  `modelExtractor`'s `resolve` seam returns a `ModelAdapter`.
- **Breaking: a resolver's plain `{ model, apiKey }` object is refused.**
  Anything `resolveModel` returns that is neither a model id string, a
  `ModelAdapter` (an object with `generate()` and a string `model`) nor
  `undefined` is refused with `UnsupportedOnRuntimeError` when the agent is
  compiled, before any model call; the message names 1.0.0 and the type of
  what came back, never its contents. Before, the engine passed such an
  object over and resolved the agent's YAML id on the environment's key, so a
  BYOK caller ran on the operator's key. A BYOK resolver returns an adapter,
  for example `new ClaudeAdapter({ model, apiKey })` from
  `melchizedek-agents/model`.
- **Breaking: an ADK tool is refused everywhere.** An object with
  `runAsync` is refused with an error naming 1.0.0 and `defineTool` wherever
  it arrives: `registerTool`, a compiled agent's tool list, a workflow tool
  node, a Toolset's `getTools()` and `extraTools` on a model request. Before,
  the last two skipped it silently.
- **Breaking: `createA2AApp` stops on `GEMINI_ADAPTER=adk`** at startup with
  the 1.0.0 error, as it does on `MELCHIZEDEK_RUNTIME=adk`, instead of
  failing at the first Gemini call.
- **Breaking: dead model and tool exports removed.**
  `melchizedek-agents/models/errorResponse` drops `providerErrorResponse` and
  `isRetryableErrorResponse` (use `withRetryVerdict(response,
  errorDecision(err))` and read `customMetadata['error.retryable']`);
  `models/schemaNormalize` drops `toolDeclarationFor` (use
  `contractToolDeclaration`); `models/claudeAdapter` drops
  `ClaudeModelRequest` and its `claudeReasoning`; `models/chatCompletionsAdapter`
  drops `ChatCompletionsRequest` and `OlderSpelling` (adapters take
  `ModelRequest`). `melchizedek-agents/tools/toolContract` drops
  `toolCallContextFrom`, and `melchizedek-agents/tools/tool` drops
  `OWN_TOOL`; `toolOf`, `instructionToolOf` and `toolsetOf` no longer look
  inside a wrapper. `nativeToolOf` recognises only the engine's own marker.
  Kimi K3 no longer sends `reasoning_effort: max`, which had no contract
  level and was reachable only through the removed older spelling.
- **Breaking: the doctor's runtime report has no `adk` field.**
  `runtimeReport()` returns the runtime and its source, or the problem.

### Migration

1. `npm uninstall @google/adk`, and unset `MELCHIZEDEK_RUNTIME=adk` and
   `GEMINI_ADAPTER=adk` wherever they are set.
2. Replace `new InMemorySessionService()` and
   `asAdkSessionService(new InProcessSessionService())` with
   `new InProcessSessionService()` (or your Postgres or Supabase store), and
   call `create` / `get` / `append(session, event)` where you called
   `createSession` / `getSession` / `appendEvent`.
3. Replace a custom `BaseMemoryService` with a `MemoryService`
   (`ingest`, `search`).
4. Replace ADK `FunctionTool`s and `toFunctionTool(...)` with `defineTool`
   contracts, and register them with `registerTool`.
5. Replace `registerAvailableProviders()` with `logProviderStatuses()`.
6. A custom `resolveModel` returns a model id or a `ModelAdapter`
   (`resolveAdapter` from `melchizedek-agents/model`), not an ADK `BaseLlm`.
   A resolver that returned a plain `{ model, apiKey }` object returns an
   adapter built with that key instead (`new ClaudeAdapter({ model, apiKey })`
   or the provider's own adapter class); the plain object is refused.
7. Run turns through `runSyndicateTurn` where you compiled ADK agents with
   `compileGraph`, `compileSubagent` or `compileWorkflow`.

### Fixed

- **Server-side tool calls are recorded again.** A GPT or Grok answer that
  searched (web search, X search, collections) records its server-side tool
  calls as `ToolCall` events and counts them in the ledger row's
  `tool_calls`. Since 0.20.0 made the engine's loop the default, those
  calls were lost: the record lived in the deleted ADK shim. The native step
  carries them onto the final (`lib/runtime/native/step.ts`);
  `tests/nativeLedgerCounts.test.ts` pins it.

### Unchanged by design

- The stored Event JSON (`adk_sessions.events`, `adk_session_events`), the
  interrupt names (`adk_request_confirmation`, `ask_user`,
  `adk_request_input`, `adk_request_credential`) and their argument shapes,
  the A2A surface, and the table names. The ADK-written session fixtures
  (`tests/fixtures/sessions`) resume.

### Added and changed

- **One output-token meaning on the ledger (ADR 0107).** For every
  provider, `output_tokens` (and `llm.tokens.output`) excludes the thinking
  and `thinking_tokens` carries it, so output plus thinking is the
  provider's own output count. This is what the engine's loop has written
  since 0.20.0; it supersedes the ledger clauses of ADR 0056 and ADR 0057,
  which kept the provider's meaning on the ADK path. Rows written before
  0.20.0 for GPT, Grok, Kimi and the gateways used that older meaning: a
  query comparing output across that boundary subtracts `thinking_tokens`
  from those rows.

- **New exports.** From the barrel and `melchizedek-agents/runtime`:
  `RuntimeRemovedError`, and the types `SessionService`, `Session`,
  `SessionKey`, `MemoryService`, `MemoryEntry`, `MemoryIngestOptions`,
  `MemorySearchRequest`, `MemorySearchResult` and `TurnEvent`. From the
  barrel: `UnsupportedOnRuntimeError`, `logProviderStatuses`, and the types
  `Tool` and `ToolContext`.
- **An import-graph test holds the line** (`tests/importGraph.test.ts`):
  nothing under `lib/` or `scripts/` names Google ADK, and `@google/genai`
  is imported only by the Gemini adapter and its genai mapping, the image
  tools and memory embeddings.

- **A workflow syndicate runs its whole graph as a dispatch route or a
  workflow node (ADR 0106).** A `yaml_reference` to a workflow syndicate
  used to run its orchestrator alone there; it now runs the whole graph on
  the child session filed under the entry's name, as a delegated subagent
  already did (ADR 0098). As a plan-dispatch route its last output is the
  turn's answer, and the conversation keeps the message and that answer. As
  a workflow node its last output is the node's output. A `map` over
  one and an `ask_user` node inside one are refused by name. Each nested
  walk has its own node-run ceiling (ADR 0105). **Breaking for a direct
  caller:** `compileSubagentSpec` refuses a workflow reference by name
  instead of compiling its orchestrator; compile the entry
  with `compileEntrySpec`. `melchizedek-agents/compile` adds
  `compileEntrySpec`, `EntrySpec`, `workflowAgentSpecs`,
  `workflowEntryNames` and `WorkflowSpec.workflows`; the exports map and the
  barrel are unchanged.

- **Skill scripts on a workflow node (ADR 0106).** `skills.scripts: local`
  is allowed on a workflow node's agent: each `run_skill_script` call pauses
  the node and the walk for a person's approval, as `require_approval` does,
  and runs once after it, with the minimal script environment of ADR 0086.
  Still refused on an agent a `map` node runs.

- **Docs: `config/agents/syndicateSchema.yaml` describes the engine as it
  runs.** Its comments say that the runtime runs every key, explain the ADK
  spellings and "Maps to:" lines as spellings, prefer
  `reasoning:` over `generateContentConfig.thinkingConfig`, and no longer
  call Gemini "ADK-native", plan-dispatch "A2A-only", or `require_approval`
  unsupported inside a workflow. Comments only.

- **A workflow walk has a node-run ceiling (ADR 0105).** `max_steps`
  counts model calls, so a routed cycle through nodes that make none (a tool
  node and its route step looping on each other) ran until the turn's
  deadline. A walk now starts at most
  `max(20 × max_steps, 100)` node runs (1,000 at the default of 50); the run
  that would pass it fails its node with `NodeRunLimitError`, stored as the
  workflow's node-error event, and the turn fails with the new error code
  `NODE_RUN_LIMIT` and the progress line `Stopped: the workflow reached its
  limit of <n> node runs`. A legitimate loop under the ceiling is unchanged;
  raise `max_steps` to raise it.

- **Docs: the shipped documentation describes the engine as 1.0.0 runs it
  (WS5-3, WS5-2b).** `README.md`, `QUICKSTART.md`, `DOCUMENTATION.md`,
  `AGENT_SETUP.md` and the agent skills under `skills/` describe the
  engine's own loop, model contract, tools, sessions and workflow
  scheduler, with no ADK to install, and no longer call Gemini
  "ADK-native".

## 0.20.0 — 2026-10-08

Release 0.20.0: the native runtime is the default, and `@google/adk` is an
optional peer (ADR 0102).

### Breaking — read before upgrading

- **Breaking: the native runtime is the default (WS5-1, ADR 0102).** A
  turn with no `runtime` option and no `MELCHIZEDEK_RUNTIME` now runs on the
  engine's own loop and scheduler (`DEFAULT_RUNTIME` is `native`), on every
  surface: `runSyndicateTurn`, the A2A server, the bins, the wiki agents.
  It stores the events the ADK runtime stores, and every session ADK wrote
  resumes under it (`tests/sessionFixtures.test.ts`, ADR 0045's stop rule),
  so a deployment that upgrades keeps its conversations. **To stay on ADK**
  for this release: install `@google/adk@~2.2.0` beside the package and set
  `MELCHIZEDEK_RUNTIME=adk` (or pass `runtime: 'adk'`); a conversation can
  move between the runtimes either way. What differs on native: approval
  gates on workflow nodes run on native only (ADR 0098); `context:`
  compaction, `mode: task` and workflows run on the engine's ports of ADK's
  compactor, task mode and scheduler (ADR 0078, ADR 0081, ADR 0087, ADR
  0095); a Gemini agent is not shown the reflection tool and stores no
  `turnComplete` (ADR 0097, ADR 0100); self-correction's reflection call on
  Gemini 3 is signed (ADR 0103); a caller's `transformAgent` is ADK-only,
  and an `ask_user` tool listed on a workflow agent node (rather than an
  `ask_user` node) is refused, each with `UnsupportedOnRuntimeError` before
  any model call (ADR 0073, ADR 0092). **1.0.0
  removes the adk runtime** (ADR 0045).
- **Breaking: `@google/adk` is an optional peer dependency.** npm no longer
  installs it with the package; nothing on the native runtime loads it, and
  `lib/adkPeer.ts` is the one module that tries to. Without it, everything
  only ADK runs fails with the new `AdkNotInstalledError`, which names the
  package and the install command: `MELCHIZEDEK_RUNTIME=adk`,
  `compileGraph` / `compileSubagent` / `compileWorkflow`, `retryPlugins`,
  `GEMINI_ADAPTER=adk`, a wiki agent on adk, and the ADK face of a tool, a
  model shim or a session store (their `runAsync`, `generateContentAsync`,
  `appendEvent`). The engine's classes that extend ADK's (the
  `FunctionTool`s in the tool registry, the model shims, the session
  stores) still construct and still carry their own Tool, adapter or store;
  with ADK installed they are ADK's own classes, as before. An install of
  ADK that fails to load for another reason is still an error. A
  TypeScript consumer without ADK sees ADK's types in the declarations as
  unresolved (use `skipLibCheck`). The package now uses a top-level
  `await` to load the peer, so it cannot be `require()`d from CommonJS.
- **Breaking: a Gemini id gets the engine's `GeminiAdapter` by default
  (ADR 0100).** `resolveAdapter` from `melchizedek-agents/models/registry`
  and `geminiAdapterChoice()` default to `engine`; `GEMINI_ADAPTER=adk`
  (or `{ gemini: 'adk' }`) keeps `AdkGeminiAdapter` for this release, with
  `@google/adk` installed. The adk runtime keeps `TracedGemini`.
- **Breaking: `registerTool` refuses the framework's reserved names.**
  `adk_request_confirmation`, `adk_request_credential`,
  `adk_request_input`, `adk_handle_model_error`, `transfer_to_agent`,
  `set_model_response`, `finish_task`, and `ask_user` unless it is the
  framework's own tool, are refused as the registry name or the tool's own
  name, with `{ override: true }` too: a tool under one of them would be
  read as the framework's interrupt, delegation or answer.
  `RESERVED_TOOL_NAMES` is exported from `melchizedek-agents/tools`.
- **Breaking: a workflow `map:` node refuses `retry` and `timeout`
  (ADR 0103).** Neither runtime ever applied them: each item of a map runs
  under the mapped agent's own node entry, as ADK runs it. A YAML that set
  them on the map entry loaded and silently ignored them; it is now refused
  at load with `workflow.nodes.<Map>.retry — retry on a map node is not
  applied: each item runs under its agent's own retry; set it on
  nodes.<Agent>` (and the same for `timeout`). Move the keys to the mapped
  agent's entry. No shipped example or template sets them.

### Added and changed

- **The doctor prints the runtime (ADR 0102).** `melchizedek-doctor` opens
  with a `runtime` line: the runtime in use, where it came from
  (`MELCHIZEDEK_RUNTIME` or the default) and whether `@google/adk` is
  installed, with its version. `--check` also fails when
  `MELCHIZEDEK_RUNTIME=adk` is set without ADK, or holds a value no turn
  accepts. `runDoctor()` returns it as `runtime`, and `runtimeReport` is
  exported from `lib/doctor.ts`.
- **New exports.** From the barrel and `melchizedek-agents/runtime`:
  `describeRuntime` (the runtime and its source), `RuntimeSource`,
  `AdkNotInstalledError`, `adkInstalled`, `InProcessSessionService` (a
  session store that needs no ADK) and `asAdkSessionService` /
  `asSessionService`; the barrel also exports `DEFAULT_RUNTIME` and
  `RuntimeName`. A turn without ADK takes
  `sessionService: asAdkSessionService(new InProcessSessionService())`.
  The exports map does not change.
- **CI consumes the packed tarball twice**: without `@google/adk` a shipped
  example's turn runs on native, and with it the same turn runs on adk.

- **The native loop's security gate (WS5-5, ADR 0101).** A model's answer is
  now held to the model contract before either runtime stores it:
  `modelResponseToLlmResponse` in `melchizedek-agents/models/genaiMapping`
  drops a part the contract does not allow (an unknown kind, `null`, a text
  part whose text is not a string, a tool result) and coerces a tool call's
  name, id and arguments (`{}` for none, `{ raw }` otherwise); the new
  `contractModelResponse` export is that check. A call's arguments or a
  tool's result nested deeper than 64 levels is replaced by a short note
  (`TOO_DEEP_ARGUMENTS`; on the native runtime `TOO_DEEP_RESULT`), where it
  used to fail that turn and every later one on the session. A
  `yaml_reference` chain that reaches itself, or goes past 16 levels, now
  fails the compile with an Error naming the chain, on both runtimes; it
  used to overflow the stack and stop the process. On the native runtime a
  call id `__proto__` opens its approval as any id does, a credential
  request in an event the user wrote is not pending, a resumed OAuth call
  is the one the agent made, and a replayed grant runs nothing.
  `wiki/operations/native-loop-security.md` is the threat model;
  `tests/nativeFuzz.test.ts` fuzzes the loop.
- **On the native runtime, self-correction's reflection call is signed on
  Gemini (ADR 0103).** When a Gemini 3 model calls the reserved
  `adk_handle_model_error` tool, or answers `MALFORMED_FUNCTION_CALL`, the
  reflection call stored in its place now carries the replaced call's
  `thoughtSignature`, or Gemini's documented placeholder
  (`skip_thought_signature_validator`) when there was none, so the next
  request no longer fails with Gemini's "missing a thought_signature" 400.
  On Gemini 2.x only a carried signature is added. The ADK runtime is
  unchanged: ADK's plugin still stores the call unsigned. The stored event
  differs from ADK's by that one field. `PLACEHOLDER_THOUGHT_SIGNATURE` is
  still exported from `melchizedek-agents/models/geminiAdapter`.

- **A workflow node's `retry` takes `exceptions` and `jitter` (ADR 0103).**
  `retry: { exceptions: [NodeTimeoutError] }` retries only a failure whose
  error class or `name` is listed; `jitter` sets the backoff's randomness
  (0 = none, default 1). Both runtimes honour them: the ADK runtime hands
  them to ADK's `retryConfig`, the native scheduler applies them as ADK's
  `retry_utils` does. `syndicate.schema.json` is regenerated; the `exports`
  map is unchanged.

- **The capability matrix's Gemini column is asserted on the engine's own
  Gemini adapter (WS3-6, ADR 0100).** Every Gemini cell is now evidence
  `test`, checked against the request `GeminiAdapter` sends through the
  real `@google/genai` client, as every other column is; `npm run doctor --
  --matrix` says so. On the native runtime a Gemini agent's stored events no
  longer carry `turnComplete`, as the ADK runtime's never have; nothing reads
  the field. A Gemini answer that ran code through the engine's adapter
  (`GEMINI_ADAPTER=engine`, or `GeminiAdapter` behind the shim) now stores
  the `executableCode` and `codeExecutionResult` parts as ADK's Gemini stores
  them, where the session held none before; `partsToGenai` in
  `melchizedek-agents/models/genaiMapping` is the mapping that writes them
  out. `scripts/gemini_engine_check.ts` is the live check gate G3 runs:
  grounding, code execution, a function tool beside server-side tools, and a
  two-turn session, with `GeminiAdapter` on both runtimes. `GeminiAdapter`
  becomes the default in 0.20.0 (see Breaking above).

- **A workflow syndicate can be a subagent, and a workflow node can carry
  an approval gate (WS4-7, ADR 0098).** A DELEGATE syndicate's
  `yaml_reference` to a `workflow:` syndicate now runs the whole graph as
  the subagent tool, under the entry's name and description, on both
  runtimes: the graph's last output is the tool's answer. Before, only the
  nested syndicate's orchestrator ran. A nested workflow with an
  `ask_user` node is now refused by name at compile time (its pause could
  not reach the caller); as a dispatch route or a workflow node, a
  workflow syndicate is still its orchestrator alone. `require_approval`
  on a workflow node's agent now validates (except on an agent a `map`
  node runs): on the native runtime the gated call pauses the node and the
  turn ends `input-required` with `result.approval`, and the person's
  decision runs or refuses the pinned call once and walks on; another
  message repeats the request. On the ADK runtime a gated workflow throws
  `UnsupportedOnRuntimeError` before any model call, because ADK's resume
  restarts the node and never runs the call. `melchizedek-agents/compile`
  adds the `workflow` kind to `SpecTool`, and exports
  `compileWorkflowSpec` and the `WorkflowSpec` type.
- **A Gemini agent on the native runtime is no longer shown the reflection
  tool (WS4-6b, ADR 0097).** With `retries.model_errors` on (the default),
  native declared `adk_handle_model_error` to every model. ADK's own Gemini
  never sends it, and a Gemini 3 model that called it on native failed its
  next step with Gemini's missing `thought_signature` 400 (a workflow
  node then failed the turn `NODE_FAILED`). Native now sends a Gemini model
  the same tools as ADK; a model on any other provider, or a Gemini adapter
  a resolver returns behind `adkShim`, is still told of the tool, as on ADK.
  ADK turns are unchanged.

## 0.19.0 — 2026-10-08

The native runtime ships in this release as an opt-in: set
`MELCHIZEDEK_RUNTIME=native` or pass `runtime: 'native'` to `runSyndicateTurn`.
`adk` stays the default (ADR 0099). The `@google/adk` peer dependency is
unchanged.

### Breaking — read before upgrading

- **Breaking: a skill script no longer inherits the server's environment
  (ADR 0086).** An approved `run_skill_script` starts from PATH,
  HOME/USERPROFILE, TMPDIR/TEMP/TMP, LANG, LC_*, TZ, the user's name and
  the Windows essentials, and nothing else: provider keys, `DATABASE_URL`
  and the server's bearer secrets no longer reach it. A script that relied
  on an inherited variable must now name it in the agent's YAML, under the
  new `skills.env` (names only), or under `skills.secret_env` when the
  name looks like a secret (KEY, TOKEN, SECRET, PASSWORD, AUTH, DATABASE,
  …), which `skills.env` refuses. Both need `scripts: local`. A script's
  stdout and stderr are each cut at 20,000 characters, ending with
  `[stdout truncated: N more characters not shown (the limit is 20000)]`.
  The same on both runtimes. `LocalScriptExecutor` takes `envNames`,
  `sourceEnv` and `maxOutputChars`; `lib/tools/skills/env.ts` is new. The
  `exports` map is unchanged.
- **Breaking for subclasses of `OpenAiCompatibleLlm`: the chat-completions
  adapters move onto the model contract (ADR 0057).** New modules under
  `melchizedek-agents/models/`:
  - `chatCompletionsAdapter`: `ChatCompletionsAdapter`, the base that turns a
    `ModelRequest` into a chat-completions body and a completion (JSON or
    SSE) into contract responses; `ChatCompletionsRequest` and
    `OlderSpelling`; `chatUsage` and `sumUsage` (usage in the contract's
    meaning); `splitThinkBlocks`, `ThinkStreamSplitter`,
    `REASONING_CONTENT_KIND` and `ENGINE_CALL_ID_PREFIX`.
  - `ollamaAdapter` (`OllamaAdapter`), `kimiAdapter` (`KimiAdapter`, and
    `isKimiK3`, `wantsReasoningReplay`, `MOONSHOT_BASE_URL`, which
    `models/kimiLlm` still exports) and `gatewayAdapter` (`GatewayAdapter`).

  `OpenAiCompatibleLlm` is now an `AdkShim` whose constructor takes the
  adapter, and its protected hooks (`endpointUrl`, `headers`,
  `wireModelName`, `extraBodyFields`, `httpError`, `noAnswerError` and the
  rest) move to `ChatCompletionsAdapter`, on contract types. A provider of
  your own subclasses `ChatCompletionsAdapter` and runs under ADK as
  `adkShim(adapter)` or as an `OpenAiCompatibleLlm` subclass. `OllamaLlm`,
  `KimiLlm` and `GatewayLlm` keep their constructors, ids, error codes and
  wording, and the shape of what they yield: usage counts the reasoning in
  `candidatesTokenCount` as before, so the ledger's counts are unchanged.
  `models/openAiCompatibleLlm` adds `olderSpellingOf` and
  `chatUsageMetadata`. `AdkShim` gains a protected `toModelRequest` seam
  beside `toLlmResponse` (ADR 0056); the chat shims override both.

  What reaches the provider changes only where the contract maps a field
  the old classes ignored or spelled as written:
  - `stopSequences` are sent as `stop`.
  - A function-calling mode is honoured: `NONE` sends no tools; the gateway
    sends `ANY` as `tool_choice: required` or the named tool, and Kimi and
    Ollama weaken it to auto (`llm.tool_choice.weakened` on the span).
  - The older spelling's reasoning follows ADR 0047's mapping, as
    `reasoning:` already did: `thinkingConfig.thinkingBudget` alone now
    travels as its level (`0` is `none`), `reasoningEffort: medium` on
    `kimi-k3` is sent as `high`, and `minimal` as each model's `none`.
    A word that is no level (`max`, `xhigh`) is still sent as written.
  - A tool call stored without an id is sent with one, matched to its
    result, where the result's `tool_call_id` was empty.
  - The no-answer hints name `reasoning: none` (the older spelling too).
  - Every error a chat shim yields carries its retry verdict
    (`customMetadata['error.retryable']`, `false` where there was none) and
    `turnComplete`. A call cut off by a cancelled turn is never retryable,
    even when its last status was a 503, so no fallback answers a
    cancellation.
- **Breaking for subclasses of `GptLlm`: the vendor hooks move to
  `GptAdapter` (ADR 0056).** `providerId()`, `baseURL()`, `apiKeyFromEnv()`,
  `missingKeyMessage()`, `clientOptions()`, `reasoningParam()`,
  `replaysReasoning()` and `endpoint()` are overridden on a `GptAdapter`
  subclass now, as `GrokAdapter` does, and a `GptLlm` subclass returns it
  from `protected static createAdapter(options)`. Code that only constructs
  or registers `GptLlm` and `GrokLlm`, or imports their exported functions,
  is unaffected.
- **Breaking for one import path: `toFunctionTool` moves to
  `melchizedek-agents/tools/adkTool` (ADR 0051).**
  `melchizedek-agents/tools/toolContract` no longer exports it, so that
  module loads nothing from `@google/adk`. Import it from
  `melchizedek-agents`, which still exports it, or from the new subpath.
  The `exports` map is unchanged.

### Changes

- **Workflow syndicates run on the native runtime (WS4-6, ADR 0095).**
  A `workflow:` syndicate no longer throws `UnsupportedOnRuntimeError` on
  `runtime: 'native'` (or `MELCHIZEDEK_RUNTIME=native`): the engine's own
  scheduler walks the graph, and `runSyndicateTurn` returns the same
  result, stored events, progress lines, `answer.nodeErrors`, text deltas
  and ledger rows as on ADK. An `ask_user` node pauses the turn
  `input-required` with `result.input`, and the next message resumes it,
  also in a session ADK paused. Two new outcomes on native: a session
  paused inside an agent node or a map item (which only ADK resumes) fails
  the turn with error code `RESUME_UNSUPPORTED` instead of starting the
  graph again, and an `ask_user` tool on a workflow node's agent in a
  config that skipped validation throws `UnsupportedOnRuntimeError`
  before any model call (the schema refuses it on both runtimes). A
  native workflow turn traces `workflow.invoke`, `node.execute` and
  `tool.execute` spans, so each model call's ledger row names its node's
  agent. ADK turns are unchanged.
- **Ollama structured output enforces the schema (ADR 0096).** An
  `ollama/` agent with an `outputSchema` now sends `response_format:
  json_schema` with the schema in its strict form, as Kimi and the gateway
  do, where it sent `json_object` and the schema was not enforced. JSON
  mode without a schema still sends `json_object`. Ollama 0.5.0 or later is
  required for the schema to hold: an older server ignores it and answers
  in free text. The capability matrix and `npm run doctor` now report
  Ollama's structured output as supported.
- **A Gemini `MALFORMED_FUNCTION_CALL` from a contract adapter is
  retried (WS2-15, ADR 0088).** `modelResponseToLlmResponse`
  (`melchizedek-agents/models/genaiMapping`) now sets `finishReason` to an
  error's code when the code is one of Gemini's finish reasons, as ADK's
  Gemini reports both. Self-correction (`retries.model_errors`) then
  retries a malformed function call on both runtimes, where it used to fail
  the turn on native and behind a shim. A stored Gemini error event can
  carry its own finish reason (`RECITATION`, say) where it carried
  `SAFETY` or `OTHER`.
- **On native, a custom ADK model class from `resolveModel` is refused
  (WS2-15, ADR 0088).** A `compile.resolveModel` that returns an ADK
  `BaseLlm` which is neither a shim nor ADK's Gemini now makes a
  `runtime: 'native'` turn throw `UnsupportedOnRuntimeError` before any
  model call. This covers an agent's model, a subagent's,
  `fallback_model` and `summary_model`. Native used to run the registry's
  model for that id instead. To run such a model on native, return its
  `ModelAdapter`, or `adkShim(adapter)` from
  `melchizedek-agents/models/adkShim`. ADK turns are unchanged.
- **A user-authored `ask_user` call is no question (WS2-15, ADR 0088).**
  `pendingQuestion` ignores an `ask_user` call in an event the user
  authored. A message that forges one no longer turns the next message
  into its answer, on either runtime.
- **The native runtime sends a request, and reads a thrown failure, as
  ADK does (WS2-12, ADR 0084).** On `runtime: 'native'` (or
  `MELCHIZEDEK_RUNTIME=native`) a request goes out under the resolved
  model's own id, as ADK's `LlmAgent` sends it, so a `resolveModel` that
  answers a YAML id with a model under another id (a gateway stand-in, an
  alias) gets that model's thinking and reasoning replay. A model that
  throws no longer throws out of `runSyndicateTurn`: the turn fails on
  ADK's `UNKNOWN_ERROR` event (or a JSON error body's code), and a thrown
  provider-side failure is answered by `fallback_model`, as on ADK. The
  turn-level test suites run on both runtimes. `npm run parity` now runs
  its turns on the runtime `MELCHIZEDEK_RUNTIME` names. The `exports` map
  is unchanged.
- **The skills harness no longer builds on ADK (ADR 0083).** An agent's
  `skills:` block loads, reads and runs skills through the engine's own
  modules (`lib/tools/skills/`), the same on `runtime: 'adk'` and
  `'native'`. A model sees the same tools, parameters, results and error
  texts as before. Breaking for code that imports
  `melchizedek-agents/tools/skillToolset` directly:
  `HarnessSkillToolset` is now an engine Toolset rather than ADK's
  `SkillToolset`, so wrap it with `toAdkToolset`
  (`melchizedek-agents/tools/adkTool`) before handing it to an ADK
  `LlmAgent`. `LeanLoadSkillTool` and `GatedRunSkillScriptTool` are now
  engine Tools (`execute(args, ctx)`), not ADK `BaseTool`s. Frontmatter
  YAML is read by the `yaml` package, so a timestamp stays a string and
  `<<` merge keys are not merged. A SKILL.md over 1 MiB and a resource
  file over 8 MiB are not loaded. `lib/tools/tool.ts` adds `Toolset`,
  `ToolsetContext`, `isOwnToolset`, `toolsetOf` and an optional
  `Tool.contents` hook. The `exports` map is unchanged.
- **OAuth consent for tool credentials (ADR 0085).** On the native
  runtime, `runSyndicateTurn` takes `toolCredentials: { store, consent }`
  (both optional additions). `store` is the sealed credential store of ADR
  0072, and `consent` is `oauthConsent({ providers, redirectUri,
  credentials })` from `melchizedek-agents/tools/oauthConsent`.
  - When a call's provider is not granted, `ctx.accessToken(provider)`
    asks for consent by itself, or a tool calls the new
    `ctx.requestCredential(provider)`. The turn ends `input-required` with
    `result.consent` (`id`, `agent`, `provider`, `authUri`, `state`,
    `scopes`), stored as ADK's own `adk_request_credential` call with no
    secret in it.
  - The person's next message, after the grant is stored, runs the paused
    call again. Until then, a message repeats the request and runs nothing.
  - `createA2AApp` takes the same `toolCredentials` (plus `callbackLimit`
    and `requireCallerIdentity`, default true: the callback refuses a
    browser that does not carry the flow's user's identity). It publishes a `consent_request` data part
    beside `approval_request` and `input_request`, and mounts the consent
    callback at the path of the redirect URI. The callback completes the
    authorization-code flow with PKCE S256 and stores the grant.
  - New exports, all through existing entries: `./a2a` gains
    `consentCallback`. `./runtime` gains `pendingConsent`,
    `credentialResponsePart`, `describeConsent`, `CREDENTIAL_REQUEST` and
    the types `PendingConsent` and `ToolCredentials`. `./tools/*` gains the
    new module `oauthConsent`.
  - Also additive: `RouteDecision.decidedBy` gains `'consent'`, the audit
    trail gains the `consent.callback` event, and `ToolContext` gains
    `requestCredential`.
  - On the ADK runtime, an open consent request throws
    `UnsupportedOnRuntimeError`.
  - No change to the `exports` map.
- **A question is answered on the native runtime (ADR 0079).** On
  `runtime: 'native'` (or `MELCHIZEDEK_RUNTIME=native`), a plain-text
  message that answers an open `ask_user` call no longer throws
  `UnsupportedOnRuntimeError`: it becomes the call's response and the agent
  that asked resumes, in plan-dispatch the route, as on ADK. Both runtimes
  store the same events, so a question opened on either is answered on the
  other; `result.input` and the A2A `input_request` part are unchanged. No
  change to the `exports` map.
- **`mode: task` runs on the native runtime (ADR 0081).** It no longer
  throws `UnsupportedOnRuntimeError`: the agent's requests declare
  `finish_task` as ADK's do, and its answers are stored as ADK stores them.
  A `workflow:` syndicate, where task-mode nodes live, is still refused on
  native. `code_execution: gemini` runs on native with the same stored
  events as on ADK. No change to the exports map.
- **An approval resumes on the native runtime (ADR 0077).** On
  `runtime: 'native'`, a message carrying `approvalResponsePart(id, …)` runs
  or refuses the pinned call before the agent's next step, as on ADK, and
  stores the same events: an approval opened on either runtime resumes on
  the other. An answer whose pinned call does not bind (changed arguments,
  a request the user authored) throws ADK's `IntentMismatchError` text on
  both runtimes. No change to the `exports` map.
- **`createA2AApp` takes the engine's own stores (ADR 0080).**
  `A2AAppOptions.storage.sessionService` accepts the engine's
  `SessionService` as well as ADK's `BaseSessionService`, and
  `storage.memoryService` the engine's `MemoryService` as well as ADK's
  `BaseMemoryService`; a store or service you pass today works unchanged.
  Without durable storage, sessions live in the engine's
  `InProcessSessionService` instead of ADK's `InMemorySessionService`, with
  the durable stores' meaning (no `app:` or `user:` state shared across
  sessions). `resolveModel` returns what `CompileOptions.resolveModel`
  returns, the same type as before. The `melchizedek-serve` bin no longer
  imports `@google/adk`; ADK's logger follows the level the engine sets.
  No change to the `exports` map, `runSyndicateTurn`, or the A2A surface.
- **`context:` compaction runs on the native runtime (ADR 0078).** A
  syndicate whose orchestrator sets `context:` no longer throws
  `UnsupportedOnRuntimeError` under `runtime: 'native'`
  (or `MELCHIZEDEK_RUNTIME=native`): the native loop compacts as the ADK
  runtime does, stores the same compacted event, and charges and traces the
  summary call the same way, so a compacted session continues on either
  runtime. No change to the exports map; `ContextConfig` and
  `DEFAULT_KEEP_RECENT_EVENTS` stay exported from
  `melchizedek-agents/compile` under the same names.
- **A turn can run on the native runtime (ADR 0073).** `runSyndicateTurn`
  takes an optional `runtime` (`'adk'` or `'native'`). Without it,
  `MELCHIZEDEK_RUNTIME` decides (`adk` or `native`), and without that, `adk`,
  so nothing changes unless you ask. On `native` a single-agent, DELEGATE
  or plan-dispatch syndicate runs on the engine's own loop, with
  self-correction from `retries:` and the same root span, and returns the
  same result shape; what native does not run yet (compaction, workflows,
  task mode, `transformAgent`, answering a question) throws `UnsupportedOnRuntimeError` before any model call. Additions under the existing `exports` map:
  - `melchizedek-agents/runtime` exports `RuntimeName`, `RUNTIMES`,
    `DEFAULT_RUNTIME`, `chooseRuntime`, `runtimeSetting` and
    `UnsupportedOnRuntimeError`.
  - `melchizedek-agents/compile` exports `AgentSpec`, `SpecTool`,
    `compileSpec` and `compileSubagentSpec`, the runtime-neutral half of the
    compiler. `compileGraph` and `compileSubagent` build the same `LlmAgent`
    as before.
  - `melchizedek-agents/wiki/agentRun`: `runWikiAgent` follows the same
    flag, and takes `runtime` and (native only) `adapterFor`.
  - `.env.example` lists `MELCHIZEDEK_RUNTIME` and `GEMINI_ADAPTER`.
- **Third-party tokens for tools, sealed per end user (ADR 0072).** Apply
  migration `0013_tool_credentials.sql` (`npx melchizedek-db apply`, or
  `print` into the SQL editor) before using it. New, all under the existing
  `exports` map:
  - `melchizedek-agents/tools/auth`: the `CredentialStore` interface (`put`,
    `get` with refresh, `revoke`, `eraseUser`), `OAuthProvider` (`refresh`,
    `revoke` hooks), `ToolCredentialError`, `toolAccessToken` and
    `pinnedCredentialStore`.
  - `melchizedek-agents/tools/credentialStore`: `credentialStore({ rows,
    cipher, providers, audit })` and `memoryCredentialRows()`.
  - `melchizedek-agents/tools/credentialCipher`: the `CredentialCipher` plug
    point, `aesGcmCipher` (AES-256-GCM) and `credentialCipherFromEnv`, which
    reads the new `MELCHIZEDEK_CREDENTIAL_KEY` (32 bytes, base64 or hex).
  - `storage/postgres`: `postgresStorage({ credentials: { cipher, providers }
    })` adds `storage.credentials`; `postgresCredentialRows` and
    `postgresCredentialStore` are exported.
  - `tools/tool`: `ToolContext.accessToken(provider)`, a valid token for the
    run's own app and user, present when `createToolContext` is given
    `credentials`. No built-in tool uses it yet.
  - `EraseCounts` gains `credentials`: `melchizedek_erase_scope` and
    `DELETE /memory` remove the user's tokens too. A custom `storage.erase`
    that builds its own counts adds the field.
  - The audit trail gains `credential.put`, `credential.refresh`,
    `credential.revoke` and `credential.erase` (`AuditEventName`), with the
    provider and app and never a token.
- **The ledger reads the native loop's spans (ADR 0076).** The native loop
  (not yet selectable, WS2-10) opens `agent.invoke <name>`, `model.call` and
  `tool.execute <name>` spans in scope `melchizedek.runtime`, and a native
  run writes the same `adk_turns`, `adk_telemetry` and `adk_payloads` rows as
  an ADK run. `melchizedek-agents/observability/lineage` exports
  `ADK_SPAN_SCOPE`, `RUNTIME_SPAN_SCOPE`, `agentOfSpanName`,
  `isToolSpanName` and `isModelCallSpan`. In `observability/tracer`,
  `agentForSpan` also walks up to an `agent.invoke` span, tool time also
  sums `tool.execute` spans, and the console exporter keeps the
  `melchizedek.runtime` scope quiet as it keeps ADK's
  (`OTEL_CONSOLE_ALL_SPANS=true` prints both). In
  `observability/supabaseSpanExporter`, `isPayloadSpan` also takes a
  `model.call` span that carries `llm.payload.*`, and `toPayloadRow` reads
  `adk.invocation_id` before the turn's.
- **New entry `melchizedek-agents/model`: the model layer without ADK
  (ADR 0068).** A new path in the `exports` map, so the version is 0.19.0.
  It exports the model contract's types, `ClaudeAdapter`, `GptAdapter`,
  `GrokAdapter`, `ChatCompletionsAdapter`, `KimiAdapter`, `OllamaAdapter`,
  `GatewayAdapter`, `GeminiAdapter`, `resolveAdapter`,
  `resolveAdapterWithFallback`, `geminiAdapterSetting`, `FallbackAdapter`,
  `isProviderError`, the circuit breaker's helpers (`breakerSettings`,
  `circuitOpen`, `recordFailure`, `recordSuccess`, `resetCircuits`) and the
  prefix table (`PROVIDERS`, `providerForModel`, `providerKeyPresent`), and
  loads no `@google/adk`: install with `--legacy-peer-deps` to leave ADK out.
  - Its `resolveAdapter` gives a Gemini id `GeminiAdapter`. Asking it for
    `adk` (`gemini: 'adk'` or `GEMINI_ADAPTER=adk`) throws and names
    `melchizedek-agents/models/registry`, whose `resolveAdapter` is
    unchanged (`AdkGeminiAdapter` by default until gate G3).
  - New module `melchizedek-agents/models/adapterResolver` (through
    `./models/*`): `adapterResolver`, `routeFor`, `scopedKey`,
    `normalizeProvider`, `geminiAdapterSetting` and the resolver types.
    `models/registry` still exports `geminiAdapterChoice`,
    `GeminiAdapterChoice` and `ResolveAdapterOptions`.
  - New module `melchizedek-agents/tools/xaiSearchParams` holds
    `xaiWebSearchParamsFromEnv`, `xSearchParamsFromEnv`,
    `collectionIdsFromEnv` and `collectionsMaxResultsFromEnv`, which
    `tools/webSearchTool`, `tools/xSearchTool` and
    `tools/collectionsSearchTool` still re-export.
- **Kimi forces a tool where Moonshot allows it** (checked live on
  2026-10-08). `kimi-k3` sends `toolChoice: 'required'` as asked and a
  named tool as `tool_choice: "required"` (Moonshot refuses a named tool
  while K3 thinks, and K3 always thinks); `kimi-k2.6` sends both forced
  modes as asked when `reasoning` is `none`, and weakens them to auto
  otherwise. Other Kimi ids keep weakening both to auto. A weakened choice
  is still marked `llm.tool_choice.weakened` on the span. In the
  chat-completions base, a subclass's `toolChoiceModes` now also receives
  the request's reasoning.
- **Fix: `kimi-k2.7-code` with `reasoning: none`.** It sends no thinking
  field (the model thinks at its default) instead of
  `thinking: { type: 'disabled' }`, which Moonshot refuses for K2.7 Code
  and its highspeed variant. `kimi-k2.6` still sends `disabled`.
- **The genai mapping exports two more readers (ADR 0066).**
  `melchizedek-agents/models/genaiMapping` adds `toolChoiceOf` (an agent's
  function-calling mode as a `ToolChoice`, and `VALIDATED` as strict tools)
  and `samplingOf` (the sampling fields the contract carries). These are
  additions under the existing `exports` map. The native loop
  (`lib/runtime/native/`: one model step, and the agent loop around it,
  ADR 0071) is not in the `exports` map and runs no turn yet.
- **OpenAPI tools make their own calls (ADR 0067).** Each operation is
  the engine's own Tool, and the ADK runtime runs it through
  `toFunctionTool`; ADK's `RestApiTool` and `OpenAPIToolset` are no longer
  used. An API receives the same request as before. What a consumer sees:
  - `tools/openapiTools`: `buildOpenApiTools` returns `FunctionTool`s
    (it returned `BaseTool`s), and gains `buildOpenApiOwnTools` (own Tools,
    for either runtime) and `openApiOperationId`. `boundResult` is
    deprecated in favour of `capResult` (`tools/tool`).
  - The new module `tools/openapi/call` holds the caller: `buildRequest`,
    `callOperation`, `hostProblem`, `OPENAPI_REDIRECTS`, `redactSecrets`
    and `MAX_RESPONSE_BYTES`.
  - `require_approval` on an OpenAPI operation uses the gate every
    registry tool uses, so the approval hint and the pending and rejected
    texts are ADK's FunctionTool texts. `requireApprovalOnBaseTool`
    (`compile`) is deprecated and no longer used.
  - A credential's value is replaced with `[redacted]` in every error an
    OpenAPI tool returns; at most 8 MiB of a response is read; an operation
    whose spec requires a credential is not called when the entry sets no
    `auth`, and returns an error saying so.
  - A spec that is not OpenAPI 3.x (Swagger 2.0, or no `openapi` version)
    fails the compile with a readable error, and `~1` and `~0` in a
    `$ref` are unescaped.
- **`GeminiAdapter` covers Gemini's own features (ADR 0065).** In
  `melchizedek-agents/models/geminiAdapter` (which `resolveAdapter`
  returns only with `GEMINI_ADAPTER=engine` until gate G3):
  - Code execution (`executableCode`, `codeExecutionResult`) and
    server-side `toolCall` / `toolResponse` parts ride whole on the next
    output part as `providerState` of the new kind `CARRIED_PARTS_KIND`
    (`carried_parts`, payload `CarriedParts`), and are replayed before it
    within the current turn.
  - `toolConfig.includeServerSideToolInvocations` is sent when native
    tools sit beside function declarations, on the Gemini API only.
  - Grounding citations carry the answer span each supports, and
    urlContext's retrieved pages are cited.
  - Call ids minted by the genai mapping (`genai-noid-`) stay off the wire,
    as `adk-` ids do. `MINTED_CALL_ID_PREFIX` now lives in
    `models/geminiState` and is still exported by `models/genaiMapping`.
  - The adapter reads only `request.signal`; it no longer falls back to the
    turn's signal (ADR 0053: the caller passes it).
  - New option `placeholderSignatures` (default
    `PLACEHOLDER_SIGNATURES_BY_DEFAULT`, false) sends Gemini's documented
    placeholder `PLACEHOLDER_THOUGHT_SIGNATURE` on an unsigned current-turn
    call.
- **Fix: Gemini on Vertex AI.** The compiler asks every agent's config for
  `includeServerSideToolInvocations`, which `@google/genai` refuses on a
  Vertex AI client before sending anything ("only supported in Gemini
  Developer API mode"), so every Gemini call with `GEMINI_PLATFORM=vertex`
  failed. `TracedGemini` now leaves the flag off on Vertex AI and keeps it
  on the Gemini API.
- **Web sources for Claude, GPT and Grok.** When one of these models
  searches the web, its events now carry `groundingMetadata`, so a turn's
  grounding and the A2A server's web-sources lines list the pages it used,
  as they already did for Gemini. Before, only Gemini's answers showed
  their sources.
- **Server-side tools are markers, and MCP, remote-agent and examples tools
  are the engine's own (ADR 0062).** All additions, under the existing
  `exports` map:
  - `melchizedek-agents/tools/tool` gains `NativeToolMarker`,
    `nativeToolMarker`, `nativeToolMarkerOf`, `isNativeToolMarker` and the
    `NATIVE_TOOL` symbol. The new module `tools/nativeTools` holds the
    markers for `web_search`, `x_search`, `url_context`,
    `collections_search` and `google_search`;
  - `tools/adkTool` gains `toAdkNativeTool` and `toAdkTool`, and
    `registerTool` takes a marker;
  - `tools/mcpToolFactory` gains `loadMcpTools` (own Tools) and
    `mcpToolParameters`;
  - `a2a/remote` gains `remoteAgentOwnTool`;
  - the new module `tools/examples` holds an agent's `examples:` as an
    InstructionTool that writes ADK's ExampleTool block word for word.

  `nativeToolOf`, `wantsWebSearch` and the other sentinel checks now read
  the marker, not the class. A tool that only declares nothing under a
  server-side name is no longer treated as that tool. An MCP tool's nested
  schemas no longer carry `default`, `propertyNames`, `$schema` or a boolean
  `additionalProperties`. `propertyNames` was refused by the Gemini API.
- **The engine parses OpenAPI specs itself (ADR 0063).** A new module,
  `melchizedek-agents/tools/openapi/parse` (through the existing
  `./tools/*` pattern), exports `parseOpenApiSpec` and
  `parseOpenApiDocument`. They read an OpenAPI 3 spec into
  `OpenApiOperation`s, each with its arguments and the `ToolDeclaration`
  the model receives. `openapi:` tools keep their names and declarations:
  the parser follows ADK's rules, and `buildOpenApiTools` builds the
  same ADK tools from it. A spec is now bounded. A file over 4 MiB, more
  than 100 YAML aliases, more than a million values once its `$ref`s are
  resolved, or nesting deeper than 128 levels fails the compile with a
  readable error, as does a spec that is not an object. `toSnake` and
  `namesTool` are still exported from `tools/openapiTools`.
- **JSON mode without a schema is on the model contract (ADR 0061).**
  `ModelRequest` (`melchizedek-agents/models/contract`) gains
  `outputFormat?: 'json'`. An agent with
  `generateContentConfig.responseMimeType: "application/json"` and no
  schema sends its provider's JSON mode again on GPT and Grok
  (`text.format: { type: 'json_object' }`, as before they moved onto the
  contract), and keeps it on Kimi, Ollama, the gateway and Gemini, on the
  ADK runtime and on the contract. Claude, whose Messages API has no JSON
  mode, sends nothing for it, as before. `OlderSpelling.jsonMode`
  (`models/chatCompletionsAdapter`, new in this release) is removed:
  the chat-completions adapters read `outputFormat` instead.
- **The engine's own registry (ADR 0060).** `melchizedek-agents/models/registry`
  adds `resolveAdapter(modelId, { apiKey, keyProvider, endpoint, gemini })`,
  which returns any model id's `ModelAdapter` on the engine's contract from
  the same prefix table, gateway fallback, BYOK scoping and endpoints as
  `resolveModel`, with no ADK `LLMRegistry`; `resolveAdapterWithFallback`,
  which wraps a model and its fallback in a `FallbackAdapter`;
  `geminiAdapterChoice` and the types `ResolveAdapterOptions` and
  `GeminiAdapterChoice`. A Gemini id gets `AdkGeminiAdapter` unless
  `GEMINI_ADAPTER=engine` (or `gemini: 'engine'`) selects `GeminiAdapter`.
  `TracedGemini` moves to the new module `melchizedek-agents/models/tracedGemini`;
  `models/registry` still exports it. `registerAvailableProviders`,
  `resolveModel`, `providerStatuses` and the doctor are unchanged.
- **Base URLs lose their trailing slashes in one pass.** The Kimi
  adapter, the gateway, the endpoints module and the embeddings provider
  trimmed a base URL with a regular expression that backtracked
  quadratically on a long run of slashes (CodeQL js/polynomial-redos).
  They now share `trimTrailingSlashes` (new module
  `melchizedek-agents/models/urls`). Results are unchanged.
- **Fix: a message could stall the server in the memory search.**
  `stripHarnessBlocks` (run on every memory query and extraction
  transcript) matched an unclosed `[System Context:` marker with a pattern
  that rescanned the rest of the text once per marker, so a message of
  many such markers took seconds per search (16 s for 800,000 characters).
  The pattern now stops at any bracket and scans the text once.
- **Memory and its tools are the engine's own (ADR 0059).** Additions
  only; the `exports` map is unchanged.
  - `load_memory` and `preload_memory` are the engine's own tools, in the
    new module `melchizedek-agents/tools/memoryTools` (`loadMemoryTool`,
    `preloadMemoryTool`). A model reads the same declaration, the same
    memory note and the same recalled block as with ADK's tools. Two
    differences: a call without a string `query` returns the readable
    error instead of searching, and a failed call's error reads
    `Error in tool 'load_memory': …`, as every own tool's does.
    `require_approval` can now gate `load_memory`. Neither the preload
    tool nor the memory service's search logs the user's query any more;
    the search logs only its length.
  - `melchizedek-agents/tools/tool`: `ToolContext` gains `userContent` and
    `searchMemory(query)`, which searches the run's own silo only.
    `createToolContext` takes `memory` and `userContent`. A `Tool` may have
    `instruction(ctx)`, text for the system instruction of each request.
    New: `InstructionTool` (a tool that only writes into the instruction),
    `isInstructionTool` and `instructionToolOf`.
  - `melchizedek-agents/tools/adkTool` gains `toAdkInstructionTool`, and
    `registerTool` takes an `InstructionTool`.
  - `SupabaseVectorMemoryService` implements the engine's `MemoryService`
    (`ingest`, `search`) as well as ADK's `BaseMemoryService`, whose
    methods behave as before. `namespacedMemoryService` takes either and
    pins `search` and `ingest` too.
- **Claude runs on the engine's model contract (ADR 0055).** New module
  `melchizedek-agents/models/claudeAdapter`: `ClaudeAdapter`, a
  `ModelAdapter` that reads a `ModelRequest` and yields `ModelResponse`s on
  the Messages API (`anthropicTools`, `ClaudeModelRequest`,
  `THINKING_STATE_KIND`, `STRUCTURED_OUTPUT_TOOL`, `ANTHROPIC_PROVIDER`).
  `ClaudeLlm` keeps its name, options, `supportedModels`,
  `registerClaudeLlm()`, `buildAnthropicTools()` and `THINKING_STATE_KIND`,
  and is now that adapter behind the ADK shim, a subclass of `AdkShim`.
  Request bodies are unchanged. What does change on a Claude call:
  - its events carry `finishReason`, and `groundingMetadata` when Claude
    searched the web (see the web-sources entry above);
  - a failed tool's `tool_result` carries `is_error: true`;
  - a setup error (`MISSING_API_KEY`, `ENDPOINT_MISCONFIGURED`,
    `SDK_NOT_INSTALLED`) carries `customMetadata['error.retryable']: false`;
  - tool schemas come from `contractToolDeclaration`: `nullable` becomes a
    type that admits null, string integer bounds become integers, and
    `$schema` is left out.
  `AdkShim` gains a protected `toModelRequest(llmRequest, options)` hook.
  `melchizedek-agents/models/claudeModels` adds `ClaudeReasoning`,
  `claudeReasoningOf`, `claudeReasoningFromConfig` and
  `adaptiveThinkingFor`. The `exports` map is unchanged.
- **The session services serve both runtimes from the same rows, and
  change behaviour in five places (ADR 0058).** `SupabaseSessionService`,
  `PostgresSessionService` and `ProjectedSessionService` also implement
  the engine's own `SessionService` (`create`, `get`, `list`, `delete`,
  `append`) beside ADK's `BaseSessionService`, and
  `ProjectedSessionService` accepts a store with either interface. The
  import paths are unchanged. Through ADK's methods, to match that
  interface:
  - `listSessions` without a `userId` lists every user's sessions of the
    app on the Supabase service too, as it already did on Postgres and as
    ADK's contract says. Before, it filtered on a user named `undefined`.
    Nothing in the engine calls it; check your own callers.
  - `createSession` for an id that exists returns the conversation on the
    Supabase service, as on Postgres, instead of resetting it to no events.
    A create drops `temp:` keys from the initial state.
  - `lastUpdateTime` and `last_update_time` are the appended event's
    timestamp, as in ADK's own store, instead of the clock at append.
  - On Postgres, appending an event whose id the session already holds
    replaces that event's row instead of adding a second one.
  - A listing with no `order` comes back in creation order, and one with
    an `order` breaks ties by id, on both services. A `numRecentEvents`
    below one is ignored.

  No schema change. The bridge between the two interfaces
  (`lib/runtime/adkSessionBridge.ts`) is internal and not in the exports
  map.
- **GPT and Grok run on the engine's model contract (ADR 0048, ADR 0056).**
  New modules `melchizedek-agents/models/gptAdapter` (`GptAdapter`, the
  Responses API as a `ModelAdapter`, with `responsesInput`,
  `responsesFunctionTools`, `responsesUsage`, `responsesServerTools`,
  `streamErrorDecision` and `isOpenAiReasoningModel`) and
  `melchizedek-agents/models/grokAdapter` (`GrokAdapter`,
  `GROK_REASONING_IDS`, `XAI_BASE_URL`). `GptLlm` and `GrokLlm` keep their
  names, constructors, `supportedModels` and exports, and are now the ADK
  shim around these adapters. The ledger, the turn's token charge and
  `adk_turns.tool_calls` count GPT and Grok calls as before: output tokens
  include reasoning, and server-side searches stay on the event's
  `customMetadata`. `AdkShim` gains a protected `toLlmResponse(response)`
  hook for that. What changes on the wire and in the events:
  - `grok-4.6` takes `reasoning.effort` and replays its encrypted reasoning,
    as `grok-4.5` and `grok-4.7` do.
  - A failure a stream reports (`response.failed`, an `error` event, or an
    SSE frame named `error`) carries a retry verdict when it names a
    retryable status or the code `server_error`, `rate_limit_exceeded` or
    `vector_store_timeout`, so the fallback model answers it.
  - An aborted stream ends in an error final instead of the text so far.
  - A user-turn image given by an https URL reaches GPT and Grok, and a PDF
    goes as `input_file`; `top_p` is sent beside `temperature`; a call
    without an id gets one minted from its position, shared with its result.
  - JSON mode without a schema (`responseMimeType: 'application/json'`
    alone) and the older spelling's `xhigh` and `max` effort words have no
    contract field and are no longer sent to GPT or Grok.
  - Final events carry `finishReason`, as every shimmed adapter's do.
- **The engine's own event, session and memory interfaces (ADR 0052).**
  Internal modules for the native runtime, not in the exports map, so
  nothing a consumer imports changes: `lib/runtime/events.ts` (`TurnEvent`,
  the stored ADK Event JSON typed, with a parse that keeps every field and
  ADK's `isFinal`), `lib/runtime/sessions.ts` (`SessionService` and an
  in-process store) and `lib/runtime/memoryService.ts` (`MemoryService`).
  Stored sessions and the session services are unchanged.
- **The skills say what `reasoning:` does on each Claude generation (ADR 0049).**
  `melchizedek-models`, `melchizedek-author`, their briefs, `DOCUMENTATION.md`
  and `syndicateSchema.yaml` say that later Claude models take `reasoning:` as
  adaptive thinking at an effort, with `none` as the model's off switch, or
  `low` effort on Opus 5 and 5.5, Fable and Mythos. The 1,024 floor holds on
  Claude 4.6 and earlier only, and the non-streaming limit on a
  `budget_tokens` above about 19,000 holds on every Claude model.
- **Tools are the engine's own (ADR 0051).** New module
  `melchizedek-agents/tools/tool`:
  - `Tool`: `name`, `declaration()` (the model contract's
    `ToolDeclaration`) and `execute(args, ctx)`.
  - `ToolContext`: ids, a `state` view whose writes land in
    `stateDelta`, `actions.skipSummarization`, `requestConfirmation` and
    `confirmation`, and the abort `signal`. `createToolContext()` and
    `toToolContext()` build one.
  - `requireApproval(tool)`, the `longRunning` marker with
    `LONG_RUNNING_NOTE` and `isLongRunning`, `capResult` and
    `MAX_RESULT_CHARS` (20,000, the limit OpenAPI and MCP results already
    use), and `toolOf(value)`, which finds the Tool behind a registry entry.

  `defineTool` returns a Tool that is still a `ToolContract`. Its
  `execute` validates the arguments before the handler runs, and the
  handler gets a complete `ToolContext`; `executeContract` validates such
  a Tool once. `defineTool` takes `longRunning` and `maxResultChars`.
  `toolContract` also exports `asTool`, `DefinedTool` and `ToolSpec`.
  `toFunctionTool` takes a Tool or a contract, and `registerTool` takes a
  contract, any Tool or an ADK tool.
- **Every registry tool that declares a function is a Tool**, wrapped for
  the ADK runtime by `toFunctionTool`, except ADK's `load_memory`. The ADK
  runtime runs the same `FunctionTool`s, with the same approval
  interrupts and texts. `generate_image`, `inspect_image` and `ask_user`
  become contracts (`generateImageContract`, `inspectImageContract`):
  - `generate_image` and `inspect_image` now return the readable error for
    arguments their schema refuses, instead of calling Gemini;
  - an `ask_user` call with invalid arguments returns the error to the
    model instead of pausing the turn on it.
- **Tool schemas: defaults are optional, and records keep their values.**
  On every surface (the declaration, the ADK `FunctionTool` and the MCP
  `tools/list` entry), a zod schema is exported for its input side
  (`io: 'input'`), so a field with a default is no longer listed as
  required. A record's value schema (`additionalProperties`) is kept on
  both paths, and its `propertyNames: { type: 'string' }`, which says
  nothing in JSON, is left out: a live Gemini call refuses that keyword
  with a 400 and accepts the value schema. `toGeminiSchema` walks by schema keyword, so a property named
  `additionalProperties` or `default` keeps its schema. `models/schemaNormalize`
  exports `zodInputJsonSchema`, `zodToolParameters` and `mapSchemaNodes`,
  and `contractToolDeclaration` reads an own Tool's `declaration()`.
- **Claude requests follow the model generation (ADR 0049).** `ClaudeLlm`
  reads a per-generation table from the model id. Before, every `claude-*`
  id got a thinking budget and a forced tool, which the current models refuse
  with a 400. Now:
  - Claude 4.6 and earlier keep the thinking budget.
  - Later models get adaptive thinking with `output_config.effort` from
    `reasoning:` (or `reasoningEffort`), and a summarized thinking display.
    `none` becomes each model's own off switch at `low` effort, or `low`
    effort where the model has none.
  - Structured output is `output_config.format` from Opus 4.8, Sonnet 5 and
    Haiku 5.5 on. Forced tool use is a 400 on Fable 5.1, Opus 5.5 and
    Sonnet 5.5.
  - Fable 5.1, Opus 5.5, Sonnet 5.5 and Haiku 5.5 bind thinking to the
    conversation. Their requests set `drop_block` under the
    `thinking-binding-controls-2026-08-01` beta, so a turn resumed from
    storage no longer fails on a history that changed in storage.
  - An image URL that names no type is typed by its extension. Claude on
    Bedrock and Vertex AI drops URL images, since those platforms take base64
    only, and the capability matrix says so.
  - `melchizedek-agents/models/claudeModels` exports `claudeGeneration`,
    `adaptiveThinking`, `requestedEffort`, `claudeUrlImagesOn` and
    `THINKING_BINDING_BETA`.
- **`reasoning:` sets how hard an agent reasons, on any provider (ADR 0047).**
  Write `none`, `low`, `medium` or `high`, or `{ budget_tokens: <int> }`, on
  the orchestrator or a subagent. The compiler sends each provider the field
  it reads:
  - Gemini 3: a thinking level.
  - Claude and Gemini 2.x: a thinking budget of 0, 2,048, 8,192 or 16,384
    tokens.
  - GPT, Grok, Kimi, Ollama and the gateway: an effort word.
  `generateContentConfig.thinkingConfig` and `reasoningEffort` remain
  valid as the older spelling. Setting either beside `reasoning` on the same
  agent is a load error. Agents that set neither are unchanged.
- **GPT and Grok honour an effort.** `GptLlm` sends `reasoning.effort` when
  the agent sets one (`reasoning:`, or `generateContentConfig.reasoningEffort`),
  and `GrokLlm` sends it in place of its pinned `medium`. Before, both ignored
  it. `reasoningParam` takes the request as an optional argument.
- **The model zoo and every template use `reasoning:`.** What each agent
  asks of its provider is unchanged: the templates' `includeThoughts: false`
  was already the default, and the zoo's Claude agent keeps its 2,048-token
  budget as `low`.
- **The shipped skills teach `reasoning:`.** `melchizedek-author` and
  `melchizedek-models` (and their briefs) set reasoning with `reasoning:`, show
  what each level becomes per provider and per Claude model generation, and
  describe `generateContentConfig.thinkingConfig` and `reasoningEffort` as the
  older spelling that still loads. The author skill's `assets/minimal.yaml` sets it.
- `lib/compile.ts` exports `reasoningConfig`, `withReasoning` and
  `REASONING_BUDGETS`. The `AgentYamlConfig` type gains `reasoning`, and
  `GenerateContentConfig` gains `reasoningEffort`.
- **Thinking with tool use works on Claude (ADR 0046).** The adapter writes
  the signed `thinking` / `redacted_thinking` blocks into a `providerState`
  field on the part they preceded and replays them verbatim within the
  turn's tool loop, so a thinking Claude agent can use tools and delegate.
  A step continuing another provider's or Claude model's tool call runs
  without thinking.
  New module `melchizedek-agents/models/providerState` (`ProviderState`,
  `providerStateOf`, `withProviderState`): the convention every adapter
  uses for provider-opaque reasoning state. The final event no longer
  carries `customMetadata['anthropic.thinking']`; the same blocks are on
  the part.
- **Claude agents see images.** `ClaudeLlm` sends a user-turn `inlineData`
  part as a base64 image block (`image/png` when it names no type) and an
  `https` `fileData` part as a URL image block, in the parts' order. Before,
  it dropped both. JPEG, PNG, GIF and WebP are sent; any other type, or a
  non-https URL, is dropped with `llm.image.dropped` on the span and a
  one-time warning naming the type. Images inside tool results are not sent,
  as on GPT. The capability matrix marks Anthropic image input supported.
- **The engine's own model contract (ADR 0048).** New module
  `melchizedek-agents/models/contract`, types only: `Message`, `Part`,
  `ToolDeclaration`, `NativeTool`, `ModelRequest`, `ModelResponse`,
  `ModelAdapter`, `ProviderCapabilities` and their parts. The native
  runtime and every model adapter will speak it, and no adapter uses it
  yet. `ReasoningLevel` and `ReasoningSetting` are defined there now.
  `melchizedek-agents/loadSyndicate` re-exports them unchanged.
- **Tool declarations in the contract's shape.** `models/schemaNormalize`
  exports `contractToolDeclaration(tool, { strict? })`, which builds a
  contract `ToolDeclaration` from an ADK tool or straight from a
  `defineTool` contract's zod schema; `nativeToolOf(tool)`, which names the
  `NativeTool` a server-side tool or Gemini's code executor stands for; and
  `toContractJsonSchema(schema, { strict? })`. Gemini's dialect (uppercase
  types, int64 bounds as strings, `nullable`) is converted once, at any
  depth, and the strict form reaches every nested object. Nothing calls
  them yet; `toolDeclarationFor`, `toLowercaseJsonSchema` and
  `toStrictJsonSchema` are unchanged.
- **genai `Content` maps to and from the model contract (ADR 0048).** New
  module `melchizedek-agents/models/genaiMapping`: `contentsToMessages` and
  `messagesToContents`, `contentToMessage` and `messageToContent`,
  `partToGenai`, `llmRequestToModelRequest`, `modelResponseToLlmResponse`,
  `reasoningOf`, `systemText`, `usageToMetadata`, `usageFromMetadata` and
  `isMintedCallId`, the constants `GEMINI_PROVIDER`,
  `THOUGHT_SIGNATURE_KIND`, `GENAI_PART_KIND` and `MINTED_CALL_ID_PREFIX`,
  and the types `ContractHistory`, `GenaiHistory` and
  `ModelRequestOptions`. A stored event's
  content round-trips to the same JSON: a Gemini `thoughtSignature` becomes
  `providerState` of kind `thought_signature`, a call without an id gets a
  `genai-noid-` id that is left off again on the way back, and a part the
  contract cannot hold (Gemini code execution, ADK's confirmation request)
  rides whole as `providerState` of kind `genai_part`. A failed final keeps
  its retry verdict as `customMetadata['error.retryable']` and
  `['error.status']`, which is what `FallbackLlm` reads. Nothing calls it yet;
  no adapter or stored shape changes.
- **Thinking with tool use works on GPT and Grok (ADR 0050).** On
  reasoning ids (o-series, `gpt-5*`, `grok-4.5`, `grok-4.7`), the Responses
  adapters write each run of encrypted reasoning items on the part after it
  and replay them before that part within the turn's tool loop, for the same
  provider and model only. These requests now send `store: false` and
  `include: ['reasoning.encrypted_content']`, so OpenAI and xAI no longer
  keep the response server-side, as they did by default. The guarded 400
  retry also drops the `include` and the replayed items.
  `buildResponsesInput` takes an optional `replay` argument;
  `models/gptLlm` exports `REASONING_STATE_KIND`, and `models/providerState`
  exports `currentTurnStart`.
- **Kimi keeps its reasoning across tool steps (ADR 0046).** On `kimi-k3`,
  `kimi-k2.6` and `kimi-k2.7-code`, the adapter stores each response's
  `reasoning_content` on the part that follows it and sends it back on that
  assistant message within the turn's tool loop, for the same model only,
  as Moonshot asks. A tool loop's later steps bill the replayed reasoning
  as input. `OpenAiCompatibleLlm` gains the opt-in hook
  `replaysReasoningContent()` (off by default; Ollama and the gateway keep
  it off) and exports `REASONING_CONTENT_KIND`; `models/kimiLlm` exports
  `wantsReasoningReplay`. `currentTurnStart` returns -1 when no user
  content opens the turn, so every content is then the current turn's.
- **The fallback model on the engine's own contract (ADR 0044, ADR 0048).**
  New module `melchizedek-agents/models/fallbackAdapter`: `FallbackAdapter`,
  a `ModelAdapter` around a primary and a fallback adapter, with
  `FallbackAdapterOptions` and `isProviderError`. It applies ADR 0044's
  rules to a failed final's `error.retryable` and `status`, and hands the
  fallback the request with its own model id and the caller's `reasoning`
  unchanged. Nothing uses it yet. The breaker's state moves to the new
  module `melchizedek-agents/models/circuitBreaker` (`circuitOpen`,
  `recordFailure`, `recordSuccess`, `resetCircuits`, `breakerSettings`, and
  `setBreakerClock` for tests), shared by both wrappers, so a provider
  tripped on one path is skipped on the other. `models/fallback` still
  exports `circuitOpen` and `resetCircuits`, and `FallbackLlm` behaves as
  before.
- **Any adapter on the model contract runs under ADK (ADR 0053).** New module
  `melchizedek-agents/models/adkShim`: `AdkShim`, an ADK `BaseLlm` that
  wraps one `ModelAdapter` and maps ADK's request and responses through
  `models/genaiMapping`; `adkShim(adapter, model?)`; `adkShimClass(supportedModels,
  createAdapter)`, a class ADK's `LLMRegistry` can register; and the types
  `AdkShimOptions` and `ModelAdapterFactory`. The shim charges each call
  against the turn's `max_steps`, refuses a call on a spent or stopped turn
  with the same response the ADK-path adapters give, hands the adapter the
  turn's abort signal, and opens the `llm.request` span, so an adapter on
  the contract does none of these itself. `connect()` is refused. Nothing
  registers it yet; no adapter or stored shape changes.
- **An elided tool result's size is stored the same on every server.**
  `trimEventForStorage` writes it with en-US digit grouping (`2,563 chars
  dropped before storage — …`), where it followed the server's locale
  (`2.563` in German). An en-US server stores the same bytes as before, and
  rows already stored are untouched.
- The capability matrix's Ollama and gateway `thinking_with_tools` note names
  `reasoning:` as the lever (ADR 0047), compiled to `reasoningEffort`.
- **The shipped skills cover Kimi.** `melchizedek-models` adds `kimi-*` to
  Moonshot AI in its routing table, `MOONSHOT_API_KEY` to its key list and
  `kimi-k3` to its verified ids; `melchizedek` adds the key and `kimi-*` to
  its `Model not found` line. Their briefs match.
- **`wiki_relate` appends.** A new assertion goes at the end of
  `.graph/relations.json` and every stored record keeps its place and bytes,
  where each write used to re-sort the whole file. A store that does not
  parse is refused rather than overwritten. `melchizedek-agents/wiki/entities`
  exports `appendRelation(wikiRoot, record)`, which returns `false` for a
  duplicate, and `saveRelations` writes records in the order given instead of
  sorting them.
- **Fix: `fallback_model:` answers for Claude, GPT, Grok, Kimi, Ollama and
  gateway primaries (ADR 0044).** In 0.18.0 `FallbackLlm` saw a failure only when
  the primary threw, which only Gemini does. The other adapters yield an
  error response, so their fallback never answered, and the failed call was
  recorded as a success, which reset the provider's circuit breaker. Their
  error responses now carry `customMetadata['error.retryable']` (and
  `'error.status'` when the failure had an HTTP status), set from
  `lib/models/retry.ts`'s classification, and `FallbackLlm` reads them: a
  retryable error before any output is counted on the breaker and answered
  by the fallback, a non-retryable one is passed on, and only a call that
  produced content counts as a success. Error codes and messages are
  unchanged, except that key-shaped text is now removed from the message.
  A failure GPT or Grok report inside an open stream carries a verdict too,
  from the event (see GPT and Grok on the model contract). The retry policy now counts
  HTTP 529, Anthropic's "overloaded", as retryable, so an overloaded Claude
  primary is answered by its fallback. New
  module `melchizedek-agents/models/errorResponse`: `providerErrorResponse`,
  `withRetryVerdict`, `isRetryableErrorResponse`, `errorDecision`,
  `statusDecision`, `errorText`, `ERROR_RETRYABLE_KEY`, `ERROR_STATUS_KEY`.
- **A Gemini adapter on the model contract, not yet wired.** New module
  `melchizedek-agents/models/geminiAdapter`: `GeminiAdapter` implements
  `ModelAdapter` (ADR 0048) on `@google/genai` directly, with no ADK, on the
  Gemini API or Vertex AI (`lib/models/endpoints.ts`). Schemas go as
  lowercase JSON Schema (`parametersJsonSchema`, `responseJsonSchema`).
  `reasoning:` maps through `reasoningConfig`. Thought signatures ride on
  the part as `providerState` and are replayed within the turn. Every
  failure is a final response. A `clientFactory` option takes an injected
  client. Nothing registers the adapter yet: Gemini ids are still served by
  `TracedGemini`, unchanged. `REASONING_BUDGETS` and `reasoningConfig` move
  to the new module `melchizedek-agents/models/reasoning`, so the adapter
  maps `reasoning:` without importing the compiler or ADK;
  `melchizedek-agents/compile` still exports both.
- **A temporary Gemini adapter on the contract, over ADK's Gemini.** New
  module `melchizedek-agents/models/adkGeminiAdapter`: `AdkGeminiAdapter`
  (and `AdkGeminiAdapterOptions`) implements `ModelAdapter` by mapping the
  request to an `LlmRequest` and running it through `TracedGemini` with its
  retries. Every failure is a final response: a failed call is
  `GEMINI_ERROR` with its status and retry verdict. Like every contract
  adapter (ADR 0053) it opens no `llm.request` span and charges nothing;
  behind `AdkShim` the span has `TracedGemini`'s attributes, with the
  failed call's code as `GEMINI_ERROR` where `TracedGemini` records the
  HTTP status. It serves Gemini on the native runtime until `GeminiAdapter`
  passes its live parity run, and is removed after that. Nothing registers
  it yet.
  - `models/genaiMapping` adds the reverse directions:
    `modelRequestToLlmRequest`, `llmResponseToModelResponse` (with the type
    `ModelResponseOptions`) and `nativeToolsWithoutGeminiTool`.
  - `TracedGemini` gains `generateWithRetries(llmRequest, stream?,
    abortSignal?)`, the call that `generateContentAsync` wraps in its span.
    Its spans are unchanged.
  - `traceLlmGeneration`'s `LlmCallMeta` gains `request`: a `ModelRequest`,
    or a function that returns one. `llmRequest` is deprecated and still
    recorded when `request` is absent. Every adapter in the package and
    `AdkShim` now pass `request`, so a failed call's `llm.payload.request`, and the
    `adk_payloads.request` row made from it, hold the request in the model
    contract's shape (`model`, `system`, `messages`, `tools`, …) instead of
    ADK's (`contents`, `config`, `toolsDict`). The span's other attributes
    are unchanged.
  - `GEMINI_PROVIDER` and `THOUGHT_SIGNATURE_KIND` are defined once, in the
    new module `melchizedek-agents/models/geminiState`. `models/genaiMapping`
    and `models/geminiAdapter` still export both, with the same values.

## 0.18.0 — 2026-10-06

### Breaking — read before upgrading

- **A public server states its posture (ADR 0039).** With `PUBLIC_URL` set,
  the server refuses to start until all three are set explicitly; the boot
  message names each one missing:
  - `A2A_AUTH`: `callers` or `jwt` (recommended), `header`, or `secret`
    (one shared secret: any holder can act as any user via `X-User-Id`).
  - `A2A_SERVED_AGENTS`: the agent ids to serve, or `*` for every agent.
  - `A2A_TRUST_PROXY`: proxies in front (`1` behind one load balancer), or
    `false` when clients connect directly.
- **`A2A_TRUST_PROXY` defaults to `false`** (was 1): a server reached
  directly no longer takes the client's `X-Forwarded-For` as its address.
- **A turn stops at 50 model calls** when the YAML sets no `max_steps`
  (`DEFAULT_MAX_STEPS`). A syndicate that needs more sets `max_steps`.
- **One end user runs at most 4 tasks at once** (`A2A_MAX_CONCURRENT_PER_SCOPE`,
  `maxConcurrentPerScope`; 0 = unlimited). `A2A_MAX_CONCURRENT_PER_CALLER`
  adds a per-caller cap, off by default. The refusal names the cap.

- **The `@google/adk` peer range is `~2.2.0`** (was `^2.2.0`): the tested
  minor. A new ADK minor can bring a second `@google/genai` copy, whose
  response shapes the framework pins; the range widens when a release is
  tested against it. ADK 2.2.0 is the latest published, so no install
  changes today.

- **An OpenAPI `auth` may not name one of the framework's own settings**
  (the database URL, a provider key, an `A2A_` secret: anything under the
  framework's prefixes). The YAML chooses the host too, so this was a way
  to send a secret anywhere. `OPENAPI_CREDENTIAL_ENVS` makes the rule an
  exact allowlist. ADR 0041.
- **MCP tool descriptions are cut at 1,000 characters and results at
  20,000**, each marked where it was cut.

### Changes

- **An append-only audit trail** (`melchizedek_audit`, migration
  `0012_audit_log`; ADR 0042). Every failed authentication, task outcome
  and erasure is recorded with the caller, the source address, the agent
  and task ids and a scope hash, and no content. A trigger refuses UPDATE
  and DELETE; `melchizedek_prune_audit(days)` is the retention path.
  `postgresStorage` supplies the sink (`audit`), and `createA2AApp` takes
  an `audit` option for any other. Run `npx melchizedek-db apply`.
- **The server says where memory sends transcripts.** Long-term memory's
  extraction and embedding providers default to Gemini whatever the agents
  run on; a syndicate whose agents use other providers now gets one boot
  warning naming the providers memory reaches and the variables that move
  it (`memoryDestinations`, `memoryCrossesProviders`). DOCUMENTATION gains
  "Where your data goes": every destination, its retention, and the setting
  that changes it.
- **A request can be followed across systems.** Every task record
  (`onTaskEnd`, and the JSON log line) carries `taskId` and `traceId`; the
  trace id is the one the spans and the ledger row carry. A request with a
  W3C `traceparent` header is linked from the turn's root span
  (`caller.trace_id`, and `callerTraceId` on the record); the turn keeps
  its own trace id. `validTraceparent` and `callerSpanContext` are exported
  from `melchizedek-agents/observability/tracer`. ADR 0043.
- **`fallback_model:`, an agent key, and a per-provider circuit breaker.**
  When an agent's model fails provider-side (5xx, 429, a reset, after its
  retries) before producing output, its `fallback_model` answers; after
  `MODEL_BREAKER_THRESHOLD` consecutive failures (default 5) the provider
  is skipped for `MODEL_BREAKER_COOLDOWN_MS` (30 s) by agents that have a
  fallback. A 4xx, a canceled turn and a half-finished stream are never
  redirected. ADR 0044.
- **`mcp_tools:`, an agent key**: the MCP server's tools the agent may use;
  any other tool the server lists is not exposed. On a dispatch route,
  `require_approval` may name a listed MCP tool, so a write waits for a
  person. `closeMcpConnections()` closes every open MCP connection.
- **`melchizedek-db apply` is one transaction under an advisory lock.** The
  whole install (migrations, hardening, telemetry) runs as one psql
  `--single-transaction` script that takes `pg_advisory_xact_lock` first: a
  failure anywhere rolls everything back, and two applies started together
  run one after the other. The output still names each file.
- `TaskLimiter` takes per-scope and per-caller limits and says which one
  refused (`refusal()`); `createA2AApp` takes `maxConcurrentPerScope` and
  `maxConcurrentPerCaller`; `DEFAULT_MAX_CONCURRENT_PER_SCOPE` is exported
  from `melchizedek-agents/a2a` and `DEFAULT_MAX_STEPS` from
  `melchizedek-agents/config`.

## 0.17.1 — 2026-10-06

- **Fix: a rolling deploy no longer refuses requests.** On SIGTERM the
  server closed its listener at once, while the load balancer was still
  sending it traffic. It now fails `/readyz` first and keeps serving for
  `A2A_SHUTDOWN_DELAY_MS` (default 5 s), then closes and drains. The delay
  counts inside `A2A_SHUTDOWN_GRACE_MS`, so a stop takes no longer than
  before. `A2AApp.markUnready()` does the same for an embedding app.
  ADR 0038.
- **`/readyz` fails while durable storage does not answer** (503,
  `reason: 'storage'`), so an instance that lost its database leaves the
  rotation instead of failing turns. The cause is logged once per outage;
  the answer is cached for 2 s and concurrent probes share one read, so the
  unauthenticated route cannot be used to flood the database.
- **Fix: the MCP client no longer follows redirects past the SSRF guard.**
  The SSE transport used the default fetch, which follows redirects; it now
  uses `mcpFetch`, under the rule 0.17.0 gave OpenAPI tools: same-origin hops
  get the server's check, cross-origin hops the full guard and no
  credential header.
- **Fix: a failed MCP connect closes its transport.** The SSE stream's
  reconnect timer kept running after `createMcpTools` gave up, for the life
  of the process.
- **`MELCHIZEDEK_DOTENV=off`** makes every bin ignore `.env` files and run
  on its environment alone.

## 0.17.0 — 2026-10-06

### Read before upgrading

- **Run `npx melchizedek-db apply`.** Migration `0011_erase_expired` ships
  with this version, and the server refuses to start against a database
  behind the shipped migrations.
- **A public Supabase deployment on `DATABASE_URL` must be hardened.** The
  boot-time RLS check now runs on that path; `db/hardening.sql` (which
  `melchizedek-db apply` runs) satisfies it, `ALLOW_UNHARDENED_DB=true`
  opts out.
- **Self-correction is on by default.** Retries count against `max_steps`
  and can raise spend; `retries: { model_errors: 0, tool_errors: 0 }`
  restores the previous behaviour.

### Changes

- **Behaviour change: the hardening check runs on the `DATABASE_URL` path.**
  The boot-time RLS check ran only on the deprecated supabase-js path, so a
  deployment that followed the recommended setup was never checked, and
  "fatal on public deployments without it" did not hold. `postgresStorage`
  now supplies `rlsHardening()` and the server applies the same rules
  (`lib/storage/rlsStatus.ts`): with `PUBLIC_URL` set, a Supabase database
  whose `public` tables lack RLS stops the server (set
  `ALLOW_UNHARDENED_DB=true` to accept the risk). A database with no `anon`
  or `authenticated` role, or with the tables in a private schema, passes.
  `createA2AApp`'s `storage` option accepts `rlsHardening` for custom storage.
- **Fix: OpenAPI tools no longer follow redirects past the SSRF guard.**
  ADK's REST tool calls `fetch`, which follows redirects, and the guard
  checked only the configured server: an allowed API with an open redirect
  could send a call to the cloud metadata service, and an `api_key` header
  went with it. A call now follows redirects one hop at a time
  (`lib/net/redirects.ts`): same-origin hops get the server's own check,
  cross-origin hops the full guard (even with `ALLOW_PRIVATE_OPENAPI`) and
  only content-negotiation headers. A refused hop returns an error to the
  model. Nothing changes for a fetch made outside an OpenAPI tool call.
- **Fix: `DELETE /memory` erases expired conversations.** A namespace erase
  (the default) found conversations through their live session rows, so once
  a session expired after seven idle days its ledger turns, spans, payloads
  and A2A tasks survived the erase while the response reported success.
  Migration `0011_erase_expired` replaces `melchizedek_erase_scope`: a
  namespace erase now keeps a turn or task only when its conversation is
  still live in another namespace. Run `npx melchizedek-db apply`; the server
  refuses to start against a database behind the shipped migrations.
- **Moonshot AI (Kimi) is a provider.** `kimi-*` model ids route to a new
  direct adapter (`lib/models/kimiLlm.ts`, chat completions against
  `api.moonshot.ai`), funded by `MOONSHOT_API_KEY` (`MOONSHOT_BASE_URL` for a
  proxy). Tool calling, delegation, strict structured output, streaming,
  images and `reasoning_content` work; native `web_search` is dropped with a
  warning (Moonshot's model-side search retires 2026-10-20), and thinking is
  not carried across a tool loop (K3 re-reasons each step; both stated in
  the capability matrix). `kimi-k3` takes `reasoning_effort` (pinned `high`,
  `DEFAULT_KIMI_REASONING_EFFORT`); K2.x ids take a thinking switch. With no
  direct key the gateway serves the ids as `moonshotai/…`. The doctor,
  `.env.example`, the schema comments and the docs know the provider;
  `model_zoo.yaml` gains a sixth agent, `kimi` on `kimi-k3` at low effort,
  and the Zookeeper names six providers. Cost note: `kimi-k3` is priced
  like Claude Sonnet 4.6 ($3 / $15, thinking billed as output), so
  `kimi-k2.6` is the budget tier and the gateway the cheap route to K3.
  One plain turn verified live on 2026-10-03; tool loops were not.
- **The doctor's providers line names each provider's own key.** It probed
  every provider past the fourth with a `grok-` id, so Moonshot was reported
  as missing `XAI_API_KEY`.
- **Behaviour change: self-correction is on by default.** Every turn now runs
  ADK's reflect-and-retry plugins. A model reply ADK marks malformed
  (`MALFORMED_FUNCTION_CALL`) is retried up to twice with guidance instead of
  failing the turn; a tool that throws is answered with structured reflection
  guidance and retried at most three times. Every retry counts against
  `max_steps`. Set `retries: { model_errors: 0, tool_errors: 0 }` at the root
  of a syndicate to restore the previous behaviour. ADR 0034.
- **`url_context` and `examples:`.** `url_context` lets a Gemini agent read
  the pages at URLs in the conversation, server-side; on other providers it is
  a no-op the doctor reports as dropped. An agent's `examples: [{ input,
  output }]` adds few-shot exchanges to every request (ADK's `ExampleTool`).
- **Three agent keys from ADK: `code_execution`, `context`, `mode`.**
  `code_execution: gemini` lets a Gemini agent write and run Python in
  Gemini's server-side sandbox (nothing runs on the host). `context:
  { compact_after_tokens, keep_recent_events?, summary_model? }` on a delegate
  orchestrator summarizes earlier turns once a prompt passes the threshold,
  keeping the recent ones verbatim and the full history stored. `mode: task`
  on a workflow node makes its output the arguments of its `finish_task`
  call. The schema places each where it means something. ADR 0033.
- **`openapi:`: any HTTP API as an agent's tools, from its spec.** An agent
  lists OpenAPI 3 spec files (relative to the syndicate file); every operation
  becomes a tool named from its `operationId`, its parameters the arguments,
  its summary the description. Read-only by default (GET operations only,
  unless `operations` names others); a named operation can be listed under
  `require_approval`. Credentials come from environment variables
  (`auth.bearer_env`, `auth.api_key`), never YAML, and are never stored in
  session state. Every server passes the SSRF guard (literal rules at
  compile, DNS before each call; `ALLOW_PRIVATE_OPENAPI=true` for local
  development); results are capped at 20,000 characters. On ADK's
  `OpenAPIToolset`. Worked example: `config/agents/examples/weather.yaml`
  (`npm run syndicate:weather`), with two keyless Open-Meteo specs. ADR 0032.
- **`ask_user`: an agent asks the person and waits.** A registry tool,
  `ask_user(question, options?)`, on the orchestrator or a plan-dispatch
  route. Called, it ends the turn `input-required` with `result.input`
  (`node`, `message`, `payload.options`); the next plain-text message on the
  conversation becomes the call's result and the agent resumes its own tool
  loop (a dispatch turn goes straight back to the route that asked). Over A2A
  the task carries an `input_request` data part — the same one a workflow's
  `ask_user` node publishes. A delegated subagent or a workflow node listing
  it is a load error. ADR 0031.
- **Workflows: the `workflow:` block, the third orchestration method.** A
  syndicate may be a graph: its agents are the nodes, `edges` says what runs
  after what and on which route (a map after a node routes on the `route_key`
  of its JSON output, else its text, with `default`), and `nodes` declares
  what is not an agent — `join` (fan-in), `map` (one run per list item,
  concurrently), `tool` (a registry tool as a node), `ask_user` (a pause: the
  turn ends `input-required` with the question, the next message answers,
  and the node outputs `{ reply, input }`). Any node may carry `retry` and
  `timeout`. Every node receives the previous node's output as its message
  and sees nothing else of the conversation unless its YAML says so. Runs on
  ADK's `Workflow`; `runSyndicateTurn` gains `status: 'input-required'` with
  `input` (the A2A server publishes an `input_request` data part;
  `melchizedek-chat` prints the question and takes the next line);
  `compileWorkflow` and `isWorkflowSyndicate` are exported. Not yet inside a
  workflow: approval gates, skill scripts, remote subagents. Worked example:
  `config/agents/examples/pipeline.yaml` (`npm run syndicate:pipeline`);
  ADR 0030.
- **Agent Skills in a syndicate: the `skills:` agent key and the Harness.**
  An agent may declare `skills: { dir, scripts?, tools? }`. Every skill's
  frontmatter (name, description) is appended to the agent's instruction at
  compile time, so no turn is spent discovering skills; `load_skill` reads one
  SKILL.md in full with the names of the files it ships, and
  `load_skill_resource` reads one file (`references/`, `assets/`, `scripts/`,
  the open standard's layout). A skill's `allowed-tools` frontmatter unlocks
  the registry tools the YAML lists under `skills.tools`, once that skill is
  loaded. With `scripts: local`, `run_skill_script` runs a skill's own scripts
  on the host, each run only after a person approves it through the same
  pause as `require_approval` (A2A `input-required`; `melchizedek-chat` now
  asks `[y/N]`); the model's own code never executes. Built on ADK's
  `SkillToolset` (`lib/tools/skillToolset.ts`). `config/agents/examples/harness.yaml`
  is the specimen: a generic agent that works from whatever shelf of skills
  `--bind skills_dir=…` points it at (default: this package's own suite).
- **The suite's files move to the standard `assets/` directory.**
  `melchizedek-author` ships `assets/minimal.yaml` (was `templates/minimal.yaml`)
  and `melchizedek-scribe` ships `assets/brief.md` (was `templates/brief.md`),
  so a harness, this one or any other, can read them as skill resources. A
  skill installed by an earlier release keeps its old path until it is
  reinstalled with `--force`.

## 0.16.2 — 2026-10-02

- **`OTEL_EXPORT_CONTENT=off` also drops library content attributes.** In
  0.16.1, `off` removed the engine's own conversation attributes but let
  through ADK's: its `call_llm` span carries the full model request and
  response as `gcp.vertex.agent.llm_request` / `_response`. `off` now drops
  any text attribute whose name marks content (request, response, input,
  output, args, prompt, messages, thinking, payload, …) unless the name
  marks metadata (model, name, id, finish reasons); numbers always stay.
  Verified end to end against Jaeger. **If you export OTLP with
  `OTEL_EXPORT_CONTENT=off`, upgrade.** The default `redacted` mode
  already ran the redactor on those attributes.

## 0.16.1 — 2026-10-02

- **OTLP export is filtered before it leaves** (`OTEL_EXPORT_CONTENT`).
  Spans sent to `OTEL_EXPORTER_OTLP_ENDPOINT` carried the conversation
  unredacted, while the ledger scrubs it (`TELEMETRY_REDACT`). The exporter
  now applies the same redactor by default; `OTEL_EXPORT_CONTENT=off` drops
  every conversation attribute (input, output, thinking, tool arguments and
  results, payloads) and hashes `user.id`, keeping timings, models, token
  counts, routes and errors; `raw` restores the old behaviour.

## 0.16.0 — 2026-10-02

### Breaking — read before upgrading

- **The server refuses to start on a database behind its migrations.** With
  durable storage it reads `melchizedek_schema_version` at boot; below the
  highest migration this release ships (0010), it stops and names
  `npx melchizedek-db apply`. `ALLOW_SCHEMA_MISMATCH=true` starts anyway. A
  newer database only warns. supabase-js storage now logs its deprecation
  (ADR 0021); set `DATABASE_URL` to move to `postgresStorage`.
- **The default Gemini model is `gemini-3.5-flash-lite`** (was
  `gemini-3.1-flash-lite`): `DEFAULT_GEMINI_MODEL` in `lib/config.ts`, and every
  starter-pack, template and schema example that named the old id. An agent
  that omits `model:` now runs on 3.5 Flash Lite; pin the old id in the YAML
  to keep it.
- **`@google/adk` peer is now `^2.2.0`** (was `^1.3.0`), and `@google/genai`
  is `2.25.0`. Install `@google/adk@2.2.0` beside the package. ADK and genai
  now share one genai copy, and ADK's database drivers and GCP exporters are
  optional peers, so the install is about 40% smaller.
- **The A2A server's key mode defaults to `server`.** The server's own
  provider keys pay; `X-API-Key` is no longer required; sessions and memory
  are stored under `X-User-Id` (else `default`). The old behaviour — the
  caller's `X-API-Key` pays and its hash scopes the data — is
  `A2A_KEY_MODE=byok` (`keyMode: 'byok'`). **A deployment holding data
  written by an earlier version must set `byok`, or that data is no longer
  found.**
- **A bare agent id is a file.** `/<agentId>/…` loads `<agentId>.yaml` from
  your agents directory. The registry answers only `registry:<id>`, or bare
  ids listed in `A2A_REGISTRY_AGENTS`; a registry miss is a 404 and a
  registry failure a 503, never a silent fallback to the file. The shipped
  `examples/` and `templates/` answer only ids listed in `A2A_SERVED_AGENTS`.
- **Syndicate YAML is validated at load.** Unknown keys, an invalid
  `memory_system`, a
  `dispatch.default_route` naming no subagent, and similar mistakes now
  throw one error listing every problem with its key path and a did-you-mean
  suggestion. They used to load and fail later, or silently. `subagents:`
  may be omitted for a single-agent syndicate; it reads as `[]`.
- **`runSyndicateTurn` registers the framework's model adapters** when the
  caller passes no `compile.resolveModel`, so `max_steps` and cancellation
  hold for a string model id too (ADK's own Gemini class bypassed both).
- **The agent card is A2A 1.0** (`supportedInterfaces`), served to 0.3
  clients in the 0.3 shape; requests in either version work
  (`@a2a-js/sdk` 1.3 with 0.3 compatibility). File parts are rejected
  (`rejected` state) instead of arriving as empty text.
- **Without `A2A_SERVER_SECRET` the server binds 127.0.0.1.** Binding another
  `HOST` needs the secret or `ALLOW_UNAUTHENTICATED=true`; the `.env.example`
  placeholder is refused as a secret.
- **The server no longer prints conversation content** (`[OTEL_SPAN_JSON]`
  lines) unless `OTEL_CONSOLE_SPANS=true`.
- **Node `>=22.6`** (type stripping); production runs the compiled bins.
- **`POST /v1/x-packet` and `lib/tools/xPacket.ts` left the engine.** They
  were one deployment's route. Mount your own routes with `routes`, or with
  `startServer(name, { routes })` from the new `melchizedek-agents/server`.

### The engine as a library

- **`runSyndicateTurn(options)`** — the one turn runner. The server, the
  CLI, the worker and the eval harness all call it, so plan-dispatch,
  delegation, nested syndicates, guards and the step cap behave the same
  everywhere (the CLI used to run dispatch syndicates in delegate mode).
  Plain data in and out; also `ingestTurnMemory`, `compileGraph`,
  `compileSubagent`.
- **`createA2AApp(options)`** — the A2A server as a mountable Express app,
  with plug points: `resolveRequest` (your identity system returns the
  scope key), `keyMode`, `credentials` (a provider key per request from your
  secret manager), `storage` (sessions, memory, task store, erase),
  `memory` (extractor, embedder), `routes`, limits. `melchizedek-serve` is a
  thin bin over it.
- **`registerTool(name, tool)` and `registerGuard(guard)`** — extend what a
  YAML can name, from your own code.
- **Root exports** now include the capability and gateway helpers the 0.12.0
  entry listed (`describeCapabilities`, `capabilitySummary`, `planTransport`,
  `gatewayConfig`, `gatewayProblem`, `gatewayUsable`, `GATEWAYS`,
  `GatewayLlm`), `validateSyndicateConfig`, `syndicateJsonSchema`, the
  memory providers, `eraseScope` and `namespacedMemoryService`. New subpaths:
  `./compile`, `./runtime`, `./runtime/turnControl`, `./a2a`, `./a2a/remote`,
  `./guards`.

### Fixed — behaviour the docs promised

- **The Postgres turn lock works with the server's keys.** It hashed the
  key with Postgres' `hashtextextended`, and the server's keys are joined
  with NUL separators, which Postgres text rejects: with `DATABASE_URL` set,
  every A2A turn failed taking its lock. Keys are now hashed in Node to a
  64-bit advisory-lock id.
- **Moving to `DATABASE_URL` keeps conversation history.** The Supabase
  session service stores events as a JSON array on `adk_sessions`; the
  Postgres adapter stores rows, and read none of the array, so following the
  deprecation notice cut every conversation off from its history (and shifted
  memory ingestion's event counts). The first read or append of such a
  conversation now copies its array into rows, once, in order; the array
  stays, so moving back still works.
- **Erase reaches every store** (migration `0010_erase_complete.sql`).
  `DELETE /memory` and `erase()` left the memory ingestion markers (scope key
  and conversation ids) and the task tools' list and jobs behind; they are now
  deleted too and reported as `memory_markers` and `task_tools`. A namespace
  erase keeps the task list, which belongs to the caller.
  **`npx melchizedek-db apply`** before upgrading.
- **Non-Gemini orchestrators delegate.** Claude, GPT, Grok, Ollama and
  gateway adapters sent every subagent (and `load_memory`) an empty
  parameter schema; they now send the tool's real declaration.
- **`max_steps` is enforced**, across the whole turn — orchestrator,
  subagents and nested syndicates share one budget — and exceeding it fails
  the turn with `STEP_LIMIT`. It was passed to a parameter ADK does not have.
- **`includeContents`, `outputKey`, `globalInstruction`,
  `disallowTransferToParent`, `disallowTransferToPeers`** reach ADK; they
  were parsed and dropped.
- **`tasks/cancel` cancels**, including the model call in flight; every task
  has a deadline (`A2A_TASK_TIMEOUT_MS`, default 15 minutes).
- **Per-agent cards advertise their own URLs**, declare their security
  schemes, and are readable without a model key; without `PUBLIC_URL` the
  card uses the host the request reached.
- **`memory_system: internal-only` keeps transcripts in process memory on the
  server**, as documented.
- **Memory ingestion is at-least-once**: a failed extraction, embedding or
  insert leaves the turns pending for the next task instead of dropping them.
- **`.env.example` ships no placeholder values**, and the loader ignores
  `your_..._here` values: copying the template no longer crashes the
  quickstart, funds no provider in the doctor, and cannot become a live
  secret. Installed bins read `.env` from the directory you run them in.
- **SSRF guard** (`web_extract`, MCP clients, remote A2A agents): one
  implementation that parses every IP encoding the URL parser emits
  (IPv4-mapped, NAT64, 6to4, trailing-dot names) and resolves names, refusing
  any that resolve to a non-public address.
- **Transient provider failures are retried** on Gemini and the
  chat-completions path (Ollama, gateways): 408/409/425/429/5xx and connection
  resets, jittered backoff, `Retry-After` honoured, never after output has
  started (`MODEL_RETRY_MAX_ATTEMPTS`). Grok's per-attempt timeout is 10
  minutes (`XAI_TIMEOUT_MS`).
- **`db/hardening.sql` revokes function execution from `PUBLIC`**, so the
  anon key cannot call `SECURITY DEFINER` functions. **Re-run it.**
- **A thinking model that runs out of room says so instead of answering
  empty.** On the chat-completions path (Ollama, gateways) a turn that ends
  with reasoning but no reply now yields `<PROVIDER>_MAX_TOKENS` when
  `finish_reason` is `length` (the reply never started), or
  `<PROVIDER>_EMPTY_RESPONSE` when the model stopped after thinking. Before,
  ADK dropped the empty final, logged "The last event is partial", and the
  turn returned empty text while still billing the thinking tokens. On Ollama
  the cause is usually its 4,096-token context window, which `/v1` cannot
  raise (`num_ctx` is ignored); the error names the remedies. A `<think>`
  block that never closed is scratchpad, never reply text, and a reply cut
  short keeps its text with `finishReason: MAX_TOKENS`.
  The `model_zoo` example's `qwen_local` agent sets
  `generateContentConfig.reasoningEffort: "none"`, so `npm run demo:models`
  gets an answer from the local model (ADR 0027).

### New

- **A local model that thinks without answering is retried once with
  thinking off** (ADR 0027). An Ollama turn that ends in `OLLAMA_MAX_TOKENS`
  (the context window filled while thinking) or `OLLAMA_EMPTY_RESPONSE` is
  sent again with `reasoning_effort: "none"`; the named error reaches the
  caller only if that fails too. Both attempts' tokens are counted. Skipped
  for an agent already running with `reasoningEffort: "none"`; off with
  `OLLAMA_RETRY_WITHOUT_THINKING=false`.
- The comment on `adk_session_events.ts` now says milliseconds (ADK's
  `Date.now()`), which is what it has always held.
- **Pool sizes for the server** (ADR 0021). `DATABASE_POOL_MAX` (default 10)
  and `A2A_TURN_LOCK_POOL_MAX` (default 20) bound the connections one
  instance opens, so it fits a session-mode pooler's client limit.
- **Approval gates** (ADR 0028). `require_approval: [tool]` on an agent makes
  that tool run only after a person approves the exact call: the A2A task
  ends `input-required` with the pending call (text and an
  `approval_request` data part), and `approve` / `reject` (or
  `{ approval: { id, approved } }`) on the conversation resumes it. Allowed on
  the orchestrator and plan-dispatch routes. `runSyndicateTurn` returns
  `status: 'input-required'` with `approval`; `approvalResponsePart` answers
  it. Stored function-call parts now keep Gemini's
  `skip_thought_signature_validator` signature instead of none.
- **Cloud platforms and proxies** (ADR 0023). `GEMINI_PLATFORM=vertex`,
  `ANTHROPIC_PLATFORM=bedrock|vertex` and `OPENAI_PLATFORM=azure` reach the
  provider through Vertex AI, Bedrock or Azure OpenAI with the cloud's own
  credentials (Google ADC, the AWS chain, an Azure key or Entra ID);
  `ANTHROPIC_BASE_URL` / `OPENAI_BASE_URL` put a proxy in front of the vendor
  API; `<PROVIDER>_MODEL_MAP` maps ids to platform ids or deployments. The A2A
  `credentials` plug point may return a partial endpoint as well as a key.
  `@anthropic-ai/bedrock-sdk`, `@anthropic-ai/vertex-sdk` and `@azure/identity`
  are optional peers. The doctor lists each configured endpoint. Native web
  search is not sent on Bedrock, Claude-on-Vertex or Azure. Tested against
  mocks only; not live-verified.
- **A private schema** (ADR 0021). `MELCHIZEDEK_DB_SCHEMA=melchizedek` (or
  `melchizedek-db apply --schema melchizedek`) installs every table and
  function into that schema instead of `public`, so a Supabase REST layer
  never sees them; `postgresStorage({ schema })` (the bin reads the same
  variable) points its connections there. The default stays `public`, so an
  existing database needs nothing. A private schema requires `DATABASE_URL`
  (supabase-js reaches only exposed schemas).
- **Rate limits across replicas** (ADR 0021). `A2A_REDIS_URL` (with the
  optional `redis` package) counts the request limit and the failed-login
  limit in Redis, one window for every replica; in code, `limitStore` with
  `redisRateLimitStore({ command })` from `melchizedek-agents/a2a/limits`.
- **The task tools on Postgres** (migration `0009_task_queue.sql`). With
  `DATABASE_URL`, the to-do list and job queue live in Postgres: each caller
  has their own list (tool calls now carry their caller, `ToolCallContext`,
  and the task tools file records under the scope key), and any number of
  `melchizedek-worker`s claim jobs with `FOR UPDATE SKIP LOCKED` under a
  renewed lease. The JSON file stays the default. `setTaskBackend()` plugs
  in any other store.
- **Per-syndicate memory settings** (ADR 0020). `memory_extraction_model`
  picks the model that distils a syndicate's turns (default
  `MEMORY_EXTRACTION_MODEL`); `memory_retention_days` deletes facts in the
  syndicate's own `memory_namespace` older than the window, when the server
  loads it and daily after (migration `0008_memory_retention.sql`).
- **Memory ingestion commits as one unit** (migration
  `0007_memory_commit.sql`, ADR 0020). New facts, the rows they supersede
  and the session's processed marker are written in one transaction
  (`melchizedek_memory_commit`); the marker is stored, so a restart never
  re-extracts a turn. The server refuses to start when the embedder's
  dimension differs from the stored column. **`npx melchizedek-db apply`.**
- **A task whose server died is failed, not stuck** (migration
  `0006_task_leases.sql`, Postgres storage). A running task is leased to the
  instance running it and renewed on a heartbeat; when the lease expires
  another instance marks it `failed` with a message saying the server
  stopped. Apply the migration (`npx melchizedek-db apply`); the boot check
  requires it.
- **One turn at a time per conversation.** A second message on a
  conversation whose turn is still running waits for it (up to
  `A2A_TURN_LOCK_WAIT_MS`, default 30 s) and runs after it, seeing its
  exchange; past the wait it is `rejected` ("still running"). In-process by
  default; with `DATABASE_URL`, a Postgres advisory lock shared by every
  instance (`postgresStorage().turnLock`, its own pool, `lockPoolMax`).
- **Token streaming on `message/stream`** (`A2A_STREAM_TEXT=true`,
  `streamText` in `createA2AApp`). The answer arrives as chunks of an
  `answer` artifact as the model writes it; narration before a tool call is
  withdrawn, and the artifact is closed with the text the user receives
  (relay fallback and dispatch included). A syndicate with guards never
  streams. Off by default; the final status message is unchanged. The
  runtime exposes the same as `TurnEvents.onTextDelta` / `onTextReset`.
- **A versioned agent registry** (migration `0005_agent_registry.sql`, ADR
  0018). Every definition an id has held is kept in an append-only
  `adk_agent_registry_versions`, with its author, note and config hash, and
  the database records a version on every write to the active row, whoever
  writes it. `npx melchizedek-registry publish|versions|show|diff|rollback|retire`
  (library: `melchizedek-agents/registry`) validates before it writes;
  rollback re-activates a stored version. `registry:<id>@<version>` loads one
  version. Existing rows become version 1 when the migration runs:
  **`npx melchizedek-db apply`** to install it. A syndicate is versioned as a
  unit: `publish` (and `publishAgent`) stores every nested `yaml_reference` it
  reaches under `bundled_references`, and the server loads that version's
  nested syndicates from the bundle, not from files (`--no-bundle` /
  `bundle: false` opts out). Republish a nesting syndicate after changing a
  nested file.
- **The source moved to [github.com/jhwadman/melch-ai](https://github.com/jhwadman/melch-ai).**
  The package name stays `melchizedek-agents`; `repository`, `homepage` and
  `bugs` point at the new repository, which now holds the engine, its tests
  and its wiki directly. `npx skills add jhwadman/melch-ai` installs the skills.
- **Built-in authenticators** (`melchizedek-agents/a2a/identity`, ADR
  0025), chosen in the bin with `A2A_AUTH`:
  - `callers`: one bearer token per calling backend. `A2A_CALLERS` holds
    `name:sha256[:scope]`, so the config stores only token hashes. A caller
    owns a scope that does not depend on any model key, so rotating a
    provider key no longer strands sessions and memory. Mint a caller with
    `melchizedek-serve --new-caller <name> [--scope s] [--token-file f]`. A
    still-set `A2A_SERVER_SECRET` keeps working beside the tokens with its
    old scoping, so callers move over one at a time; give a caller its
    existing `a2a-<hash>` silo as its scope and no data moves.
  - `jwt`: your identity provider's tokens, verified with `jose` (JWKS or
    HS256; issuer, audience and expiry required); the scope is the user
    claim, optionally under a tenant claim.
  - `header`: a trusted user header from an authenticating gateway, accepted
    only together with the server secret.
  - In code: `createA2AApp({ ...callerTokens(parseCallers(spec)) })`, or
    `jwtIdentity`, `trustedHeader`, `sharedSecret`, `firstOf`.
  - `RequestIdentity.operator` marks an operator-issued credential (a caller
    token, the server secret); an adopter route reads it through
    `currentRequestContext()` to refuse end users (a JWT, a gateway identity).
- **Governance** (ADR 0026):
  - `runSyndicateTurn` returns `usage`: model calls plus input, output and
    thinking tokens, summed over every agent in the turn.
  - Budgets: `policy: budgets(config)` (env `A2A_BUDGETS`) sets daily limits per
    caller and per scope on tasks, calls and tokens; a task over budget ends
    `rejected` with the reason. Counters: `memoryUsageStore`,
    `postgresUsageStore`, `supabaseUsageStore` (table from
    `db/migrations/0004_usage.sql`).
  - `onTaskEnd` gives one `TaskRecord` per task; `A2A_LOG_FORMAT=json` makes
    every server line JSON.
  - `GET /metrics` serves Prometheus text behind `A2A_METRICS_TOKEN`
    (`createMetrics`).
  - With an authenticator, the rate limit counts per caller or per scope
    instead of per IP.
  - The telemetry ledger is redacted before it is written: key-shaped
    credentials by default (`TELEMETRY_REDACT`), emails, phones, cards and SSNs
    on request, or your own `setTelemetryRedactor`.
- **`keyMode: 'byok'` now holds under any authenticator**: the caller's
  `X-API-Key` pays whoever the caller is. A `resolveRequest` used to switch
  BYOK billing off. The key-hash scope applies only without an authenticator.
- **Remote agents: `a2a_agent_url:` on a subagent** — an agent served over
  A2A (1.0 or 0.3) becomes a delegation tool or a plan-dispatch route.
  Credentials from `A2A_AGENT_TOKENS`; `ALLOW_PRIVATE_A2A` for local hosts.
- **`melchizedek-init`**: start a project from any template or example in one
  command — writes `config/agents/<name>.yaml` (and what it nests) with a
  schema modeline, gives a long-term syndicate its own `memory_namespace`,
  creates `.env` from the template, and prints the next commands.
  `--list` shows what ships.
- **Database tooling: `melchizedek-db print | apply | status |
  prune-sessions`** over numbered, idempotent migrations in
  `db/migrations/` (base schema, nightly session expiry, scope erasure), then
  `hardening.sql`.
- **`DELETE /memory` erases everything stored for the calling scope** —
  facts, sessions with their subagent rows, ledger rows — with per-store
  counts; `?all=1` covers every memory namespace.
- **`memory_namespace`** (YAML): where a syndicate's long-term memory lives;
  memory tools on subagents read the root syndicate's facts.
- **Memory providers**: extraction on any model id
  (`MEMORY_EXTRACTION_MODEL`), embeddings from Gemini, OpenAI, Ollama or any
  OpenAI-compatible endpoint (`MEMORY_EMBEDDING_*`).
- **Capability matrix** (`lib/models/capabilities.ts`): provider × delegation,
  memory tools, structured output, thinking with tools, streaming, vision,
  native search — each cell backed by a request-shape test;
  `melchizedek-doctor --matrix` prints it and flags gaps per agent.
- **Server operations**: `/healthz`, `/readyz`, SIGTERM drain
  (`A2A_SHUTDOWN_GRACE_MS`), a concurrency cap, configurable rate limits,
  trust-proxy and body limit, a failed-login limiter, a boot summary.
- **Published JSON Schema** for syndicate YAML:
  `config/agents/syndicate.schema.json` (editor modeline in
  `syndicateSchema.yaml`).
- **Deploy artefacts**: `Dockerfile`, `compose.yaml` (optional Ollama and
  Phoenix), CI, `SECURITY.md`.
- The package now ships `db/`, `demo/`, `.env.example` and this changelog,
  and `package.json` names the repository.

## 0.15.0 — 2026-09-27

- **Production templates: `config/agents/templates/`.** Ten job-shaped
  syndicates built to be adapted and shipped, beside the starter pack that
  teaches: `conversational` (a keyless conversational agent),
  `support_triage` (plan-dispatch with a `handoff` fallback),
  `research_brief` (three layers, nesting `research_desk`), `review_panel`
  (ship, fix or hold a change), `draft_review` (a policy-checked loop), one
  per memory tier (`intake_extractor`, `case_desk`, `account_memory`), and
  `systems_operator` (your systems over MCP; read, plan, confirm, write).
  The package now ships the directory; `templates/README.md` maps it, and
  `npm run syndicate:conversational` runs the first.
- **The loader looks in `templates/` too.** A bare name resolves at the
  agents root, then `examples/`, then `templates/`, so an A2A route
  (`/support_triage/…`) and a nested `yaml_reference` find a template
  without a path.
- **`web_extract` names where a redirect landed.** A URL that redirects (a
  search engine's grounding link, for one) now carries a `Resolved:` line
  with the final address, so a note can cite the publisher, not the
  redirect. Output for a URL that did not redirect is unchanged.
- **The compile tier of `npm test` walks subdirectories.** It loaded only
  the root before, which in this package meant the schema file alone; it
  now compiles every shipped syndicate.

## 0.14.0 — 2026-09-25

- **Starter pack: `assistant.yaml`, the Assistant.** The generic starting
  point for your own agent, keyless (`ollama/qwen3:8b`): the orchestrator
  converses, a Summarizer reads pasted text or up to five URLs
  (`web_extract`), a task list outlives the conversation, and longer work is
  queued as background jobs. `npm run syndicate:assistant`.
- **Five task tools.** `task_add`, `task_queue`, `task_list`, `task_get`,
  `task_update` (`lib/tools/taskTools.ts`), registered by name in the tool
  registry. One local JSON store for to-dos and jobs:
  `MELCHIZEDEK_TASKS_FILE`, default `outputs/tasks.json`. Single-user by
  design; do not serve them on a shared A2A endpoint.
- **`melchizedek-worker`: the background worker.** A fifth bin (and
  `npm run assistant:worker`) claims queued jobs one at a time, runs each
  through one agent compiled from YAML (default `--syndicate assistant
  --agent Worker`; any syndicate and agent), and writes the result back for
  `task_get`. `--once` drains the queue and exits (cron); otherwise it polls
  (`--interval`, default 30 s). The tools only write the queue; they never
  run a job.

## 0.13.0 — 2026-09-24

- **Starter pack: `research.yaml`, Research.** Questions about clinical and
  biomedical evidence, answered from trial registries and the peer-reviewed
  literature. Plan-dispatch: a triage model names one of three routes
  (`define`, `lookup`, `landscape`), and each route holds its own tools, so
  every tool call is on the answering turn's stream. `guards: [science]`
  marks any DOI, PMID or NCT number no tool returned, checks retractions, and
  catches a trial acronym attached to the wrong identifier.
- **Seven science tools, keyless.** `search_literature`, `search_preprints`,
  `search_trials`, `resolve_identifier`, `cited_by`, `survey_field`,
  `check_retraction` (`lib/tools/scienceTools.ts`), reading Europe PMC,
  ClinicalTrials.gov, Crossref and OpenAlex. Registered by name in the tool
  registry, and served to MCP clients by `npm run mcp:science`
  (`scripts/science_mcp_server.ts`, :8934). Set `SCIENCE_API_CONTACT` to an
  address you read to join the sources' polite request pools.
- **The `science` guard** is now registered in `lib/guards/index.ts`.
- **`melchizedek-skills`: the framework as a skills suite.** A fourth bin
  (and `npm run skills:install`) copies `skills/` — six Agent Skills in the
  open SKILL.md standard — into the directories coding agents read:
  `.claude/skills/` and `.agents/skills/` by default (between them, Claude
  Code, Codex, Cursor, OpenCode and Gemini CLI), or `--for
  claude,codex,cursor,opencode,gemini,agents,all`, `--global`, `--dir`,
  `--only`, `--force`, `--dry-run`; `list` and `paths` subcommands. The
  suite: `melchizedek` (where the syndicates are, what each costs, run one,
  delegate a task from a coding agent), `melchizedek-author`,
  `melchizedek-serve`, `melchizedek-memory`, `melchizedek-models`,
  `melchizedek-scribe`. `skills` joins `files`; engine: `lib/skills.ts`.
- **Starter pack: `scribe.yaml`, The Scribe.** A Gemini syndicate that
  writes one document from a technical brief and audits it against the
  brief through a JSON-schema leaf (the Auditor) before returning it.
  `npm run syndicate:scribe`. The skills suite above was written with it,
  one brief per skill.

## 0.12.0 — 2026-09-23

- **`melchizedek-doctor`: which keys do I need?** A third bin (and
  `npm run doctor`) reads every syndicate YAML the loader can see, resolves
  each agent's model to its provider under the current `.env`, and prints
  one table — agent, model, provider, which declared server-side tools the
  path keeps or drops, and whether the path is funded — with one verdict
  per syndicate and the variables that would unlock the most. Read-only:
  nothing is sent, nothing is written, no key value is printed. `--json`,
  `--check`. Engine: `lib/doctor.ts`.
- **The gateway fallback (`lib/models/gatewayLlm.ts`, `lib/models/gateway.ts`).**
  `MODEL_GATEWAY=vercel|openrouter` + `MODEL_GATEWAY_API_KEY` serve any
  cloud model id whose direct key is ABSENT through that gateway's
  OpenAI-compatible endpoint. Direct adapters stay canonical: a present
  provider key always wins, Ollama never routes through a gateway, and a
  BYOK `X-API-Key` on the A2A server never selects it. Attribution stays
  with the upstream provider (`llm.provider`); the transport is recorded
  separately (`llm.transport = gateway:<id>`). Optional dials:
  `MODEL_GATEWAY_BASE_URL` (self-hosted proxy), `MODEL_GATEWAY_MODEL_MAP`
  (wire-name overrides). `registerAvailableProviders()` registers the
  stand-in for uncovered providers; `providerStatuses()` gains
  `transport` and `gateway`; `resolveModel()` applies the same rule.
- **Capability report (`lib/models/capabilities.ts`).** `describeCapabilities`
  states, per agent and on the RESOLVED path, which server-side tool
  sentinels (`web_search`, `google_search`, `x_search`,
  `collections_search`) run natively and which are dropped. The compiler
  logs one `capability ·` line per affected agent; the chat-completions
  base records `llm.transport` and `llm.capability.dropped` on the span.
  New exports from the package root: `describeCapabilities`,
  `capabilitySummary`, `planTransport`, `gatewayConfig`, `gatewayProblem`,
  `gatewayUsable`, `GATEWAYS`, `GatewayLlm`.
- **Starter pack: `# tier:` headers.** Every example opens with `keyless`,
  a single provider (`gemini`, `anthropic`), or `multi-provider`; the
  doctor checks the claim against the models.

## 0.11.0 — 2026-09-20

- **`x_api_search`: the X channel without a Grok dependency.** A new
  client-side tool (`lib/tools/xApiSearchTool.ts`, registered in
  `TOOL_MAP`) searches X's last seven days through the X API v2 recent
  search and transcribes every PHOTO attached to a post through a Gemini
  vision pass, pasted beneath the post. It runs on any provider and needs
  `X_BEARER_TOKEN` (a read-only app token) plus the Gemini key the engine
  already uses; without the token it reports itself unavailable to the
  agent instead of failing the turn. The starter pack's `augustin.yaml`
  moves its XResearcher onto it (`gemini-3.8-flash` + `x_api_search` +
  `web_extract`), so the fact-checking arbiter no longer requires
  `XAI_API_KEY`. `x_search` stays registered for grok-* agents that want
  xAI's semantic ranker. Dials, all environment: `X_API_IMAGE_MAX`
  (photos read per page, default 8), `X_API_MAX_RESULTS` (page ceiling,
  default 50), `X_API_VISION_MODEL` (default `gemini-3.8-flash`).

## 0.10.0 — 2026-09-09

- **Post-answer guards.** A syndicate YAML may now carry an optional
  `guards:` list of guard NAMES, run after the answering turn and before
  the reply is published. A guard receives the final text plus every
  tool-result text of that turn and returns the text to ship along with
  notes for the `[STATUS]` stream; it rewrites in place rather than
  re-asking the model. Three shape changes to the published surface:

  - `SyndicateYamlConfig` (`./loadSyndicate`) gains `guards?: string[]`.
    Optional, so every existing config still typechecks.
  - `./loadSyndicate` gains `collectGuards(config, loadNested?)`, which
    returns the union of guard names declared by a syndicate **and by
    every syndicate it nests through `yaml_reference:`**. Read guards
    with this rather than off `config.guards`: a guard belongs to the
    syndicate that declared it, not to the position it occupies in a
    graph, and reading the top-level field alone silently dropped a
    nested syndicate's guards.
  - A new `lib/guards/index.ts` publishes the `Guard` / `GuardResult`
    interfaces and `resolveGuards(names, onUnknown?)`. The registry ships
    EMPTY — the guards this deployment runs are domain modules that stay
    private, the same arrangement `lib/toolRegistry.ts` uses. Register
    your own by adding it to that file's `GUARD_MAP`; an unregistered
    name warns and is skipped rather than failing the run.

  `config/agents/syndicateSchema.yaml` documents the field. No bin
  changes; no existing export changes shape.

- **`lib/tools/mcpServe.ts` (new, internal).** The express/SSE scaffold
  behind `npm run mcp:wiki` — `serveContracts({ name, label, port,
  contracts })` — extracted from three byte-identical copies that had
  begun to drift on error signalling and on whether they read `.env`.
  Not in the exports map and not a bin, but it now ships because
  `scripts/wiki/mcp_server.ts` imports it. Behaviour change for MCP
  clients: a failed tool call is returned with the spec's `isError`
  flag set instead of as an ordinary successful result, so a client can
  tell "the tool answered" from "the tool failed".

## 0.9.6 — 2026-09-02

- **`web_extract` joins the public tool registry.** The tool's source
  (`lib/tools/webExtractTool.ts`) has shipped in the package since
  2026-08-09, but the sanitized `lib/toolRegistry.ts` never mapped the
  YAML name, so `augustin.yaml`'s two researchers logged an unknown-tool
  warning and ruled from search snippets. Declaring `web_extract` in a
  syndicate now resolves to the client-side page reader on every
  provider, local Ollama included. Additive: no export, bin, or starter
  file changes shape.

## 0.9.5 — 2026-09-02

- **The default production Gemini is now `gemini-3.8-flash`.** Two
  exported constants change VALUE (not shape): `MEMORY_EXTRACTION_MODEL`
  and `WIKI_AGENT_MODEL` in `lib/config.ts`, plus the internal
  `VISION_MODEL` behind `inspect_image`. Every starter-pack syndicate
  that shipped on `gemini-3.7-flash` now ships on `gemini-3.8-flash`.
  The cheap tier is untouched: `DEFAULT_GEMINI_MODEL` stays
  `gemini-3.1-flash-lite`, and `ares` / `model_zoo` keep their flash-lite
  pins. Nothing in the exports map or the two bins changes.

  The id was verified against the live endpoint before pinning:
  `models/gemini-3.8-flash` publishes exactly 3.7's envelope —
  1,048,576 input, 65,536 output, `thinking: true`, identical
  `supportedGenerationMethods` — so no `maxOutputTokens` in any shipped
  YAML changes and none is an over-ask.

  If you pin a model explicitly in your own YAML, nothing changes for
  you. If you rely on the defaults and want the old behaviour, set
  `WIKI_AGENT_MODEL=gemini-3.7-flash` (env) or pin `model:` in your
  syndicate.

## 0.9.4 — 2026-09-02

- **Thinking and replies stream live.** The OpenAI-compatible adapter
  (Ollama, xAI) now honours ADK's `stream` flag instead of ignoring it:
  it sends `stream: true`, parses the SSE frames, and yields each
  reasoning and text delta as a display-only partial. `melchizedek-chat`
  runs with `streamingMode: SSE`, so a local qwen3 turn shows its
  scratchpad token by token from ~1.5s rather than dumping the whole
  turn after ~15s. `CHAT_STREAMING=false` restores one-block output —
  useful when piping a transcript or for structured-output agents.
  Reasoning is read from a discrete `reasoning` / `reasoning_content`
  delta field where the provider sends one (Ollama does), and otherwise
  from inline `<think>` tags via a new exported `ThinkStreamSplitter`,
  which tracks block state across frames so a tag split mid-delta
  ("<thi" + "nk>") is not mistaken for reply text.
- **Fix: a streamed Claude turn no longer vanishes from session
  history.** ADK's runner persists only NON-partial events, and the
  Claude streaming path built its final response with the text omitted,
  so a reply would render on screen and leave no record — the next turn
  saw no assistant message. The final response now carries the full
  text; printers skip text on a `turnComplete` event whose partials they
  already rendered. This path was unreachable before this release, since
  nothing requested SSE.
- **Chat is silent about telemetry.** `melchizedek-chat` and every
  `syndicate:*` script no longer print `[OTEL_SPAN_JSON]` lines; set
  `OTEL_CONSOLE_SPANS=true` (shell or `.env`) to see them, and
  `OTEL_CONSOLE_SPANS=false` to silence them in other scripts. In-process
  span listeners and the Supabase sink are unaffected either way, so no
  telemetry is lost.

## 0.9.3 — 2026-08-22

- **`outputSchema` is enforced on every provider, not just Gemini** —
  the Claude adapter now carries an agent's `outputSchema` as a forced
  tool call (`tool_choice` on a synthetic `structured_output` tool whose
  `input_schema` is the schema) and turns the validated `tool_use` block
  back into JSON text, so the keys arrive as declared instead of drifting
  (`"grade"` for `"correctness"`); the OpenAI adapter sends
  `json_schema` with `strict: true` over a schema where every object
  forbids extra properties and requires all of its own
  (`toStrictJsonSchema`), which the API previously rejected; the
  OpenAI-compatible adapter (xAI) does the same, while Ollama keeps
  `json_object`. Anything that reads structured fields by name — critic
  loops, plan-dispatch routers on non-Gemini models, LLM judges — now
  works across providers.
- **Engine additions behind the A2A server**: the shared YAML→ADK compiler
  (`lib/compile.ts`), provenance stamps (`lib/observability/lineage.ts`),
  embeddings (`lib/observability/embeddings.ts`), the three-tier
  observability ledger in `db/telemetry.sql` with identity and
  provenance on every span, and `scripts/telemetry_admin.ts`. New
  optional dependency `@opentelemetry/exporter-trace-otlp-http` for
  `OTEL_EXPORTER_OTLP_ENDPOINT`.

## 0.9.2 — 2026-08-20

- **The starter pack gains Augustin** —
  `config/agents/examples/augustin.yaml`, a fact-checking arbiter of
  world events: a grok X-sweep researcher and a Gemini web-verification
  researcher under a tool-free Arbiter that writes a conversational
  lead plus sourced bullet facts. Multi-provider (needs `XAI_API_KEY`
  and `GOOGLE_GENAI_API_KEY`); `npm run syndicate:augustin` in a clone.
  The pattern is taught as a standalone lesson in the curriculum.

## 0.9.1 — 2026-08-19

- **Fix: `melchizedek-serve` actually starts.** The run-as-main guard
  compared `import.meta.url` to argv[1] literally; through the npm bin
  symlink they never match, so the 0.9.0 bin imported everything and
  exited silently. The guard now realpaths argv[1]. `melchizedek-chat`
  was unaffected.
- `melchizedek-serve` without an argument now explains itself when no
  `syndicate.yaml` exists (name your syndicate: `melchizedek-serve
  <name>.yaml`) instead of failing with a bare ENOENT.
- QUICKSTART gains §7, the package-consumer path (docs ship in the
  tarball, so they ride this release).

## 0.9.0 — 2026-08-19

First packaged release (pre-1.0: the API may still move; 1.0.0 lands
after the first external consumer migration).

- The engine is installable: `npm install melchizedek-agents` ships
  compiled JS + type declarations for `lib/` (`loadSyndicate`, the model
  registry, the tool registry, memory/session/persistence/observability,
  the wiki engine) behind an explicit subpath exports map.
- `loadSyndicate` accepts `agentsDir` (or the `MELCHIZEDEK_AGENTS_DIR`
  env var) so your syndicates live in **your** repo; default remains
  `<cwd>/config/agents`. The path jail applies relative to whichever
  root is configured.
- Two bins: `melchizedek-serve` (the A2A server) and `melchizedek-chat`
  (the interactive syndicate CLI).
- The starter pack ships in the package: `config/agents/examples/*.yaml`
  plus `syndicateSchema.yaml` — copy them out, they are teaching
  material, not wiring.
- `@google/adk` is a peer dependency: your app owns the ADK version.
