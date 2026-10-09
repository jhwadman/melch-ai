---
type: protocol
title: MCP server (melchizedek-mcp)
description: Syndicates served as MCP tools to Claude Code, Codex and any MCP client — one tool per syndicate, melch_resume for pauses, stdio and Streamable HTTP, every call one task through the A2A executor.
tags:
  - mcp
  - protocols
generated:
  by: claude-code/claude-opus-5-5
  at: 2026-10-09
sources:
  - resource: lib/mcp/server.ts
  - resource: scripts/mcp_server.ts
  - resource: lib/a2a/executor.ts
  - resource: tests/mcpServer.test.ts
---

# MCP server (melchizedek-mcp)

`melchizedek-mcp` (`scripts/mcp_server.ts`, `npm run mcp:serve`) serves syndicates to MCP clients: Claude Code, Codex, a custom connector. The logic lives in `lib/mcp/server.ts`, exported as `melchizedek-agents/mcp`; the bin reads flags and the environment and hands over ([ADR 0125](/decisions/0125-syndicates-as-mcp-tools.md)). The other MCP direction, agents reaching MCP servers and the contract servers, is [MCP](/protocols/mcp.md).

## The tools

- **One per syndicate.** The name is the file id with anything outside `[A-Za-z0-9_-]` turned to `_` (`research_desk.yaml` is `research_desk`); the description is the orchestrator's `description` (else "Ask the <syndicate_name> syndicate."), cut at 1,000 characters, followed by how sessions and pauses work. Input: `{ message, session_id? }`. A message is at most 100,000 characters; a `session_id` matches `[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}`.
- **`melch_resume { session_id, approve?, answer? }`** answers a paused turn. The name is reserved: a syndicate file of that name is refused at startup, as are two files that would share a tool name.

Which syndicates load: `--syndicate <id>` (repeatable, positional ids too; a named id also finds the shipped `examples/` and `templates/`), else every YAML at the agents directory's root (`--agents-dir`, `MELCHIZEDEK_AGENTS_DIR`, `<cwd>/config/agents`). A file the operator's OAuth or credential host allowlist refuses ([ADR 0114](/decisions/0114-oauth-tokens-go-only-to-hosts-the-operator-binds.md), [ADR 0122](/decisions/0122-static-credentials-go-only-to-hosts-the-operator-binds.md)) is refused here as on the A2A server: fatal when named, skipped with a warning when discovered.

## Results and sessions

A completed turn returns the answer text, then `[session_id: …]`. `structuredContent` holds `session_id` and `status`, and `output` (the parsed answer) when the orchestrator declares `output.schema`, `output.mime: application/json` or `outputSchema`. No `outputSchema` is declared on the tool, since a pause returns a different shape. An omitted `session_id` is a new random one; passing it back continues the conversation. This process remembers which syndicate each session belongs to (keyed by scope, at most 10,000, oldest dropped): a session id handed to another syndicate's tool is refused.

A failed, canceled or rejected turn is `isError` with the executor's own text (the failure line, "The task was canceled.", the budget or capacity reason).

## Pauses

A turn that stops for a person returns `status: input-required`, `waiting_for` and a text saying what waits and how to answer, with nothing run:

- **approval** (`adk_request_confirmation`): the agent, the path for a call inside a delegated subagent, the tool and its arguments (cut at 600 characters). `melch_resume` with a boolean `approve` sends the data part `{ approval: { id, approved } }` naming that request.
- **input** (`ask_user`): the asking node, the question and its options. `melch_resume` requires `answer`, sent as the next message.
- **consent**: the agent, the provider and the authorization URL. `melch_resume` sends `continue` (or `answer`) once the person has granted access.

While this process knows an approval waits on a session, the syndicate's own tool returns it again without a turn, whatever the message: an approval is answered only by `melch_resume`'s explicit `approve`. The resume runs through the executor, so a pause inside a delegated subagent, a nested syndicate, a dispatch route or a workflow node resumes where it paused ([ADR 0110](/decisions/0110-pauses-inside-delegated-subagents-reach-the-turn.md), [ADR 0111](/decisions/0111-pauses-inside-nested-syndicates.md), [ADR 0119](/decisions/0119-workflow-routes-and-nodes-pause-the-turn.md), [ADR 0120](/decisions/0120-nested-dispatch-syndicates-route-as-at-the-top.md)). A session this process never saw (after a restart on Postgres) is continued through the syndicate's tool, where the executor repeats a waiting approval.

