---
type: runbook
title: Setup paths
description: Three ways in — local REPL in five minutes, keyless local models via Ollama, or the A2A HTTP server toward a container deployment — and which keys each one actually needs.
tags:
  - operations
  - setup
generated:
  by: claude-code/claude-fable-5
  at: 2026-07-26
sources:
  - resource: QUICKSTART.md
  - resource: .env.example
  - resource: scripts/a2a_server.ts
  - resource: scripts/db.ts
  - resource: Dockerfile
  - resource: compose.yaml
---

# Setup paths

Prereq everywhere: Node ≥ 22.6 (`--experimental-strip-types` runs the TypeScript directly; the npm package runs compiled JS), `npm install`, and a `.env` — `lib/loadEnv.ts` reads the one in the directory you run from, then the repo's own; real env vars always win, and `.env.example` placeholders (`your_..._here`) are ignored, so copying the template sets nothing.

## Path A — local REPL (~5 min)

A Google AI Studio key (`GOOGLE_GENAI_API_KEY`) is the only requirement for the Gemini-default syndicates. `npm run chat:syndicate` starts the REPL on the default syndicate, and `npm run chat:syndicate -- --syndicate <name>` runs any other (`npx melchizedek-chat --syndicate <name>` from the installed package); most starter-pack syndicates also have an `npm run syndicate:<name>` alias — the catalog with run commands is generated per-team in [/agents/](/agents/).

Not sure which keys the syndicates you want actually need? `npm run doctor` (`npx melchizedek-doctor`) reads every YAML the loader can see, resolves each model under your `.env`, and prints what is ready, what is blocked, and which variable unlocks what — read-only, no key value shown ([provider routing](/models/provider-routing.md)).

## Path A′ — keyless and local

