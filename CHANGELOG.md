# Changelog — melchizedek-agents (the npm package)

Consumers of the package read this file; it records changes to the
**published API surface** (the exports map in `package.json`, the bins,
the starter pack and the templates), not the repo's full history.

## Unreleased

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
  what each level becomes per provider (and the newer Claude models on which
  to leave it unset until the adapter maps it to their effort setting), and
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
