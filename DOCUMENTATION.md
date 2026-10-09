# melchizedek-agents — reference documentation

The framework in one sentence: **a syndicate is a YAML file describing an
agent graph; the engine compiles it into agents on its own loop, with
tools, sessions, and memory attached.** This document is the reference
for that file format and the machinery around it. For a guided first run,
see [`QUICKSTART.md`](./QUICKSTART.md).

## Contents

1. [Architecture](#1-architecture)
2. [The syndicate YAML](#2-the-syndicate-yaml)
3. [Tools](#3-tools)
4. [Sessions & long-term memory](#4-sessions--long-term-memory)
5. [Multi-model support](#5-multi-model-support)
6. [A2A service mode](#6-a2a-service-mode)
7. [Extending the framework](#7-extending-the-framework)
8. [Security notes](#8-security-notes)
9. [The knowledge bundle (wiki/)](#9-the-knowledge-bundle-wiki)

---

## 1. Architecture

```
config/agents/            YOUR syndicate definitions (the engine's input)
config/agents/examples/   the starter pack — shipped example syndicates
lib/loadSyndicate.ts      YAML → validated config (+ variable binding)
lib/dispatch.ts           plan-dispatch route resolution (§6)
lib/toolRegistry.ts       tool name → the engine's own Tool
lib/models/claudeAdapter.ts  Claude on the engine's model contract
lib/models/ollamaLlm.ts   open-weight local adapter (Ollama, keyless)
lib/models/chatCompletionsAdapter.ts  the chat-completions wire on the model contract
lib/tools/mcpToolFactory.ts  MCP client: remote tools → the engine's own Tools
scripts/demo_mcp_server.ts   demo MCP server (library catalog, SSE)
lib/runtime/native/…      the native loop: steps, delegation, compaction, interrupts
lib/workflow/…            the workflow scheduler for `workflow:` syndicates
lib/session/…             Supabase-backed session service
lib/memory/…              pgvector long-term memory service
lib/observability/…       OpenTelemetry run tracing
lib/runtime/syndicateTurn.ts  THE turn runner: every surface below calls it
lib/a2a/app.ts            the A2A server as a library (createA2AApp)
lib/a2a/remoteAgent.ts    A2A client: remote agents as subagents
scripts/syndicate_chat.ts CLI REPL / one-shot runner
scripts/a2a_server.ts     the A2A server bin (melchizedek-serve)
db/schema.sql             the base schema (sessions, memory, expiry)
db/hardening.sql          deny-by-default RLS for the Supabase tables
tests/agents.test.ts      compiles every shipped syndicate; opt-in live check
```

Execution flow: `loadSyndicate` reads and validates the YAML and binds
`{{variables}}` → the compiler builds each agent on the engine's own
loop, wiring subagents as delegation tools and tool names through the
registry → the loop runs the turn, calling each agent's model through its
adapter on the engine's model contract and persisting events to the
session service → on session end, the memory service distills the
transcript into tagged facts, embeds them (768-d), and stores them for
future recall.

The compiler (`lib/compile.ts`) first builds a runtime-neutral `AgentSpec`
per agent, and `lib/compileNative.ts` turns it into the native loop's
agent. The native runtime is the only runtime
([ADR 0107](./wiki/decisions/0107-release-1-0-0-removes-adk.md)): it owns the
loop, the model contract and its adapters, the tools, the sessions and
the workflow scheduler, and runs a single-agent, delegating,
plan-dispatch or `workflow:` syndicate, `context:` compaction
([ADR 0078](./wiki/decisions/0078-native-compaction-ports-adk-compactor.md)),
`mode: task`, and pause and resume included
([ADR 0095](./wiki/decisions/0095-native-workflow-turn-drains-through-the-adk-reader.md)).
Two configurations it refuses with `UnsupportedOnRuntimeError` before any
model call: a `transformAgent` hook (it transformed ADK agents), and an
`ask_user` tool on a workflow node (use an `ask_user` node)
([ADR 0073](./wiki/decisions/0073-one-agent-spec-and-a-runtime-flag.md)).

1.0.0 removed Google ADK
([ADR 0045](./wiki/decisions/0045-own-runtime-behind-the-seam.md),
[ADR 0107](./wiki/decisions/0107-release-1-0-0-removes-adk.md)).
`MELCHIZEDEK_RUNTIME=native` (or `runtime: 'native'` on
`runSyndicateTurn`) changes nothing; `adk` throws `RuntimeRemovedError`,
naming 1.0.0, at the startup of the A2A server, the chat and the worker,
and from `runSyndicateTurn` before the session is touched; any other value
is a configuration error. The engine stores the same event JSON ADK wrote,
so a session written before 1.0.0 resumes, and `npx melchizedek-doctor`
prints the runtime in use and where the choice came from. Upgrading from
0.x: read the 1.0.0 "Breaking — read before upgrading" section of
[`CHANGELOG.md`](./CHANGELOG.md).

## 2. The syndicate YAML

Minimal complete example:

```yaml
syndicate_name: "My Council"
memory_system: "session-only"     # internal-only | session-only | long-term

# guards: [my_guard]              # [optional] post-answer guards, by name

variables:                        # bound into {{placeholders}} at load
  headline_count: 5               # current_date is injected automatically

orchestrator:
  name: "Conductor"
  model: "gemini-3.8-flash"
  instruction: |
    You are the Conductor… (persona, objective, workflow contract)
  tools:
    - "google_search"             # names resolved via lib/toolRegistry.ts
  reasoning: medium               # none | low | medium | high, or { budget_tokens: 4096 }
  generateContentConfig:
    maxOutputTokens: 4096

subagents:
  - name: "Researcher"
    description: "Use this subagent to… Pass it one focused query."
    model: "gemini-3.8-flash"
    instruction: |
      You are the Researcher…
    tools: ["google_search"]
```

Field reference:

| Field | Where | Meaning |
|---|---|---|
| `syndicate_name` | root | Display name. On the CLI it also namespaces memory user keys; on the A2A server memory is keyed by the caller's silo across every long-term syndicate that server serves. |
| `memory_system` | root | `internal-only` (nothing persists — on the server too: its transcripts stay in process memory), `session-only` (transcript persists in Supabase), `long-term` (adds fact distillation + vector recall). |
| `variables` | root | Key/values bound into `{{placeholders}}` anywhere in instructions. `current_date` is always injected; CLI `--bind key=value` overrides. |
| `memory_extraction_rules` | root | Domain rules appended to the shared fact-extraction prompt for THIS syndicate only (requires `memory_system: "long-term"`). The extraction prompt is global — anything domain-specific belongs here, never edited into it. Unset, the prompt renders byte-identical to before the slot existed (§4). |
| `memory_extraction_model` | root | The model that distils this syndicate's turns into memory records (long-term only); any model id. Default: the deployment's `MEMORY_EXTRACTION_MODEL`. |
| `memory_retention_days` | root | Days a fact in this syndicate's namespace is kept; the server deletes older facts when it loads the syndicate and daily after. Requires `memory_namespace` (never applied to the shared default namespace). |
| `dispatch` | root | Switches the syndicate from DELEGATE to PLAN-DISPATCH routing (§6). `default_route` (required) names the fail-static subagent; `route_key` / `reason_key` name the router's JSON properties (defaults `route` / `reason`). Honoured by every surface (the CLI, the server, the worker, evals). |
| `workflow` | root | Switches the syndicate to a WORKFLOW (§6): a graph whose nodes are its agents plus declared `join`, `map`, `tool` and `ask_user` nodes, and whose `edges` say what runs after what and on which route. The orchestrator is a node like any other; nothing delegates. Cannot be combined with `dispatch`. Contract: `lib/workflow.ts`; worked example: `examples/pipeline.yaml`. |
| `retries` | root | Self-correction, on by default ([ADR 0034](./wiki/decisions/0034-self-correction.md)): `model_errors` (default 2) retries a model reply marked malformed (`MALFORMED_FUNCTION_CALL`) instead of failing the turn; `tool_errors` (default 3) answers a tool that threw with structured reflection guidance and caps its retries. `0` turns either off. Every retry is a model call under `max_steps`. |
| `guards` | root | Optional list of post-answer guard NAMES (`lib/guards/index.ts`). Each runs after the answering turn and before the reply publishes, receiving the final text plus every tool-result text of that turn, and rewrites in place rather than re-asking the model; its notes land in the `[STATUS]` stream. Guards declared by a syndicate reached through `yaml_reference:` count too — the server resolves the union via `collectGuards()`. Resolved by name, never by module path, so adding one is a deliberate act in code; **the published registry ships one, `science`** (citation checks for `research.yaml`); `registerGuard()` adds your own from code, and an unregistered name is warned about and skipped. |
| `name` / `model` / `instruction` | agent | The agent triple. Any Gemini id, `claude-*`, or `ollama/*` for open-weight local models (see §5). |
| `description` | subagent | **The delegation API.** The orchestrator reads this when deciding to hand off — write it like a function signature ("Use this subagent to…, pass it…"). |
| `tools` | agent | Names resolved by the tool registry (§3). Long-term memory agents add `preload_memory` / `load_memory`. |
| `reasoning` | agent | How hard the agent reasons, on any provider: `none`, `low`, `medium`, `high`, or `{ budget_tokens: <int> }`. The compiler sends each provider the field it reads: a thinking level on Gemini 3, a thinking budget on Claude 4.6 and earlier (2,048 / 8,192 / 16,384 tokens for low / medium / high), adaptive thinking with that effort on later Claude models ([ADR 0049](./wiki/decisions/0049-claude-requests-by-model-generation.md)), an effort word on GPT, Grok, Kimi, Ollama and the gateway ([ADR 0047](./wiki/decisions/0047-provider-neutral-reasoning-key.md)). Unset, each adapter keeps its own default. |
| `generateContentConfig` | agent | Temperature, output caps. Its `thinkingConfig` and `reasoningEffort` are the older, provider-specific spelling of `reasoning`; setting either next to `reasoning` is a load error. |
| `outputSchema` | agent | Structured-JSON contract: the agent ends its turn on one JSON object matching it. An orchestrator may hold one beside its subagents: it delegates first, then answers in the schema itself. The schema travels in the provider's own structured-output field beside the tools on Claude from Opus 4.8, Sonnet 5 and Haiku 5.5, on OpenAI, and on Gemini 2+ through Vertex AI, and as a `set_model_response` tool elsewhere (the capability matrix's `structured_output_with_tools`, [ADR 0109](./wiki/decisions/0109-structured-output-beside-tools.md)). A leaf that holds the schema (`critic.yaml`) and plan-dispatch remain the choices when the answer should be a specialist's. |
| `yaml_reference` | subagent | Mount another syndicate file as a nested subagent. |
| `a2a_agent_url` | subagent | A REMOTE agent over A2A (§6): the orchestrator delegates to it with one `request` argument; in plan-dispatch it can be a route. No `model`/`instruction` — the remote agent has its own. Credentials come from `A2A_AGENT_TOKENS`, never YAML. |
| `max_steps` | root | Cap on model calls per turn, counted across every agent the turn reaches (orchestrator, subagents, nested syndicates). Exceeding it fails the turn with `STEP_LIMIT`. |
| `includeContents` / `outputKey` / `globalInstruction` / `disallowTransferToParent` / `disallowTransferToPeers` | agent | Passed through to the agent (spelled after ADK's `LlmAgent` fields). `includeContents: none` makes an agent see only the current message. |
| `fallback_model` | any agent | A model, ideally on another provider, that answers when this agent's model fails provider-side (5xx, 429, a connection reset, after its own retries) before producing any output, or while that provider's circuit is open: after `MODEL_BREAKER_THRESHOLD` consecutive provider failures (default 5; 0 disables) the provider is skipped for `MODEL_BREAKER_COOLDOWN_MS` (default 30 s). A 4xx and a canceled turn are never redirected, and a stream that already produced text is never replayed elsewhere ([ADR 0044](./wiki/decisions/0044-fallback-model-and-circuit-breaker.md)). |
| `mcp_tools` | subagent | The MCP server's tools this agent may use; any other tool the server lists is not exposed. On a dispatch route `require_approval` may name them ([ADR 0041](./wiki/decisions/0041-tool-vendors-get-least-privilege.md)). |
| `mcp_auth` | subagent | `{ oauth2 }`: the OAuth grant the MCP server takes, the same block as an OpenAPI `auth.oauth2`. `client_credentials` sends the server's own token; `authorization_code` sends each user's own token on their own connection (the consent pause asks for it) and needs `mcp_tools` ([ADR 0112](./wiki/decisions/0112-oauth-grants-declared-beside-the-tool.md)). |
| `mcp_server_url` | subagent | Discover this subagent's tools from a remote MCP server at load time (§3). SSRF-guarded; `ALLOW_PRIVATE_MCP=true` permits localhost for development. |
| `openapi` | any agent | HTTP APIs as tools, each from an OpenAPI 3 spec file (§3, OpenAPI tools): `spec`, and optionally `operations` (default: the GET operations only), `auth` (from environment variables), `base_url`, `prefix`. |
| `code_execution` | any Gemini agent | `"gemini"`: the model writes Python and Gemini runs it in Google's server-side sandbox, returning the output to the model; nothing runs on this host. For arithmetic, data and checks a model gets wrong in its head. Gemini models only ([ADR 0033](./wiki/decisions/0033-context-task-code.md)). |
| `context` | orchestrator | Compacts a long conversation: when the last request's prompt passed `compact_after_tokens`, earlier turns become one summary (written by `summary_model`, default the agent's own) and the last `keep_recent_events` stay verbatim. The full history stays stored; only what the model reads shrinks. The orchestrator of a delegate syndicate only: a dispatch route already reads a bounded projection, a workflow node sees only its input. |
| `mode` | workflow node | `"task"`: the agent works with its tools until it calls `finish_task`, whose arguments (matching its `outputSchema`) become the node's output. Workflow nodes only. |
| `examples` | any agent | Few-shot exchanges, `[{ input, output }]` (up to 20), added to every request's instruction as a few-shot block, the one ADK's `ExampleTool` wrote (an Instruction tool, `lib/tools/examples.ts`); the model never calls it. Keeps worked examples out of the prose of `instruction`. |
| `skills` | any agent | Agent Skills (a directory of SKILL.md folders) the agent holds the way a coding harness does: every skill's name and description is appended to its instruction at compile time; `load_skill` reads one in full with the names of its files, `load_skill_resource` reads one file. `scripts: local` adds `run_skill_script`, which runs a skill's own scripts on this machine, each after a person approves (the `require_approval` pause), with PATH, HOME, the temp directory and the locale but none of the server's keys, plus the variable names listed under `env:` (or `secret_env:` for a secret-shaped name, ADR 0086), and stdout and stderr each cut at 20,000 characters; `tools:` names registry tools a skill's `allowed-tools` may unlock once loaded. Worked example: `examples/harness.yaml`; engine: `lib/tools/skillToolset.ts` over `lib/tools/skills/`. |

Validation happens at load: missing names, legacy option blocks, and
malformed agents fail with pointed errors before any model is called.
Tool names are deliberately *not* strictly validated — unknown names are
skipped with a warning at compile time.

## 3. Tools

Registered in `lib/toolRegistry.ts` — one map from YAML name to tool. A
**Contract** is the engine's own Tool (`lib/tools/tool.ts`), defined once
with `defineTool`; the native loop runs it as it is. An **Instruction
tool** is the engine's own too: it declares no function and only writes
into each request's instruction. A **server-side tool** is an own marker
(`lib/tools/nativeTools.ts`) that names the provider's tool and declares no
function, and every adapter recognises it by marker
([ADR 0062](./wiki/decisions/0062-server-side-tools-as-markers.md)):

| Name | Kind | Does |
|---|---|---|
| `web_search` | Provider-agnostic | Live web search via the agent model's NATIVE search: Gemini grounding, Anthropic `web_search` server tool, OpenAI Responses `web_search`, xAI Agent Tools `web_search`. On local `ollama/*` models, and on `kimi-*` (Moonshot's model-side search retires 2026-10-20; its successor is a REST API, not a request field), the tool is omitted with a one-time warning (keyless stays keyless). On grok-* agents, optional server-side domain filters via `XAI_WEB_SEARCH_ALLOWED_DOMAINS` / `_EXCLUDED_DOMAINS` in `.env` (max 5, mutually exclusive; xAI accepts no date bounds — those are `x_search`-only). Prefer this in new YAMLs. |
| `web_extract` | Contract | Deterministic page reading: fetches 1–5 agent-chosen URLs and returns clean page text (no LLM summarization). Keyless — works on every provider including local `ollama/*`. Per-page char budget (default 15k, `WEB_EXTRACT_CHAR_LIMIT`); long pages return a head+tail window with an `offset` continuation call served from a 15-minute cache. SSRF-guarded (http(s) only, private/link-local hosts refused, redirects re-checked). Block pages (bot checks, paywall stubs, JS shells) are detected code-side and returned as labeled `Error:` blocks, never as content. Pair with `web_search`: search to find, extract to read past the headline. |
| `x_search` | xAI-only | Live search over X (Twitter) posts via xAI Agent Tools. Self-gates to `grok-*` agents; a silent no-op on every other provider, so mixed-provider YAMLs stay safe. Optional server-side constraints in `.env`: `XAI_X_SEARCH_FROM_DATE`/`_TO_DATE` (inclusive `YYYY-MM-DD`) and `_ALLOWED_HANDLES`/`_EXCLUDED_HANDLES` (max 20, mutually exclusive — allowlist wins). |
| `collections_search` | xAI-only | Semantic search over xAI **Collections** — hosted document stores (PDFs/text/CSVs) uploaded at console.x.ai — server-side RAG with `collections://…` citations. Which collections: `XAI_COLLECTION_IDS` in `.env` (optional `XAI_COLLECTIONS_MAX_RESULTS`). Declared with no ids → omitted with a warning; non-xAI providers → silent no-op. |
| `url_context` | Gemini built-in | Gemini reads the pages at URLs in the conversation, server-side (Google fetches them, not this host). On any other provider it is a no-op the doctor reports as dropped; use `web_extract` there. |
| `google_search` | Gemini built-in | Live web search — Gemini agents only (legacy alias; use `web_search`). |
| `preload_memory` | Instruction tool | Silently injects similarity-matched facts into every request's instruction (ambient recall). The model never calls it. |
| `load_memory` | Contract | Explicit tool call to search the fact store (deliberate recall). Both memory tools read the caller's own silo only and send the model what ADK's tools of the same names sent ([ADR 0059](./wiki/decisions/0059-memory-on-the-engines-own-interfaces.md)). |
| `generate_image` | Contract | Calls the Gemini image model directly, saves the result under `outputs/`, returns the path. A function tool because binary `inlineData` cannot survive delegation, where a subagent returns only its final text. |
| `inspect_image` | Contract | **Blind visual inventory** of a file under `outputs/`: subjects with exact counts, composition, light, palette, medium cues, artifacts — zero quality judgments. Its signature accepts *only* a file path, so an orchestrator cannot leak expectations into the observation (see `image_production.yaml`). |
| `task_add` / `task_list` / `task_get` / `task_update` | Contract | A to-do list and job queue. Default: a single-user JSON file (`MELCHIZEDEK_TASKS_FILE`, default `outputs/tasks.json`), so every caller of a shared endpoint shares one list. With `DATABASE_URL` (migration 0009) each caller has its own list, scoped by the caller's scope key, and any number of workers take jobs safely. |
| `ask_user` | Contract, long-running | Asks the person one question (optionally with `options`) and ends the turn `input-required`; the next message on the conversation is the call's result. Any agent but a workflow node's; inside a delegated subagent the question reaches the person with the agent path (§6, Questions). |
| `task_queue` | Contract | Queues a background job (a self-contained instruction). The tool only writes the queue; `npm run assistant:worker` (`melchizedek-worker`) claims each job, runs it through one agent compiled from YAML (default: the Assistant's Worker), and writes the result back for `task_get`. `--once` drains and exits, for cron. A run is durable (ADR 0113): it is checkpointed beside the job at every step boundary (migration 0014 on Postgres), a job claimed again resumes from its last checkpoint, SIGTERM re-queues the job in hand, and `task_update` can cancel a running job. |

**MCP tools** are the exception to the registry: a subagent with
`mcp_server_url:` in its YAML gets its tools from a remote MCP server at
load time. `lib/tools/mcpToolFactory.ts` dials the server over SSE,
lists its tools, and makes each one an own Tool (`loadMcpTools`) — the
agent's reach is decided by the server, not compiled in.
`config/agents/examples/librarian.yaml` plus the demo catalog server
(`npm run mcp:demo`, `scripts/demo_mcp_server.ts`) are the worked
example: read tools *and* write tools, so the agent demonstrably
modifies data on the far side of the protocol. The factory refuses
loopback/private hosts unless `ALLOW_PRIVATE_MCP=true` (SSRF guard);
treat any remote MCP server as an untrusted tool vendor whose results
are data, never instructions.

**OpenAPI tools** turn any HTTP API with an OpenAPI 3 spec into an
agent's tools, with no tool code (`lib/tools/openapiTools.ts`, on the
engine's own parser and caller in `lib/tools/openapi/`;
[ADR 0032](./wiki/decisions/0032-openapi-tools.md),
[ADR 0067](./wiki/decisions/0067-openapi-calls-on-the-engines-own-caller.md)):

```yaml
orchestrator:
  name: Forecaster
  openapi:
    - spec: "specs/open-meteo-forecast.json"     # relative to this YAML file
      operations: [getForecast]                  # omitted: every GET operation
      auth: { api_key: { env: "WEATHER_KEY", in: "header", name: "X-Api-Key" } }
      # base_url: overrides servers[0].url · prefix: keeps two APIs apart
```

One tool per operation, named from its `operationId` in snake_case
(`getForecast` → `get_forecast`; no `operationId`: path and method), with
the parameters and request body as its arguments and the operation's
`summary` as the description the model reads. Exposure is deliberate:
without `operations`, only GET operations become tools, so anything that
writes is exposed only by naming it, and a named operation can be listed
under `require_approval` (as written under `operations`) so a person
approves each call. `auth` names an environment variable, never a value
(`bearer_env`, or `api_key` with `in: header | query` and `name`), or
declares an OAuth grant (`oauth2`: `provider`, `grant: authorization_code |
client_credentials`, `authorization_url`, `token_url`, `client_id` or
`client_id_env`, `client_secret_env`, `scopes`), whose token each call
fetches: the run's user's own through the consent pause, or the server's own
from the token endpoint ([ADR 0112](./wiki/decisions/0112-oauth-grants-declared-beside-the-tool.md)).
`oauthClientsFor(configs)` (`melchizedek-agents/tools/oauthTools`) builds the
consent step's clients from the same YAML, and `npm run doctor` lists every
tool that needs a grant. An unset variable fails the compile, and so does one of the framework's own settings
(the database URL, a provider key, an `A2A_` secret: anything `.env.example`
documents), since the YAML chooses the host it goes to.
`OPENAPI_CREDENTIAL_ENVS`, when set, is the exact list of variables an `auth`
may name. A refused or unset variable fails the compile, and a static token is applied to the request,
never stored in session state. Every server must be http(s) and pass the
SSRF guard: its literal rules when the agent compiles, the full check with
DNS before each call; `ALLOW_PRIVATE_OPENAPI=true` permits private hosts for
local development. Redirects are followed one hop at a time, each hop held
to the guard, and a hop to another origin carries no credential. A
credential's value never appears in an error the model reads. Only OpenAPI
3.x specs are read. A response over 20,000 characters is cut and says so; a
network failure comes back to the model as an error. Specs are files, never
URLs: save the spec beside the YAML and review it like code (trim it to the
operations the agent needs, and write each `summary` for the model). Worked
example: `config/agents/examples/weather.yaml`, two keyless Open-Meteo specs
in `examples/specs/`.

> **Schema dialects, handled for you.** The factory emits Gemini-style
> UPPERCASE schema types (`'OBJECT'`, `'STRING'`, …), the `@google/genai`
> dialect; every non-Gemini adapter normalizes them back to
> standard lowercase JSON-Schema at request-build time
> (`lib/models/schemaNormalize.ts`). MCP tools therefore work on any
> provider's agents — Gemini, Claude, GPT, Grok, or Kimi.

## 4. Sessions & long-term memory

Two Supabase tables carry the two kinds of remembering:

- **`adk_sessions`** — the running transcript (events + state), so a
  conversation survives process restarts.
- **`adk_memory_facts`** — distilled structured records: each carries
  its 768-d embedding plus the date it is about, the source who asserted
  it, active/superseded status, and entity index keys. Written at
  session end (`exit`, SIGINT, or one-shot completion), keyed per
  syndicate + user. Corrections supersede old rows (kept as linked
  history); recall is cosine similarity re-ranked by keys and dates.
  Full pipeline: [`lib/memory/README.md`](./lib/memory/README.md).

Install both, with their indexes, the recall function and the nightly
session expiry, from the one canonical file:

```bash
npx melchizedek-db print     # paste into the Supabase SQL Editor (clone: npm run db -- print)
npx melchizedek-db apply     # or apply with psql, DATABASE_URL set
npx melchizedek-db status    # schema version, hardening, session counts
```

That runs the migrations in [`db/migrations/`](./db/migrations/) and then
[`db/hardening.sql`](./db/hardening.sql). Both are idempotent, so re-running
them is also the upgrade path from any earlier layout. `apply` runs the whole
install as one transaction under an advisory lock: if any statement fails,
nothing is changed, and two applies started together run one after the other.
Rolling back a migration that succeeded is a restore from backup (§6), since
the migrations only move forward.

The tables go in the `public` schema by default. To keep them out of reach of
a REST layer (Supabase exposes `public`), install into a private schema and
run the server with the same setting:

```bash
MELCHIZEDEK_DB_SCHEMA=melchizedek npx melchizedek-db apply   # or: apply --schema melchizedek
MELCHIZEDEK_DB_SCHEMA=melchizedek DATABASE_URL=... npx melchizedek-a2a
```

A private schema needs `DATABASE_URL` (the pg driver); supabase-js storage
reaches only exposed schemas, so the server refuses that combination. Moving an
existing `public` install is a data migration, not a setting: keep `public`
there.

Then run [`db/hardening.sql`](./db/hardening.sql) (RLS deny-by-default;
see §8). Upgrading an existing project to the structured columns:
[`db/memory_v2.sql`](./db/memory_v2.sql). `npm run db:purge` clears both
tables; for per-record inspection and hand-clearing, `npm run memory`
(`scripts/memory_admin.ts`) lists silos, groups likely restatements
(`--dupes`), and deletes chosen records — a dry run unless `--yes`, with
every delete scoped to its `--silo`. Cleanup means DELETE, not
`status='superseded'`: `match_memory_facts` filters on `user_key` alone
and applies status afterwards in the re-rank, so a retired row still
consumes a candidate slot (see `lib/memory/README.md`).

**Ingestion is incremental, and dedup is semantic.** A stateless service
(the A2A server, §6) ingests after *every* completed task with the whole
session — so an N-turn conversation would be distilled N times over a
growing transcript, and byte-equality dedup never catches it because the
extraction model rephrases on each pass. Two mechanisms in
`lib/memory/supabaseMemoryService.ts` prevent the store from filling
with restatements:

- A per-session **processed marker** (`eventsToIngest`) distils only the
  turns added since the last ingestion. It is stored in
  `melchizedek_memory_ingest` (migration 0007) and advances in the same
  transaction as the facts (`melchizedek_memory_commit`, which also retires
  superseded rows), so a restart re-extracts nothing and a failure leaves
  facts, supersessions and marker as they were. A custom store without the
  commit keeps the marker in process memory.
- At boot the server compares the embedding column's size
  (`melchizedek_memory_dimensions()`) with the configured embedder and
  refuses a mismatch: changing the embedding model is a re-embed, never a
  dropped table.
- A **similarity probe** before each insert (`isSemanticDuplicate`,
  `MEMORY_DEDUP_SIMILARITY = 0.93`) drops restatements, reusing the same
  `match_memory_facts` RPC the supersession path calls. It requires the
  same tag — an `[EPISODE]` about a topic must never suppress the
  `[FACT]` it mentions — and retired rows never suppress a new one. A
  probe that errors **fails open and stores**: a duplicate costs a
  shortlist slot, a lost fact costs the user something they said.

**Per-consumer extraction rules.** The fact-extraction prompt is shared
by every long-term consumer, so domain rules arrive through the
`memory_extraction_rules` field on the syndicate (§2) rather than being
edited into the prompt. It fills a `{domain_rules}` slot that renders
empty when unset — a syndicate declaring none gets byte-identical
behaviour to before the slot existed. Use it to say what is worth
remembering in your domain: what the user asserted, decided, or
committed to is usually worth storing; a value that goes stale on its
own usually is not, because a stored copy can never be used, only crowd
out records that can. `config/agents/syndicateSchema.yaml` shows the
shape.

A memory store is a PII store: key facts to users, honor deletion, set
retention deliberately. Vectorization is not anonymization — the
plain-text fact sits beside its embedding.

## 5. Multi-model support

The agent's `model:` id names its provider, and the framework routes
accordingly — model optionality is a single YAML line per agent:

| Model id | Provider | Adapter | Key | Native `web_search` |
|---|---|---|---|---|
| `gemini-*` | Google Gemini | `lib/models/geminiAdapter.ts` (`@google/genai`) | `GOOGLE_GENAI_API_KEY` | ✅ grounding |
| `claude-*` | Anthropic | `lib/models/claudeAdapter.ts` (Messages API) | `ANTHROPIC_API_KEY` | ✅ server tool |
| `gpt-*`, o-series | OpenAI | `lib/models/gptAdapter.ts` (Responses API) | `OPENAI_API_KEY` | ✅ web_search tool |
| `grok-*` | xAI | `lib/models/grokAdapter.ts` (Responses API) | `XAI_API_KEY` | ✅ Agent Tools search |
| `kimi-*` | Moonshot AI (Kimi) | `lib/models/kimiAdapter.ts` (chat completions) | `MOONSHOT_API_KEY` | ⚠ omitted + warning |
| `ollama/*` | Local Ollama | `lib/models/ollamaAdapter.ts` (chat completions) | none | ⚠ omitted + warning |
| *any cloud id whose direct key is absent* | the id's own provider, via a gateway | `lib/models/gatewayAdapter.ts` (chat completions) | `MODEL_GATEWAY` + `MODEL_GATEWAY_API_KEY` | ⚠ omitted + reported |

The xAI adapter carries the deepest capability surface: `grok-4.5`
requests pin `reasoning.effort: "medium"` (`lib/config.ts`), SSE
streaming works end-to-end (`runConfig: { streamingMode: 'sse' }` —
partial delta events stream, one aggregated event persists with usage),
structured outputs ride `outputSchema` → `text.format`, and two
xAI-only tools — `x_search` and `collections_search` (§3) — turn on
live X search and hosted-document RAG. All verified live on grok-4.5.

**Moonshot AI (Kimi).** `kimi-*` ids route to `KimiAdapter`
(`lib/models/kimiAdapter.ts`, on the chat-completions base), against `https://api.moonshot.ai/v1`
(`MOONSHOT_BASE_URL` for a proxy). Get a key at platform.moonshot.ai; the
`.cn` console serves mainland China. The family (USD per 1M tokens, October
2026): `kimi-k3`, the flagship — 2.8T-parameter open-weight MoE, 1M context,
vision, always-on thinking, $3 in / $0.30 cache hit / $15 out; `kimi-k2.6`,
the cheaper general tier (256K, vision, thinking switchable, $0.95 / $4);
`kimi-k2.7-code` and `kimi-k2.7-code-highspeed` (256K, coding, thinking
cannot be turned off; the highspeed variant streams at ~180 tokens/s for
twice the price). There is no small or "flash" K3. On price, K3 is a mid-tier
closed model, not a bargain: Claude Sonnet 4.6's rate, and Claude Sonnet 5.5
($2 / $10) undercuts it per token while leading it on the coding boards;
thinking is always on and billed as output, which is why the adapter pins
effort below Moonshot's `max`. Choose K3 for the strongest open weights
(self-hostable) and the flat-rate 1M context; choose `kimi-k2.6` for cost;
or serve K3 through `MODEL_GATEWAY` (OpenRouter's endpoints run from about
$0.88 to $3.45 per 1M input, the cheap ones quantized). What works: tool calling
and delegation, strict `json_schema` structured output (K3 and K2.7 Code
document it; K2.6 is unstable on `$ref`/`oneOf`), SSE streaming, images as
base64 (Moonshot takes no public image URLs), MCP tools (they are function
tools to the model), `reasoning_content` surfaced as THINKING. Reasoning:
K3 takes a top-level `reasoning_effort` (`low` | `high` | `max`); the adapter
pins `DEFAULT_KIMI_REASONING_EFFORT` (`high`, `lib/config.ts`) unless the
agent's `reasoning:` says otherwise (`medium` is sent as `high`, which K3
has in its place), and maps `none` to `low` because K3 cannot stop
thinking. K2.x models take a `thinking: { type }` switch instead:
`reasoning: none` sends `disabled`, and any effort value is dropped from
the body. What does
not: native `web_search` (dropped with a warning; `web_extract` works, and
Moonshot's standalone `POST /v1/tools/search`, billed per call, could back
a client-side tool), and thinking carried across a tool loop (Moonshot asks
for K3's `reasoning_content` back on the assistant message; this adapter
keeps scratchpads out of history, so K3 re-reasons each step). K3's open
weights mean the same id is served by OpenRouter, Together, Fireworks and
Vercel AI Gateway; with no direct key, `MODEL_GATEWAY` maps it to
`moonshotai/kimi-k3`. The row in the capability matrix is asserted against
the request body the adapter sends; one plain turn was verified live on
2026-10-03 (`npm run demo:models`, kimi-k3 at low effort, 17.9 s), tool
loops and search were not.

**Which keys do I need?** `npm run doctor` (the `melchizedek-doctor` bin)
reads every syndicate YAML, resolves each agent's model under your `.env`,
and prints one table — agent, model, provider, which declared server-side
tools that path runs natively (✓) or drops (✗), and whether the path is
funded — with one verdict per syndicate and the variables that would
unlock the most. Read-only; no key value is ever printed. Every
starter-pack file opens with a `# tier:` header (`keyless`, one provider
such as `gemini`, or `multi-provider`) the doctor checks against the
models. `GOOGLE_GENAI_API_KEY` alone runs fourteen of the nineteen examples.

**One key instead of several — the gateway fallback.** Direct adapters
are canonical: the native features above exist only on a provider's own
endpoint. But with `MODEL_GATEWAY=vercel` (or `openrouter`) and
`MODEL_GATEWAY_API_KEY` set, any cloud model id whose direct key is
*absent* is served through that gateway's OpenAI-compatible endpoint
(`lib/models/gateway.ts` owns the rule). A present provider key always
wins for its own ids, Ollama never routes through a gateway, and adding a
direct key later restores that provider's native search with no YAML
change. Through the gateway every server-side sentinel (`web_search`,
`google_search`, `x_search`, `collections_search`) is dropped — the doctor
and the startup log say so per agent, and the span records
`llm.transport = gateway:<id>` and `llm.capability.dropped` while
`llm.provider` keeps the upstream attribution. Tool calling, structured
output, `reasoning_effort` and streaming work unchanged. Optional dials:
`MODEL_GATEWAY_BASE_URL` (a self-hosted proxy speaking the same dialect),
`MODEL_GATEWAY_MODEL_MAP` (`from=to,…` wire-name overrides; the mapper
already turns `claude-sonnet-4-6` into `anthropic/claude-sonnet-4.6`). The
A2A `X-API-Key` never selects the gateway — the gateway key is server
environment only.

**Cloud platforms and proxies (ADR 0023).** The model id picks the provider;
`<PROVIDER>_PLATFORM` picks how it is reached. Keys in the environment against
the vendor's public API stay the default.

| Path | Set | Credential |
|---|---|---|
| Gemini on Vertex AI | `GEMINI_PLATFORM=vertex` (or genai's `GOOGLE_GENAI_USE_VERTEXAI=true`), `GOOGLE_CLOUD_PROJECT`, `GOOGLE_CLOUD_LOCATION` | Google Application Default Credentials |
| Claude on Bedrock | `ANTHROPIC_PLATFORM=bedrock`, `AWS_REGION` | the AWS credential chain; needs `@anthropic-ai/bedrock-sdk` |
| Claude on Vertex AI | `ANTHROPIC_PLATFORM=vertex`, `ANTHROPIC_VERTEX_PROJECT_ID` (or `GOOGLE_CLOUD_PROJECT`), `CLOUD_ML_REGION` | Google ADC; needs `@anthropic-ai/vertex-sdk` |
| GPT on Azure OpenAI | `OPENAI_PLATFORM=azure`, `AZURE_OPENAI_ENDPOINT` | `AZURE_OPENAI_API_KEY`, else Entra ID through `@azure/identity` |
| A proxy in front of Anthropic or OpenAI | `ANTHROPIC_BASE_URL` / `OPENAI_BASE_URL` | the provider's key |

`ANTHROPIC_MODEL_MAP`, `OPENAI_MODEL_MAP` and `GEMINI_MODEL_MAP` (JSON, YAML id
→ platform id) translate ids a platform names differently: a Bedrock inference
profile, a Vertex AI version suffix, an Azure deployment name. Unlisted ids pass
through. The A2A `credentials` plug point may return, per request, an API key
or a partial endpoint (`baseURL`, `apiKey`, a `token` source, `project`,
`location`, `region`, `models`) merged over the environment's. Memory
extraction and embeddings follow the Gemini platform, so a Vertex AI
deployment needs no AI Studio key.

Native web search is not sent on Bedrock, Claude-on-Vertex or Azure (Gemini
grounding is kept on Vertex AI); the capability report, the startup log and
the doctor say so per agent. `npm run doctor` prints one `endpoint` line per
configured platform with its credential source and anything missing. These
paths are tested against mocked SDK clients and have **not** been run against
the live clouds from this repository.

`lib/models/registry.ts` is the single routing seam: `resolveAdapter`
turns the YAML's model string into its provider's adapter, and
`logProviderStatuses()` reports which providers have a key
(Ollama needs none) and, given a log function, logs a line per provider;
it registers nothing. Missing keys produce clear skip messages, and only
the providers a syndicate actually declares are required.
Mixed graphs are supported — each agent picks its own provider, one
line each. `config/agents/examples/claude.yaml` is the minimal Claude example;
`config/agents/examples/model_zoo.yaml` declares one lightweight agent per
provider, and `npm run demo:models` proves the whole surface: one
prompt to every available provider, printing input, thinking (qwen3
`<think>` blocks, Claude extended thinking, GPT reasoning summaries,
Grok reasoning, Kimi reasoning_content), output, and a per-request token/latency trace; add
`-- --search` to watch four native web searches plus the local
omission. Providers without keys are skipped, never fatal. Each agent
runs as a one-agent syndicate through `runSyndicateTurn`.

Reasoning/thinking: scratchpads from every provider are surfaced as
dimmed THINKING output and kept out of session history. On Claude, any
`reasoning:` other than `none` (or the older
`generateContentConfig.thinkingConfig.thinkingBudget`) enables Anthropic
extended thinking, tools included: the signed thinking blocks ride on the
response's parts as `providerState` and are replayed verbatim within the
turn's tool loop (ADR 0046). GPT's reasoning ids (o-series, `gpt-5*`) and
`grok-4.5`, `grok-4.6` and `grok-4.7` do the same with their encrypted
reasoning items.
Their requests send `store: false`, so the vendor keeps no copy of the
response (ADR 0050).

The engine's own model contract is `lib/models/contract.ts` (ADR 0048),
importable as `melchizedek-agents/models/contract`. It defines the message
format, request, response stream and adapter interface of the native
runtime (ADR 0045), with no `@google/*` in its import graph, and every
provider's adapter implements it. `wiki/models/model-contract.md` gives
each field's purpose and its mapping onto every provider's wire. The
native loop calls the adapters directly, charging each call against
`max_steps`, passing the turn's abort signal and opening the
`llm.request` span (ADR 0053).
Gemini's adapter is `GeminiAdapter`
(`melchizedek-agents/models/geminiAdapter`, on `@google/genai`)
([ADR 0100](./wiki/decisions/0100-gemini-row-asserted-on-the-engine-adapter.md)).
`resolveAdapter(modelId, { apiKey, keyProvider, endpoint, gemini })` in
`melchizedek-agents/models/registry` returns any id's contract adapter
from the prefix table, with the gateway rule, BYOK scoping and endpoints;
`resolveModel` returns the same `ModelAdapter` for a BYOK path (ADR 0060).
Every Gemini id gets `GeminiAdapter`: `GEMINI_ADAPTER=engine` (or
`gemini: 'engine'`) changes nothing, and `adk` throws, naming 1.0.0.
`resolveAdapterWithFallback` wraps an agent's model and `fallback_model`
in a `FallbackAdapter`.

`melchizedek-agents/model` is the model layer on its own (ADR 0068): the
contract's types,
`ClaudeAdapter`, `GptAdapter`, `GrokAdapter`, `KimiAdapter`,
`OllamaAdapter`, `GatewayAdapter`, `GeminiAdapter`, the
`ChatCompletionsAdapter` base, `resolveAdapter`,
`resolveAdapterWithFallback`, `FallbackAdapter` and the circuit breaker's
helpers. A project that only calls models imports from there. Its
`resolveAdapter` gives a Gemini id `GeminiAdapter`; `resolveModel` is not
in it.

Every model request also emits an `llm.request` OpenTelemetry span
(provider, model, input/output/thinking tokens, latency). Scripts print it
as an `[OTEL_SPAN_JSON]` line; `melchizedek-chat` and the `syndicate:*`
scripts keep those lines off unless `OTEL_CONSOLE_SPANS=true`. Set
`TELEMETRY_SUPABASE=true` to persist
spans to the `adk_telemetry` table (run `db/telemetry.sql`, then
re-run `db/hardening.sql` — schema below):

`db/telemetry.sql` (idempotent) creates three tables: `adk_turns` — one
row per turn with input, output, the responding agent, the plan-dispatch
route, errors, tokens, model-vs-tool latency, the tool calls with their
responses, the ids that join it to `adk_sessions` (`session_id`,
`invocation_id`), provenance (`config_hash`, `engine_version`) and a
full-text `search` column; `adk_telemetry` — one row per `llm.request` /
root span; and `adk_payloads` — full prompts and responses per model call,
kept by policy (`TELEMETRY_PAYLOADS=off|errors|sample|all`,
`TELEMETRY_PAYLOAD_SAMPLE`, `TELEMETRY_PAYLOAD_TTL_DAYS`) and expired by
`melchizedek_prune_telemetry()`. A row from a failed call's `llm.request`
span holds the request in the model contract's shape (`model`, `system`,
`messages`, `tools`, …), whichever adapter made the call. The native loop
opens `agent.invoke <name>`, `model.call` and `tool.execute <name>` spans;
a clean call's row comes from `model.call` and holds the request and the
adapter's response in the contract's shapes. Rows written before 1.0.0
under ADK's `invoke_agent`, `call_llm` and `execute_tool` spans hold ADK's
request, and the ledger still reads them (ADR 0076). The view `adk_turns_production` excludes
eval and classifier turns. Operate it with `npm run telemetry:stats`,
`telemetry:prune` and `telemetry:replay` (the exporter spools failed
batches to `outputs/telemetry-deadletter.ndjson`).

**Open-weight local models**: `ollama/*` ids (e.g. `ollama/qwen3:8b`)
route through `lib/models/ollamaAdapter.ts` to a local Ollama daemon over
its OpenAI-compatible API (`OLLAMA_BASE_URL`, default
`http://localhost:11434/v1`). No key is required, and a syndicate whose
*every* agent is `ollama/*` runs with no `.env` at all —
`config/agents/examples/tutor.yaml` (single agent), `council.yaml` (council)
and `assistant.yaml` (conversation, summaries, a task list, background jobs)
are the worked examples. The adapter translates the contract's messages to
OpenAI-style messages, including tool calls (so delegation works),
image parts as data URIs (so `ollama/qwen3-vl:8b` can see), and JSON
response mode; reasoning models' `<think>…</think>` scratchpads are
stripped from replies. Choose models by capability: qwen3:8b is the
smallest pulled model with reliable tool calling; qwen3-vl:8b adds
vision.

Model floor: agent transfer (subagent delegation) requires
`gemini-3.8-flash` or newer — older flash models reject it with
`[400] Tool call context circulation is not enabled`. For `ollama/*`
agents the equivalent floor is tool-calling support in the model
itself; delegation runs through ordinary function calls to the subagent tools.

## 6. A2A service mode

`npm run start:a2a -- <file>.yaml` (package: `npx melchizedek-serve
<file>.yaml`) serves a syndicate as an A2A 1.0 agent that also accepts A2A
0.3 clients (most platforms still speak 0.3; a request without an
`A2A-Version` header is treated as 0.3, per the spec): an agent card listing
both versions' endpoints, JSON-RPC and REST transports, and the task
lifecycle. In your own Express
app, mount `(await createA2AApp(options)).app` instead — same server, same
options. `demo/a2a_demo.mjs` is a complete client.

#### Routes

| Route | Auth | Purpose |
|---|---|---|
| `GET /healthz` | none | liveness — always 200 while the process runs |
| `GET /readyz` | none | readiness — 503 while draining for shutdown |
| `GET /metrics` | `A2A_METRICS_TOKEN` | Prometheus text: tasks by agent, outcome and caller; model calls; tokens by kind; task duration; tasks in flight. Absent unless the token is set |
| `GET /.well-known/agent-card.json` | bearer | the default syndicate's card |
| `POST /a2a/jsonrpc`, `/a2a/rest` | bearer | the default syndicate |
| `GET /<agentId>/.well-known/agent-card.json` | bearer | another syndicate's card; its URLs point at `/<agentId>/a2a/...` |
| `POST /<agentId>/a2a/jsonrpc`, `/<agentId>/a2a/rest` | bearer | another syndicate (`A2A_SERVED_AGENTS` restricts which) |
| `DELETE /memory` | bearer | erase everything stored for the calling scope: facts, sessions (with subagent rows), ledger rows, A2A tasks and the third-party tokens held for its tools, including conversations whose sessions have expired, with per-store counts; `?all=1` covers every memory namespace |

"bearer" means the credential `A2A_AUTH` asks for (below); with no
`A2A_SERVER_SECRET` and no authenticator the server binds `127.0.0.1` only.
In BYOK mode every task route also needs `X-API-Key`. The card declares
what is required in `securitySchemes`.

#### Who the caller is, and whose data it is

`A2A_AUTH` picks a built-in authenticator (`lib/a2a/identity.ts`, export
`melchizedek-agents/a2a/identity`), and the authenticator decides the
scope key every session and memory is stored under:

- **`secret`** (default): every caller presents `A2A_SERVER_SECRET`, and
  the calling backend names its end user in `X-User-Id`.
- **`callers`**: one bearer token per calling backend. `A2A_CALLERS` lists
  `name:sha256[:scope]` entries separated by `;`, so the configuration holds
  only token hashes. A caller owns its scope (its name, unless one is given),
  and an `X-User-Id` it sends nests beneath it. The scope does not depend on
  any model key. Mint a caller with
  `npx melchizedek-serve --new-caller <name> [--scope <scope>] [--token-file <path>]`.
  While `A2A_SERVER_SECRET` is still set it keeps working beside the tokens,
  with its old scoping, so callers move over one at a time.
- **`jwt`**: a JWT from your identity provider: `A2A_JWT_JWKS_URL` (or an
  HS256 `A2A_JWT_SECRET`), with `A2A_JWT_ISSUER` and `A2A_JWT_AUDIENCE`
  required and `exp` checked. The scope is the `sub` claim
  (`A2A_JWT_SCOPE_CLAIM`), under `A2A_JWT_TENANT_CLAIM` when set.
  `X-User-Id` is ignored: the token is the user.
- **`header`**: a gateway in front authenticates users and names them in
  `A2A_TRUSTED_USER_HEADER`. Requires `A2A_SERVER_SECRET`, which only the
  gateway may hold, so no other client can set the header.

In code, spread an authenticator into the factory:
`createA2AApp({ ...callerTokens(parseCallers(spec)), keyMode: 'byok', … })`,
or pass your own `resolveRequest`.

#### Budgets, the task record, and the ledger

- **Budgets** (`A2A_BUDGETS`, option `policy: budgets(config)`): daily limits
  per UTC day on tasks, model calls and tokens, per caller (`perCaller`, with
  overrides by name in `callers`) and per scope (`perScope`, one end user).
  Example: `{"perCaller":{"tokens":5000000},"callers":{"reports":{"tasks":100}},"perScope":{"tasks":50}}`.
  A task over budget ends `rejected` with the reason, before it takes a slot.
  The counts live in the `melchizedek_usage` table (`db/migrations/0004_usage.sql`)
  when Postgres or Supabase is configured, else in process memory. A store
  that cannot be read refuses the task.
- **One record per task** (option `onTaskEnd`): task id, trace id, agent,
  caller, a hash of the scope, status, reason, duration, model calls and
  tokens. The trace id is the one the turn's spans and its ledger row carry,
  and the audit trail's `task.end` row names both ids, so one id joins the
  log, the ledger, the audit trail and your tracing backend. A request
  carrying a W3C `traceparent` header is linked, not joined: the turn's root
  span links to the caller's span and records `caller.trace_id`, and the
  record carries `callerTraceId`. The turn keeps a trace id of its own, since
  ledger attribution and erasure key on it and a caller must not choose it.
  `A2A_LOG_FORMAT=json` prints every server line as JSON, this record included.
- **The audit trail** (`melchizedek_audit`, `db/migrations/0012_audit_log.sql`;
  option `audit`, supplied by `postgresStorage`): one row per failed
  authentication (`auth.failure`), task outcome (`task.end`), erasure
  (`memory.erase`) and tool credential stored, refreshed, revoked or erased
  (`credential.put`, `.refresh`, `.revoke`, `.erase`, naming the provider and
  app, never a token), with the caller's name, the source address, the agent and
  task ids, and a hash of the scope. Never a scope key and never conversation
  content. A trigger refuses UPDATE and DELETE; rows leave only through
  `SELECT melchizedek_prune_audit(<days>)`, which you schedule (pg_cron, or a
  job) for the retention your evidence needs, since the source address is
  personal data. A failed write is logged once and each event is printed to
  stderr as JSON until writes recover. A database owner can still alter the
  table; ship the rows to a store you do not administer when the evidence must
  survive that.
- **Rate limit**: with an authenticator it counts per caller (an operator's
  backend) or per scope (an end user); under the shared secret, per IP.
- **The telemetry ledger is redacted before it is written**:
  `TELEMETRY_REDACT=secret` (default) removes key-shaped credentials; add
  `email`, `phone`, `card` (Luhn-checked) or `ssn`, or plug in your own with
  `setTelemetryRedactor(fn)`. Sessions and memory are not redacted; use
  `DELETE /memory` there.

#### Where your data goes

What a deployment sends where, how long it is kept, and the setting that
changes it. "Your Postgres" is the database `DATABASE_URL` (or Supabase)
names; nothing is kept by the framework anywhere else.

| Data | Goes to | Kept | Change it with |
|---|---|---|---|
| The prompt: the user's message, the conversation, tool results | The model provider of each agent that runs (the model-id prefix) | The provider's policy | The `model:` lines in the YAML; `ollama/` ids stay on your machine |
| Tool calls (`web_search`, `web_extract`, OpenAPI, MCP) | The tool's own host | That host's policy | The agent's `tools:`, `openapi:`, `mcp_server_url` / `mcp_tools` |
| Sessions (conversation history) | Your Postgres, `adk_sessions` | 7 days after the last message | `ttlDays` (`postgresStorage`) |
| Long-term memory facts | Your Postgres, `adk_memory_facts`; **the transcript is also sent to the extraction and embedding providers, Gemini by default whatever the agents run on** (the server warns at boot when they differ) | Until erased, or `memory_retention_days` | `MEMORY_EXTRACTION_MODEL`, `MEMORY_EMBEDDING_PROVIDER`, `memory_retention_days` |
| The ledger: each turn's input, output and tool results (key-shaped secrets redacted) | Your Postgres, `adk_turns`, `adk_telemetry` | **Until you prune it**: schedule `melchizedek_prune_telemetry(<days>)` | `TELEMETRY_REDACT`, the prune's `turn_days` |
| Sampled full model requests | Your Postgres, `adk_payloads` | 30 days | `TELEMETRY_PAYLOADS`, `TELEMETRY_PAYLOAD_TTL_DAYS` |
| Traces, when `OTEL_EXPORTER_OTLP_ENDPOINT` is set | Your OTLP collector, conversation content included with key-shaped secrets redacted (`off` drops it) | Your collector's policy | `OTEL_EXPORT_CONTENT` (`redacted`, `off`, `raw`) |
| Third-party OAuth tokens held for tools, per end user (when `postgresStorage({ credentials })` is used) | Your Postgres, `melchizedek_tool_credentials`, sealed with AES-256-GCM under `MELCHIZEDEK_CREDENTIAL_KEY`, which never reaches the database (migration 0013) | Until revoked or erased | The provider config; the key |
| The audit trail (no content) | Your Postgres, `melchizedek_audit` | Until `melchizedek_prune_audit(<days>)` | The prune schedule |
| The task record (no content) | stdout | Your log platform's policy | `A2A_LOG_FORMAT` |

`DELETE /memory` erases a user from every Postgres store above except the
audit trail, which holds no content, only a hash of the scope. It does not
reach a provider's own retention: read each provider's data terms, and the
business associate or data processing agreement you need with it, before
sending it regulated data.

#### Who pays

`A2A_KEY_MODE` (option `keyMode`), whatever the authenticator:

- **`server`** (default): the server's own provider keys pay for every
  model call (or your `credentials` plug point supplies a key per request).
- **`byok`**: the caller's `X-API-Key` funds agents on the provider named
  by `X-Provider`; agents on other providers, tools and memory extraction
  still run on the server's keys. Under `A2A_AUTH=secret` only, the key's
  hash also scopes the data (`a2a-<hash>`, with `X-User-Id` beneath it).
  That was the only behaviour before 0.16. A deployment holding data from
  then keeps reaching it with `byok`, or by moving to `A2A_AUTH=callers`
  with each caller's scope set to its existing `a2a-<hash>` silo.

#### Headers

| Header | Meaning |
|---|---|
| `Authorization: Bearer <token>` | the server secret, this caller's token, or a JWT, per `A2A_AUTH` |
| `X-User-Id` | the end user this request is for (`[A-Za-z0-9._-]{1,64}`); sessions and memory are stored under it (under a caller token, beneath the caller's scope; ignored with a JWT). Authenticate your users before sending it. |
| `X-API-Key` | BYOK mode only: the caller's model key (see above) |
| `X-Provider` | BYOK mode only: which provider `X-API-Key` belongs to (default `google`) |
| `X-Surface`, `X-Surface-Guild`, `-Channel`, `-User` | optional, telemetry only |

#### Sessions

`message.contextId` names the conversation — it goes **inside** `message`.
Calls with the same value continue one session; a `contextId` beside
`message` is ignored and every call starts fresh. Sessions are durable with
Supabase and expire seven days after the last turn (a nightly prune from
`db/migrations/0001_base.sql` deletes them). A syndicate declaring `memory_system: internal-only` keeps its
transcripts in process memory even when Supabase is configured.

#### Tasks, streaming, cancel

(Method names below are 0.3's; 1.0 clients use `SendMessage`,
`GetTask`, `SendStreamingMessage`, `CancelTask` and the 1.0 enum spellings.)
`message/send` blocks until the turn finishes unless the request sets
`configuration.blocking: false`; then poll `tasks/get`. `message/stream`
emits `[STATUS]` progress updates (tool calls, the chosen route, guard
notes) and the answer as the final status message. With
`A2A_STREAM_TEXT=true` (`streamText` in code) it also streams the answer as
the model writes it, as chunks of an artifact named `answer`: the first
chunk opens it, later chunks append, text the agent wrote before calling a
tool is withdrawn (an empty replacement), and the artifact is closed
(`lastChunk`) with the text the user actually receives, which the final
status message repeats. A syndicate with `guards:` never streams, because a
guard reads the whole answer before any of it leaves; the dispatch
classifier never streams either. One conversation runs one turn at a time:
a second message on a busy `contextId` waits for the first turn (up to
`A2A_TURN_LOCK_WAIT_MS`, default 30 s) and is then `rejected` with "still
running". The lock is in-process by default and a Postgres advisory lock
with `DATABASE_URL`, so it holds across instances. `tasks/cancel` stops a running task, including the model call
in flight, and the task ends `canceled`. Final states: `completed`,
`failed` (the message names the stage and the provider's reason),
`canceled`, `rejected` (a file part, an empty message, or the server at
capacity). Message parts may be `text` or `data` (sent to the model as
JSON); `file` parts are refused.

#### Approval gates (`require_approval`)

A skill script run (`skills.scripts: local`) pauses the same way, without being listed: every `run_skill_script` call waits for the person's answer.

A tool can run only after a person approves the exact call
([ADR 0028](./wiki/decisions/0028-approval-gates.md)). The agent lists it:

```yaml
orchestrator:
  name: Desk
  tools: [send_email]
  require_approval: [send_email]   # names from this agent's own tools
```

When the model calls it, nothing runs: the task ends `input-required`, final.
Its status message says what is waiting ("Desk wants to run
send_email({...})") and carries a data part
`{ type: 'approval_request', approval_id, agent, tool, args }`. Answer on the
same conversation (same `contextId`; the same `taskId` works too) with the text
`approve` or `reject`, or a data part
`{ "approval": { "id": "<approval_id>", "approved": true } }`. Approved, the
call runs with the arguments shown; rejected, the model is told and answers
without it. A message that is not an answer gets the same request back,
without a model call. The paused call and its arguments are pinned, so an
approval cannot run a different call.

Gates are allowed on the orchestrator, on the subagents of a plan-dispatch
syndicate, on the agent nodes of a workflow (§6), and on a delegated
subagent, at any depth of nested delegate syndicates
([ADR 0110](./wiki/decisions/0110-pauses-inside-delegated-subagents-reach-the-turn.md)).
A delegated subagent's gate pauses the whole turn: the call that reached it
stays open, the request carries `path` (the agents from the turn's own down
to the one that asked, e.g. `["Desk", "Mailer"]`, in the data part and in
`approval.path`), and the decision goes back down to that subagent, which
runs or refuses the call and finishes before its caller continues. A gate
inside a nested workflow or nested dispatch syndicate is still a load error,
as are skill scripts on a delegated subagent. Only function tools from the registry can be gated, not MCP tools
or native-search sentinels. In code, `runSyndicateTurn` returns
`status: 'input-required'` with `approval`, and the next turn's part
`approvalResponsePart(approval.id, approved)` answers it.

#### Questions (`ask_user`)

An agent can ask the person something mid-turn and wait for the answer
(`lib/runtime/questions.ts`, [ADR 0031](./wiki/decisions/0031-ask-user.md)).
It lists the tool:

```yaml
orchestrator:
  name: Desk
  tools: [ask_user]   # ask_user(question, options?)
```

When the model calls `ask_user`, the turn ends `input-required`, final. The
status message is the question ("Desk asks: Which account? (personal /
work)") with a data part
`{ type: 'input_request', interrupt_id, node, message, payload }`, where
`payload.options` lists the choices when the agent gave some. The caller's
next message on the same conversation is the answer: its text becomes the
call's result, and the agent resumes its own tool loop where it asked. A
workflow's `ask_user` node (§6, Workflows) publishes the same data part and
is answered the same way, so a client handles both alike.

`ask_user` is allowed where an approval gate is: the orchestrator, the
subagents of a plan-dispatch syndicate (a dispatch turn that answers goes
straight back to the route that asked, without the classifier), and a
delegated subagent, whose question carries `path` and whose answer goes back
down to it (ADR 0110). A workflow node listing it is a load error. In code,
`runSyndicateTurn` returns `status: 'input-required'` with `input`
(`node`, `message`, `payload`, and `path` for a delegated subagent's
question), and the next message's text answers it.

#### OAuth consent for tools

A tool that acts for the person against a third-party API reads their
delegated token with `ctx.accessToken(provider)` from the sealed credential
store ([ADR 0072](./wiki/decisions/0072-tool-credentials-sealed-per-user.md)).
When they have not granted the provider yet, the turn pauses for their
consent ([ADR 0085](./wiki/decisions/0085-oauth-consent-pauses-on-adks-credential-request.md)):

```ts
import { createA2AApp } from 'melchizedek-agents/a2a';
import { oauthConsent } from 'melchizedek-agents/tools/oauthConsent';

const consent = oauthConsent({
  providers: {
    github: {
      authorizationUrl: 'https://github.com/login/oauth/authorize',
      tokenUrl: 'https://github.com/login/oauth/access_token',
      clientId: process.env.GITHUB_CLIENT_ID!,
      clientSecret: process.env.GITHUB_CLIENT_SECRET,
      scopes: ['repo'],
    },
  },
  redirectUri: 'https://agents.example.com/oauth/callback', // as registered at the provider
  credentials: store, // storage.credentials, or credentialStore(...)
});
await createA2AApp({ /* … */ toolCredentials: { store, consent } });
```

1. **The pause.** The task ends `input-required` with the link in its status
   message and a data part `{ type: 'consent_request', consent_id, agent,
   provider, authorization_url, state, scopes }`.
2. **The grant.** The person opens the link and consents. The provider
   redirects their browser to the callback, which the server mounts at the
   redirect URI's path. The callback exchanges the code with PKCE and stores
   the grant, sealed.
3. **The resume.** Their next message on the conversation runs the paused
   call again. A message sent before the grant gets the same request back,
   without a model call.

The callback refuses these, and stores nothing:

- a state that is replayed, tampered with or older than ten minutes;
- a provider's `error`;
- a caller who is authenticated as another user.

No token, code, client secret or verifier is written to a page, an event, a
log line or the model's context. The pending flows live in the process: run
one replica, or route the callback to the instance that paused the call. In
code, `runSyndicateTurn({ …, toolCredentials })` returns
`status: 'input-required'` with `consent`.

#### Limits

| Setting | Default |
|---|---|
| `A2A_RATE_LIMIT_MAX` per `A2A_RATE_LIMIT_WINDOW_MS`, per client IP (POSTs) | 60 per 15 min |
| `A2A_AUTH_FAILURE_MAX` failed logins per IP per 15 min, then blocked | 30 |
| `A2A_TASK_TIMEOUT_MS` per task | 15 min |
| `A2A_MAX_CONCURRENT_TASKS` | unlimited |
| `A2A_MAX_CONCURRENT_PER_SCOPE`: tasks at once for one end user | 4 |
| `A2A_MAX_CONCURRENT_PER_CALLER`: tasks at once for one caller | unlimited |
| `max_steps` (YAML): model calls per turn, subagents included | 50 |
| `A2A_TRUST_PROXY`: proxies in front (required with `PUBLIC_URL`) | none trusted |
| `A2A_BODY_LIMIT` | 1 MB |
| `A2A_SHUTDOWN_GRACE_MS`: SIGTERM waits for running tasks | 25 s |
| `A2A_SHUTDOWN_DELAY_MS`: of that, `/readyz` fails while requests are still served | 5 s |

The rate limit and the failed-login limit count in the process by default,
so each replica keeps its own window. With `A2A_REDIS_URL` set (and the
optional `redis` package installed) both count in Redis, one window across
every replica; in code, pass `limitStore` with
`redisRateLimitStore({ command })` from `melchizedek-agents/a2a/limits`, which
takes any client's raw-command function (node-redis `sendCommand`, ioredis
`call`). Budgets need no Redis: they are Postgres counters.

#### What is per-process

The per-agent config cache (a config change needs a restart), the
rate-limit counters and the concurrency count always live in the process. Tasks do too unless `DATABASE_URL` is set: then
Postgres holds sessions, memory, A2A tasks and budget counters, and several
replicas are safe behind one load balancer (rate limits and the concurrency
cap then apply per replica, unless `A2A_REDIS_URL` shares the rate limits).
With Postgres, a running task is leased to the
instance running it (renewed every 20 s; `taskLeaseMs`, default 60 s): if
that instance dies, another marks the task `failed` ("the server running
this task stopped") instead of a client polling it forever, and one turn
runs at a time per conversation across replicas. With Supabase only, or no
store, run one replica.

#### Posture at boot

Without `A2A_SERVER_SECRET` the server binds `127.0.0.1` only; binding
another `HOST` requires the secret or `ALLOW_UNAUTHENTICATED=true`. With
`PUBLIC_URL` set it refuses to start without the secret, with the
`.env.example` placeholder as the secret, or against an unhardened
database (unless `ALLOW_UNHARDENED_DB=true`), and until the deployment
states its posture: `A2A_AUTH` (prefer `callers` or `jwt`; `secret` lets any
holder of the secret act as any user), `A2A_SERVED_AGENTS` (a list, or `*`
for every agent) and `A2A_TRUST_PROXY` (the number of proxies in front, or
`false`). The refusal names each one missing. With durable storage it reads
`melchizedek_schema_version` and refuses to start on a database behind the
migrations it ships, naming `melchizedek-db apply` (or
`ALLOW_SCHEMA_MISMATCH=true` to start anyway); a database ahead of it only
warns, so a rolling deploy can migrate first. Storage through supabase-js
(Supabase credentials without `DATABASE_URL`) logs a deprecation notice:
set `DATABASE_URL` to the database's Postgres connection string.
Conversation content is not printed to stdout unless
`OTEL_CONSOLE_SPANS=true`.

#### Calling remote agents

A subagent with `a2a_agent_url: https://other-team.example/billing` is a
REMOTE agent, speaking A2A 1.0 or 0.3 (the card decides): the orchestrator
delegates to it as to a local subagent (one `request` argument), and in
plan-dispatch it can be a route. Its card and
endpoint pass the SSRF guard (`ALLOW_PRIVATE_A2A=true` for local hosts);
credentials come from `A2A_AGENT_TOKENS`, a JSON map of host → bearer
token or host → headers, sent only over https (or to loopback). The same
local conversation keeps talking to the same remote conversation.

#### Deploying

`Dockerfile` builds the compiled server and runs it as a non-root user with
a health check; `compose.yaml` adds optional Ollama and Phoenix (traces).
`npx melchizedek-db print|apply|status` installs and checks the database.
Set `PUBLIC_URL`, `A2A_SERVER_SECRET`, `A2A_AUTH`, `A2A_SERVED_AGENTS`,
`A2A_TRUST_PROXY` and the provider keys from your secret manager; give the orchestrator's stop timeout at least
`A2A_SHUTDOWN_GRACE_MS`. On SIGTERM the server first fails `/readyz` and
keeps serving for `A2A_SHUTDOWN_DELAY_MS` so the load balancer deregisters
it, then closes the listener and drains running tasks for the rest of the
grace period; point the readiness probe at `/readyz`, which also fails while
durable storage does not answer. `MELCHIZEDEK_DOTENV=off` makes every bin
ignore `.env` files and run on its environment alone.

#### Backups

Everything durable is in the one Postgres you point the server at:
conversations (`adk_sessions`, `adk_session_events`), long-term memory
(`adk_memory_facts`), the telemetry ledger, the agent registry and its
versions, A2A tasks, the task tools' lists and the budget counters. The
engine takes no backups of it; back it up as you would any production
database, with your provider's scheduled backups or point-in-time recovery
(RDS and Cloud SQL automated backups; on Supabase, a paid plan, since the
Free plan has none).

What a backup protects is the history. The rest can be rebuilt: the schema
with `npx melchizedek-db apply`, and registry agents by republishing their
YAML files. Without a backup, lost conversations, memory and ledger rows
stay lost.

A logical backup works on any provider and is worth having beside its
snapshots. Use a `pg_dump` at least as new as the server, and the
schema the tables live in (`public`, or `MELCHIZEDEK_DB_SCHEMA`):

```bash
pg_dump --schema=public --no-owner --no-privileges -Fc -f melch.dump "$DATABASE_URL"
# restore into a new database that has pgvector:
psql "$TARGET_URL" -c 'CREATE EXTENSION IF NOT EXISTS vector'
pg_restore --no-owner --no-privileges -d "$TARGET_URL" melch.dump
npx melchizedek-db status    # with DATABASE_URL=$TARGET_URL: schema version and counts
```

Test the restore, not just the dump: restore into a scratch database and
compare row counts per table with the source. Two things a backup changes:

- **Erasure.** `DELETE /memory` removes a scope from the live database, not
  from backups taken before it. Keep backup retention as short as your
  recovery needs allow. After a restore, re-run any erasures made since the
  backup was taken. The server logs each one with its scope (`Erasure for
  scope …`); keep those lines for as long as you keep backups, since a
  platform's log retention is usually shorter. The same holds for the
  telemetry dead-letter spool (`outputs/telemetry-deadletter.ndjson`), which
  holds ledger rows only while the database was unreachable: replay it
  (`npm run telemetry:replay`) before honouring an erasure, then delete it.
- **Secrets.** A dump holds every conversation in clear text. Encrypt it at
  rest and give it the same access rules as the database.

#### The agent registry

A file is the default home of a syndicate. The registry is for a definition
an operator changes without a redeploy: `registry:<id>` loads it, and so does
a bare id listed in `A2A_REGISTRY_AGENTS`. It lives in two tables (migration
`0005_agent_registry.sql`):

- `adk_agent_registry` — one row per id, the active definition. The server
  reads only this table.
- `adk_agent_registry_versions` — every definition an id has held, numbered
  per id, with its config hash, author, note and publish time. It is
  append-only: updates and deletes are refused.

The database records a version on every write to the active table, whoever
makes it, so history does not depend on the tool. Writing a definition an id
already held re-activates that version rather than duplicating it, which is
how a rollback works.

```bash
npx melchizedek-registry publish config/agents/desk.yaml desk --note "tighter triage"
npx melchizedek-registry versions desk        # * marks the active version
npx melchizedek-registry diff desk 3          # v3 against the active version
npx melchizedek-registry rollback desk 3 --note "v4 misroutes refunds"
npx melchizedek-registry retire desk --yes    # stop serving; history stays
```

`publish` and `rollback` validate against the same schema the loader uses
before anything is written. The author recorded is
`MELCHIZEDEK_REGISTRY_AUTHOR`, else the local user name; a direct write
records the database role. `registry:<id>@<version>` loads one stored
version (as the boot syndicate or from code), so a version can be tried
before it is activated; the HTTP routes accept only active ids. A running
server caches each agent for its lifetime: **restart it after a publish or
a rollback.** The library is `melchizedek-agents/registry`.

A syndicate is versioned as a unit. `publish` reads every nested
`yaml_reference` the definition reaches (nested ones of nested ones too) from
the agents root, validates each, and stores them with it under
`bundled_references`; the server loads nested syndicates of that version from
the bundle, never from files that may have changed since. Change a nested file
and the parent changes only when it is published again. `--no-bundle` stores
the references bare, to resolve from files at run time; a version published
before bundling existed behaves that way too.

### Plan-dispatch routing (`dispatch:`) — the second orchestration method

A syndicate that declares a `dispatch:` block stops delegating and
starts **dispatching**. The two methods differ in who speaks to the
user:

| | DELEGATE (default) | PLAN-DISPATCH (`dispatch:` present) |
|---|---|---|
| Subagents are | tools on the orchestrator | plain configs the server selects from |
| Orchestrator holds | subagent tools, no `outputSchema` | an `outputSchema`, no subagent tools |
| Routing decision is | implicit in which tool it calls | an explicit value in code |
| The final answer comes from | the orchestrator re-emitting the answer | **the specialist itself** |
| LLM calls per request | classify + specialist + relay | classify + specialist |

```yaml
dispatch:
  default_route: "Generalist"          # fail-static target; must be a declared subagent

orchestrator:
  name: "Triage"
  model: "gemini-3.5-flash-lite"
  instruction: |
    Name exactly ONE specialist for this message. ...
  outputSchema:                        # the router's schema; dispatch gives it no subagent tools
    type: "OBJECT"
    properties:
      route:  { type: "STRING", description: "Exact specialist name" }
      reason: { type: "STRING", description: "≤8 plain words for the waiting user" }
    required: ["route"]
  generateContentConfig:
    responseMimeType: "application/json"
```

**Why it exists.** In DELEGATE mode the orchestrator receives the
specialist's answer as a tool response and must re-emit it to close the
turn. That relay is a full LLM call whose only job is copying text it is
forbidden to edit, and it is the least reliable step in the chain — in
production it has finished with zero output tokens (a blank reply) and
emitted the bare tool name in place of a 2,599-character answer.
Plan-dispatch has no relay turn to fail, and the classifier's output
shrinks from a whole relayed answer to ~15 tokens of JSON.

**Why the classifier is tool-less.** An agent that holds an
`outputSchema` ends its turn on that JSON. The router's JSON names a
route for code to run, so the router holds no subagent tools, and the
hand-off happens in code, where it can be logged, traced, and streamed
to the user as progress. This is a choice of method, not a limit of the
engine: an orchestrator may hold an `outputSchema` beside its subagents,
delegate, and answer in the schema itself
([ADR 0109](./wiki/decisions/0109-structured-output-beside-tools.md));
under ADK, before 1.0.0, an orchestrator holding both deadlocked (see
`config/agents/examples/critic.yaml`'s header). Choose plan-dispatch when
the answer is the specialist's, and a schema on the orchestrator when the
answer is its own structured judgment of what its team returned.

**Sessions.** Every *route* runs in the shared `<contextId>` session, so
one transcript accumulates across routes and long-term memory ingests
real answers instead of a relay copy of them. Sharing the session is
necessary but not sufficient: a stored event is rendered by comparing
`event.author` against the agent now running (the rule ADK had, which the
engine's loop keeps), and under plan-dispatch
every route is its own root agent, so the whole history fails that
comparison and `convertForeignEvent` rewrites it to `role: "user"`
prefixed "For context:". A route reading the raw shared session
therefore receives the thread as one undifferentiated user monologue —
with the previous route's private `thought:` reasoning cloned in as user
speech and raw tool payloads inlined beside it. Routes read the session
through `ProjectedSessionService` (`lib/session/transcript.ts`) instead:
past agent turns are re-authored to the running agent so they survive as
real `role: "model"` turns, labelled `[XScout]` when another desk spoke,
with thoughts and tool traffic dropped. Writes still land on the real
session, which keeps everything.

Both ceilings on that projection are bounds the prompt cannot escape:
40,000 characters of history AND 16 turns, whichever binds first. The turn
cap is not redundant — a thread of short exchanges fits 43 turns inside the
character budget, and 43 turns of history to answer one question is
attention cost no byte budget describes.

The stored row is trimmed on the way out, by `trimEventForStorage`. It has
exactly two readers and neither touches Gemini's opaque `thoughtSignature`
blobs or tool-result payloads: the projection drops thought parts and tool
traffic before any prompt, and the memory service's `serializeEvents` walks
`part.text` alone. Measured across 128 live sessions those two fields were
~90% of every byte stored (`thoughtSignature` alone 73.3%), so they are
stripped from the SERIALIZED COPY — the live in-memory session keeps them,
or the agent's own tool loop breaks mid-turn. An elided tool result keeps
its `id` and `name` and gains a size marker, because the loop pairs
calls to responses by id and a widowed half breaks the history. 21.72 MB → 4.88 MB; existing
rows shrink retroactively on their next write. Note the constraint this
rests on: dropping the signature is safe only because stored events are
never replayed to a model. The quadratic upload is untouched — `append`
still rewrites the whole array per event — and is the next lever if row size
returns.

The classifier does not write to that session — its JSON verdicts would
be read as conversation by the next specialist — but it must still SEE
it, or it cannot tell a follow-up from a standalone remark. It runs in a
per-request in-memory session and receives `renderTranscriptDigest`, a
compact both-sides summary of the exchange, above a
`--- MESSAGE TO CLASSIFY ---` marker. It used to get a durable
`<contextId>::route` lane of its own instead, holding only the user's
messages and its own verdicts; that made every rule about follow-ups and
redos unusable, and left holes wherever a `route_overrides` hit skipped
the classifier entirely.

**Fail-static.** Malformed JSON, an unknown route name, an empty
payload, or a classifier that errors outright all resolve to
`default_route` and still answer the user — routing is an optimisation,
answering is the contract. `default_route` must therefore name a
specialist that can handle anything. The whole resolver is pure; the
contract lives in `lib/dispatch.ts`.

**Telemetry.** The chosen route is published as a
`[STATUS] Routed to <Name> — <reason>` progress event before the
specialist runs, so an A2A client can show a waiting user what is
happening. The `reason` field is written for that reader, not for logs.

Implemented in `runSyndicateTurn`, so every surface honours it: the A2A
server, the CLI runner (`scripts/syndicate_chat.ts`), the worker and the
evals.

### Workflows (`workflow:`) — the third orchestration method

A syndicate that declares a `workflow:` block is a **graph**. Its agents
are the nodes; `edges` says what runs after what, and on which route;
nothing delegates and nothing classifies. It is for the shape the other
two methods cannot express: run these two at once, join what they
produce, edit it, ask the person, then publish.

```yaml
workflow:
  edges:
    - [START, Planner, { article: [Writer, Checker], default: Answerer }]
    - [[Writer, Checker], Both, Editor, Confirm, Publisher]
  nodes:
    Planner: { route_key: "kind" }                 # an agent: modifiers only
    Both:    { join: true }                        # waits for every predecessor
    Editor:  { retry: { max_attempts: 2 } }
    Confirm: { ask_user: "Publish this draft? Reply yes, or say what to change." }
```

**Edges.** Each entry is a chain. `START` opens at least one chain. A
name is an agent or a declared node; a list of names fans out (after one
node) or fans in (before one node); a map `{ <route>: <node or nodes>,
default: <node> }` ends a chain and routes on the output of the node
before it — the `route_key` property of a JSON output (an agent with an
`outputSchema`), else the trimmed text — with `default` catching what no
key matched. Every node receives the previous node's output as its
message; a join hands on `{ <predecessor>: <output>, … }`.

**Nodes.** `workflow.nodes` declares the nodes that are not agents, each
exactly one kind: `join: true`; `map: <Agent>` (runs the agent once per
item of a list input, concurrently, `max_parallel` at a time, and outputs
the list of results); `tool: <registry name>` (runs the tool with the
node input as its arguments); `ask_user: "<question>"` (below). An entry
named after an agent carries modifiers only: `route_key`, `retry`
(`max_attempts`, `initial_delay`, `max_delay`, `backoff_factor`, in
seconds; `jitter`, the backoff's randomness, 0 for none; `exceptions`,
the error names to retry on, every error when absent) and `timeout`
(seconds), which any node but a `map` may carry. A map's items run under
the mapped agent's own `retry` and `timeout`, so a `map` entry refuses
both and the load error names the agent's entry instead.

**The pause.** An `ask_user` node ends the turn `input-required`
(`result.input`: the node, the question, and what it was asked about).
The next message on the conversation is the answer: the node's output
becomes `{ "reply": <the answer>, "input": <what it received> }` and the
graph resumes where it waited. `melchizedek-chat` prints the question
and takes the next line; the A2A server ends the task `input-required`
with a data part `{ type: 'input_request', interrupt_id, node, message,
payload, schema }`, and the client's next message on the same
conversation resumes it. A later message after the graph has finished
starts it again from `START`.

**What a node sees.** Unless its YAML sets `includeContents`, a node
agent sees only its input — not the conversation, not the other nodes —
which is what makes a graph legible: each agent's input is one value a
person can read in the trace. Every node runs in the shared session, so
`memory_system: long-term` would ingest node inputs as user turns;
`internal-only` is the sensible default for a workflow.

**Failure.** A node's error is not the turn's: a node with `retry` tries
again (the attempt is recorded in `answer.nodeErrors`), and a node that
gives up fails the turn with `NODE_FAILED` naming it. `max_steps` and
the deadline cap the whole graph as they cap any turn.

**Approval gates.** A tool in a node agent's `require_approval` pauses
that node, and the graph with it: the turn ends `input-required` with
`result.approval`, as any approval does, and the next message, the
person's decision, resumes the node's own run, which runs or refuses the
pinned call once and walks on. Any other message repeats the request and
runs nothing. Skill scripts (`skills.scripts: local`) on a node agent
pause the same way, each `run_skill_script` call waiting for its approval,
with the minimal script environment of ADR 0086. The schema refuses a gate or skill scripts on an agent a `map`
node runs.

**Nested.** A `yaml_reference` to a workflow syndicate runs the whole
graph, under the entry's name and description, wherever it appears: as a
DELEGATE subagent its last output is the tool's answer; as a plan-dispatch
route it is the turn's answer, and the conversation keeps the message and
that answer; as a node of another workflow it is the node's output. The
graph's events are kept in the entry's own session, as for any subagent.
A nested workflow may not have an `ask_user` node (a pause inside it
cannot reach the caller); it is refused by name, as is a `map` over one.

**Not yet.** Remote `a2a_agent_url` subagents are refused inside a
workflow by the schema. An `ask_user` tool on a node agent is refused
too: use an `ask_user` node. The records are [ADR 0030](./wiki/decisions/0030-workflow-graphs.md),
[ADR 0098](./wiki/decisions/0098-workflow-subagent-and-node-approvals.md) and
[ADR 0106](./wiki/decisions/0106-nested-workflow-routes-nodes-and-node-skill-scripts.md);
the turn is `lib/workflow/turn.ts`, on the engine's own scheduler
([ADR 0095](./wiki/decisions/0095-native-workflow-turn-drains-through-the-adk-reader.md)),
and `lib/workflow.ts` holds the `workflow:` block's contract. A conversation paused inside an agent node on anything
but an approval, or inside a map item, fails the next turn with
`RESUME_UNSUPPORTED`.

## 7. Extending the framework

**Call a model directly (no syndicate)**: the YAML layer is a convenience,
never a requirement. `scripts/direct_call.ts` (`npm run demo:direct`) is
the canonical minimal block on the engine's model contract:
`resolveAdapter(modelId)` from `melchizedek-agents/model`, then
`adapter.generate({ model, system, messages, stream })`, reading partial
and final responses. The id's prefix picks the provider (`gemini-*`,
`claude-*`, `gpt-*`, `grok-*`, `kimi-*`, `ollama/*`), the key comes from
the environment. A turn
with tools, sessions and telemetry is `runSyndicateTurn`.

**Add a syndicate**: create `config/agents/<name>.yaml` — copy the
closest starter-pack file from `config/agents/examples/` or start from
`syndicateSchema.yaml` — then `npm run chat:syndicate -- --syndicate
<name>`. No code changes. The loader checks the root first, then
`examples/`, so your syndicate and the starter pack never collide.

**Add a tool**: write a `defineTool` contract in `lib/tools/` (name,
description, zod schema, execute), register the name in
`lib/toolRegistry.ts` (or call `registerTool` from your own code),
reference it from YAML. The native loop runs the contract as it is; see
`wiki/tools/tool-contracts.md`. The two image tools are the worked
examples — including why binary data forces function tools over
subagents, and how a tool signature can enforce an epistemic rule (the
blind inventory).

**Add a provider**: follow `claudeAdapter.ts` (SDK-based, key-gated, a
`ModelAdapter` on the engine's model contract) or, for a chat-completions
API, `ollamaAdapter.ts` (fetch-based, keyless: a `ChatCompletionsAdapter`
subclass), and register it behind a model-id prefix.

**Point an agent at an MCP server**: set `mcp_server_url:` on a
subagent. `scripts/demo_mcp_server.ts` is a complete server to copy —
tool definitions, SSE wiring, and persistent state in ~250 lines.

**Teach your coding agent the framework**: `skills/` holds six Agent
Skills (the open SKILL.md standard — a directory per skill, `name` and
`description` frontmatter) that give Claude Code, Codex, Cursor,
OpenCode or Gemini CLI the catalog of syndicates and the procedures in
this document: `melchizedek` (find and run, delegate a task),
`melchizedek-author`, `melchizedek-serve`, `melchizedek-memory`,
`melchizedek-models`, `melchizedek-scribe`. `npx melchizedek-skills
install` copies them into `.claude/skills/` and `.agents/skills/` of the
current project (`--for claude,codex,cursor,opencode,gemini,agents,all`,
`--global`, `--dir <path>`, `--only <names>`, `--force`, `--dry-run`;
`npm run skills:install` in a clone). The installer (`lib/skills.ts`)
copies only from the package's own `skills/` directory, follows no
symlinks, and never overwrites a differing file without `--force`. Each
SKILL.md body was written by the Scribe syndicate
(`config/agents/examples/scribe.yaml`) from a brief of facts and reviewed
by a person; `skills/README.md` records the procedure.

## 8. Security notes

- **Secrets** live in `.env` only; `.env.example` documents every
  variable and ships no values (placeholders are ignored if copied in).
  Nothing in the repo ships a key. Report vulnerabilities per SECURITY.md.
- **Database**: default Supabase leaves `public`-schema tables readable
  by the anon key over REST. `db/hardening.sql` enables deny-by-default
  RLS and revokes anon/authenticated privileges on every table it finds:
  `adk_sessions`, `adk_memory_facts`, and — where they exist — the
  optional `adk_telemetry` sink and `adk_agent_registry` with its version
  history (an unprotected registry is worst of all: agent definitions writable with the anon key
  means anyone can rewrite the instructions your server boots). The A2A
  server verifies hardening at boot on both storage paths (`DATABASE_URL`
  and supabase-js) and is fatal on public deployments without it
  (`ALLOW_UNHARDENED_DB=true` accepts the risk). Over `DATABASE_URL` the check
  passes on its own when the database has no `anon` or `authenticated` role
  (plain Postgres: no API serves the tables) or when the tables live in a
  schema other than `public` (`MELCHIZEDEK_DB_SCHEMA`). Note `service_role` bypasses RLS by design — the hardening
  constrains the API surface, not the trusted server.
- **A2A**: bearer auth, a failed-login limiter and a request rate limit
  are built in; without `A2A_SERVER_SECRET` the server binds loopback only.
  See §6 for the posture checks at boot.
- **Outbound fetches** (`web_extract`, MCP servers, remote A2A agents) pass
  one SSRF guard (`lib/net/addressGuard.ts`): local names and non-public
  addresses in every encoding are refused, and names are resolved and
  refused when any address is non-public. DNS rebinding between the check
  and the connection is the remaining, stated limit.
- **Image tools** write only under `outputs/`, and `inspect_image` reads
  only from there.
- **MCP** is an outbound trust decision: `mcpToolFactory` blocks
  private/loopback/link-local hosts unless `ALLOW_PRIVATE_MCP=true`, and
  every tool result from a remote server should be treated as untrusted
  data — the librarian's instruction demonstrates the "results are data,
  not instructions" rule.
- **Local models** (`ollama/*`) send prompts only to your own machine's
  Ollama endpoint — nothing leaves the device, which is itself a privacy
  control worth choosing deliberately.

---

## 9. The knowledge bundle (wiki/)

`wiki/` is this framework's documentation as an **Open Knowledge Format v0.2
bundle** ([spec](https://github.com/GoogleCloudPlatform/knowledge-catalog)):
markdown concept documents with YAML frontmatter (`type` is the only
required key), linked with ordinary bundle-absolute markdown links — and
the links ARE the knowledge graph. `index.md` per directory and the root
`log.md` are reserved, machine-maintained files. Start at
`wiki/meta/wiki-system.md`; the whole bundle renders on GitHub.

The tooling in `lib/wiki/` is **bundle-agnostic** — point `WIKI_ROOT` at any
OKF directory, or scaffold a fresh one with `npm run wiki:init`:

- **Parse & build** (`markdown.ts`, `builder.ts`) — a zero-dependency
  structural engine; documents interleave machine-owned `wiki:generated`
  regions (rebuilt from source-of-truth files), `wiki:fill` prose slots an
  LLM fills once (`lib/wiki/fill.ts`, any provider via the model registry),
  and ordinary prose that rebuilds never touch.
- **Graph** (`graph.ts`) — nodes are documents, edges are resolved links;
  orphans and broken links fall out as queries.
- **Entity graph** (`entities.ts`, `extract.ts`) — a second layer over the
  same files: agents, tools, models, providers, modules, tables and
  environment variables as typed nodes. Structural relations are DERIVED
  from repo truth on every build (zero-dependency scanners for imports,
  `process.env` reads, DDL and npm scripts) into `.graph/graph.json`;
  judgments that only prose carries are ASSERTED with evidence and an actor
  into `.graph/relations.json`, which the build never rewrites.
- **Lint** (`lint.ts`, `npm run wiki:check`) — OKF conformance, link
  integrity, index coverage, staleness, and the private-subtree closure
  rule; errors gate every write.
- **Navigate & garden** (`lib/tools/wikiTools.ts`) — tool contracts (§3
  pattern) in three tiers: navigation (`wiki_map`, `wiki_search`,
  `wiki_read`, `wiki_links`, `wiki_dive` — a "repo dive" returns an ordered
  reading plan for a task — and `wiki_graph`, which answers the relational
  questions documents cannot: who calls this tool, what needs this key, how
  do these two connect), the gated writes (`wiki_save` — lint-validated,
  path-jailed, auto-updates the directory index and `log.md`; `wiki_relate`
  — one evidenced relation, refusing anything the build derives), and
  agentic composites (`wiki_query`, `wiki_garden` — one-shot agents with
  citations and honest actor attribution in frontmatter provenance).

Serving: syndicate agents declare the navigation/write tools by name
(`config/agents/examples/scriptorium.yaml` works the prose,
`config/agents/examples/cartographers.yaml` the graph — `npm run syndicate:scriptorium`,
`npm run syndicate:cartographers`); outside MCP clients get all ten from
`npm run mcp:wiki` (loopback SSE on `:8933`). Trust is explicit in
frontmatter: `generated.by` records who wrote a document (`human:<id>`,
`process:<id>`, or `<producer>/<model>`), and only a `human:` entry in
`verified` makes it human-reviewed.