With [Ollama](https://ollama.com) serving `qwen3:8b` (the smallest pulled model with tool calling), syndicates declaring `ollama/*` models — like the [Council](/agents/council.md) — run with **no API key at all**. Other providers activate per key: `ANTHROPIC_API_KEY` for `claude-*`, `OPENAI_API_KEY` for `gpt-*`, `XAI_API_KEY` for `grok-*` ([provider routing](/models/provider-routing.md)); a missing key just logs the provider as disabled.

## Path A″ — one key for every cloud provider

`MODEL_GATEWAY=vercel` (or `openrouter`) with `MODEL_GATEWAY_API_KEY` serves any cloud model id whose direct key is absent through that gateway. It is a fallback: a direct key set beside it always wins for its own provider, so adding `GOOGLE_GENAI_API_KEY` later restores Gemini grounding with no YAML change. Native search is lost on the gateway path and the doctor says so per agent ([ADR 0012](/decisions/0012-direct-adapters-canonical.md)).

## Path B — A2A HTTP server (~15 min)

`npm run start:a2a -- <syndicate>.yaml` (`npx melchizedek-serve <syndicate>.yaml` from the installed package; default `syndicate.yaml`) on `$PORT` (default 4000). The server's own keys pay unless `A2A_KEY_MODE=byok`; `A2A_AUTH` picks how callers authenticate (shared secret, per-caller tokens, JWT or a gateway header, [ADR 0025](/decisions/0025-built-in-authenticators.md)). With no credential configured it binds `127.0.0.1` only, and it refuses to start on a non-loopback `HOST` (unless `ALLOW_UNAUTHENTICATED=true`) or with `PUBLIC_URL` set. With `PUBLIC_URL` it also refuses to start until `A2A_AUTH`, `A2A_SERVED_AGENTS` (a list, or `*`) and `A2A_TRUST_PROXY` are set explicitly ([ADR 0039](/decisions/0039-public-deployments-state-their-posture.md)). A turn makes at most 50 model calls unless its YAML sets `max_steps`, and one end user runs at most 4 tasks at once (`A2A_MAX_CONCURRENT_PER_SCOPE`). The boot log names the URLs, the auth mode and the storage backend — the contract is in [A2A](/protocols/a2a.md).

## Path C — a container (~30 min)

The repository ships a `Dockerfile` (a two-stage build of the compiled server, run as the non-root `node` user, with a `/healthz` health check; the entrypoint is `dist/scripts/a2a_server.js`, so the container's argument is the syndicate file) and a `compose.yaml` (the server with `./config/agents` mounted read-only, plus an optional Ollama under the `local-models` profile and an optional Phoenix trace viewer under `traces`). Configuration is environment only, from `.env`: a server bound to `0.0.0.0` needs `A2A_SERVER_SECRET` (or another `A2A_AUTH` credential), and a public deployment sets `PUBLIC_URL`, which also makes the server refuse a Supabase schema without `db/hardening.sql` (unless `ALLOW_UNHARDENED_DB=true`). Without a container, `npx melchizedek-serve <syndicate>.yaml` runs the same server from the package.

Storage: set `DATABASE_URL` and every durable store — sessions, [memory](/memory/architecture.md), A2A tasks, daily budgets — lives in one Postgres with pgvector (Supabase's connection string works), shared by every instance ([ADR 0021](/decisions/0021-postgres-first-storage.md)). Without it the server uses Supabase over its API when `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are set, with tasks kept per process, else process memory; in both of those cases run one replica. A deployment moving from the Supabase API to `DATABASE_URL` keeps its conversations: the first read of one the Supabase service wrote copies its history into the Postgres adapter's event rows. The per-agent config cache is per process in every mode, so a config change needs a restart of each instance; the rate-limit counters are per process unless `A2A_REDIS_URL` puts them in Redis. One instance opens up to `DATABASE_POOL_MAX` (10) storage connections plus one per running turn for the conversation lock, up to `A2A_TURN_LOCK_POOL_MAX` (20); behind a session-mode pooler such as Supabase's port 5432, keep the sum under its client limit. `npm run db -- apply` (`npx melchizedek-db apply`, through `psql` against `DATABASE_URL`; `print` writes the same SQL for the SQL editor) installs the migrations in `db/migrations/` and then `db/hardening.sql` as one transaction under an advisory lock (a failure rolls the whole install back; two concurrent applies run one after the other), and `npm run db -- status` checks them over the Supabase API. At boot the server checks the hardening on both storage paths (`lib/storage/rlsStatus.ts`): with `PUBLIC_URL` set it refuses to start when an `anon` or `authenticated` role could read `adk_sessions` or `adk_memory_facts` in `public`, unless `ALLOW_UNHARDENED_DB=true`; a database without those roles, or with the tables in a private schema, passes. The tables go in `public` by default; `MELCHIZEDEK_DB_SCHEMA=<name>` (or `apply --schema <name>`) installs them into a private schema a REST layer does not expose, and the server, run with the same value and `DATABASE_URL`, sets its connections' `search_path` to it. Back the database up with your provider's scheduled backups or point-in-time recovery (the engine takes none; Supabase's Free plan has none): the schema and registry agents can be rebuilt from `db/migrations/` and the YAML files, but conversations, memory and the ledger cannot. DOCUMENTATION §6 "Backups" gives a `pg_dump`/`pg_restore` recipe, says to test restores, and notes that a restore brings back scopes erased after the backup was taken. Probes go to `/healthz` (liveness) and `/readyz` (readiness: it fails while durable storage does not answer, without naming the host). SIGTERM first fails `/readyz` and keeps serving for `A2A_SHUTDOWN_DELAY_MS` (default 5 s) so the load balancer deregisters the instance, then closes the listener and drains running tasks for the rest of `A2A_SHUTDOWN_GRACE_MS` (default 25 s in all), so give the orchestrator's stop timeout at least that long ([ADR 0038](/decisions/0038-graceful-stop-readiness-first.md)). `MELCHIZEDEK_DOTENV=off` makes the bins ignore `.env` files.

Model choice guidance and the errors you will actually hit: [failure modes](/operations/failure-modes.md).