## One task per call

`createMcpServer` builds what `createA2AApp` builds for its executors: sessions per `memory_system` (in process for `internal-only` or without a store), long-term memory namespaced to the syndicate, one `TaskLimiter` (global, per-scope default 4, per-caller), one turn lock, the model resolver (the registry on the server's environment). Each call is a `SyndicateExecutor` task with a fresh task id, its session id as the context id, and a context of `{ scopeKey, caller, surface: mcp }`; the executor's final status is read off a collecting event bus. Budgets, caps, the turn lock, the approval read, the deadline, guards, the ledger, the task record and audit event, and memory ingestion are therefore the [A2A server's](/protocols/a2a.md). Working statuses become MCP progress notifications when the client sent a progress token. MCP's `notifications/cancelled` aborts the handler's signal, which cancels the task; `shutdown(graceMs)` drains as the A2A server does on SIGTERM.

## Transports

- **stdio** (default). The bin redirects `console.log`, `info` and `debug` to stderr before anything loads; stdout carries only the protocol. The caller is `local`, scoped `MCP_USER_ID` (default `default`). No OAuth consent callback is served.
- **Streamable HTTP** (`--http`): `POST`, `GET` and `DELETE /mcp`, stateful (`Mcp-Session-Id`), at `127.0.0.1:4100` unless `--host`/`MCP_HOST` and `--port`/`MCP_PORT` say otherwise. In order: a Host-header check (loopback names on a loopback bind; `MCP_ALLOWED_HOSTS` otherwise), `/healthz`, a per-IP rate limit (`MCP_RATE_LIMIT_PER_MINUTE`, 240), the OAuth consent callback when `OAUTH_REDIRECT_URI` is set, a failed-auth limiter (30 per 15 minutes), the constant-time bearer check against `MCP_SERVER_SECRET`, the JSON body (1 MB). `X-User-Id` (`[A-Za-z0-9._-]{1,64}`) scopes the caller as on A2A; an MCP session is bound to the scope that opened it. At most 256 sessions are open; one idle 30 minutes is closed.

**The bind rule** (`mcpBindProblem`): beyond loopback the server refuses to start without `MCP_SERVER_SECRET`, and with one shorter than 32 characters. There is no opt-out. The bin checks it before loading any syndicate; `mcpHttpApp` throws on it too.

## Environment

Besides the transport variables above, the bin reads what `melchizedek-serve` reads for a turn: `DATABASE_URL` (sessions, memory, turn locks, audit, sealed credentials; the schema version is checked as at A2A boot), `A2A_TASK_TIMEOUT_MS`, `A2A_MAX_CONCURRENT_TASKS`, `A2A_MAX_CONCURRENT_PER_SCOPE`, `A2A_MAX_CONCURRENT_PER_CALLER`, `A2A_TURN_LOCK_WAIT_MS`, `A2A_BUDGETS`, `A2A_SHUTDOWN_GRACE_MS`, and the tool-credential variables (`MELCHIZEDEK_CREDENTIAL_KEY`, `OAUTH_REDIRECT_URI`, `OAUTH_CALLBACK_IDENTITY`, `MELCHIZEDEK_OAUTH_HOSTS`, `MELCHIZEDEK_CREDENTIAL_HOSTS`).

## Client setup

Claude Code: `claude mcp add melch -- npx melchizedek-mcp --syndicate <id>` from the project directory (or `npx -y -p melchizedek-agents melchizedek-mcp` where the package is not installed); `claude mcp add --transport http melch <url>/mcp --header "Authorization: Bearer …"` for a remote server. Codex: an `[mcp_servers.melch]` table in `~/.codex/config.toml` with `command`, `args`, `cwd` and a `tool_timeout_sec` long enough for a turn, or `url` and `bearer_token_env_var`. The exact snippets are in `DOCUMENTATION.md` (MCP server mode) and the `melchizedek-onboard` skill.
