---
type: decision
title: "ADR 0125: Syndicates served as MCP tools through the A2A executor"
description: "melchizedek-mcp serves each loaded syndicate as one MCP tool ({ message, session_id? }) plus melch_resume for a paused turn, over stdio and Streamable HTTP. Each tool call is one task through the A2A SyndicateExecutor, so budgets, caps, the turn lock, the approval read, deadlines, cancel, guards and the ledger are A2A's. Approvals are answered only by melch_resume's explicit approve. HTTP binds loopback by default and refuses a wider bind without a 32-character secret. A second turn path, one tool per agent, a single ask tool, stateless HTTP, and an opt-out for unauthenticated public binds were rejected."
tags:
  - decision
  - protocols
  - mcp
status: stable
generated:
  by: claude-code/claude-opus-5-5
  at: 2026-10-09
sources:
  - resource: lib/mcp/server.ts
  - resource: scripts/mcp_server.ts
  - resource: lib/a2a/executor.ts
  - resource: tests/mcpServer.test.ts
---

# ADR 0125: Syndicates served as MCP tools through the A2A executor

## Context

A person working in Claude Code or Codex wants to ask a syndicate from inside the session, without standing up an A2A client. Both agents speak MCP, over stdio for a local server and Streamable HTTP for a remote one. The engine already serves tool contracts over MCP (`serveContracts`, [MCP](/protocols/mcp.md)), but those are plain tools: a syndicate turn has sessions, pauses for a person (approvals, [ADR 0028](/decisions/0028-approval-gates.md); `ask_user`; OAuth consent, [ADR 0085](/decisions/0085-oauth-consent-pauses-on-adks-credential-request.md)) with resume semantics that reach into delegated subagents, dispatch routes and workflow nodes ([ADR 0110](/decisions/0110-pauses-inside-delegated-subagents-reach-the-turn.md), [ADR 0111](/decisions/0111-pauses-inside-nested-syndicates.md), [ADR 0119](/decisions/0119-workflow-routes-and-nodes-pause-the-turn.md), [ADR 0120](/decisions/0120-nested-dispatch-syndicates-route-as-at-the-top.md)), and spends money under budgets and caps the A2A server enforces.

## Decision

1. **One tool per syndicate, one resume tool.** Each loaded syndicate is a tool named after its file id (`[A-Za-z0-9_-]`, at most 64), described by its orchestrator's `description`, with input `{ message, session_id? }`. The result is the answer text and a line carrying the `session_id`; `structuredContent` carries `session_id`, `status`, the pause (`waiting_for`) and, for a syndicate that declares an output schema or JSON mode, the parsed answer (`output`). An omitted `session_id` starts a fresh conversation. `melch_resume { session_id, approve?, answer? }` answers a pause.
2. **Every call is one task through `SyndicateExecutor`.** `lib/mcp/server.ts` builds the executor's collaborators as `createA2AApp` does (sessions per `memory_system`, a namespaced memory service, the shared `TaskLimiter` and turn lock, the model resolver) and hands it a request context and a collecting event bus. The executor runs `runSyndicateTurn` ([ADR 0024](/decisions/0024-adk-behind-the-runtime-seam.md)), so budgets, the concurrency caps, one turn per conversation, the approval read from the stored events, the deadline, guards, the ledger, the task record, the audit event and memory ingestion are A2A's by construction. MCP's `notifications/cancelled` aborts the request's signal, which calls the executor's `cancelTask`.
3. **Approvals only through `melch_resume`.** While this process knows a session waits on an approval, the syndicate's own tool returns the pending request again without running a turn, whatever the message says; `melch_resume` sends the data part `{ approval: { id, approved } }` naming that request, and requires a boolean `approve`. A question requires `answer`; a consent resumes with `continue`. The server approves nothing itself. A session this process has not seen (a restart on durable storage) is continued through the syndicate's tool, where the executor repeats a waiting approval.
4. **stdio by default, Streamable HTTP on request.** The bin sends every console line to stderr before anything loads, so stdout carries only the protocol. `--http` serves stateful Streamable HTTP at `/mcp` (stateful so a cancellation reaches the request it names), bound to `127.0.0.1` with a loopback Host-header check against DNS rebinding. A bind beyond loopback refuses to start without `MCP_SERVER_SECRET` of 32 characters or more (`mcpBindProblem`); every request then passes a constant-time bearer check behind a failed-auth limiter, and all requests a per-IP rate limit (240 a minute, as `serveContracts`). An MCP session is bound to the scope that opened it; open sessions are capped and idle ones closed.

## Alternatives considered

- **Call `runSyndicateTurn` directly from the MCP handler.** Shorter, but it would re-implement the approval read, the limiter, the turn lock, the policy and the task record beside the executor: the drift [ADR 0024](/decisions/0024-adk-behind-the-runtime-seam.md) ended for turn semantics would return one layer up. Driving the executor through a collecting bus costs a cast and keeps one implementation.
- **One tool per agent in a syndicate.** It would let the caller bypass the orchestrator and the syndicate's routing, and expose tools no YAML author meant as entry points. The syndicate is the unit of exposure on A2A too.
- **A single `ask { syndicate, message }` tool.** One schema, but the calling model would choose among syndicates from an enum without descriptions; a tool per syndicate gives each its own description, which is what steers the caller.
- **Stateless Streamable HTTP.** Simpler and replica-friendly, but a `notifications/cancelled` arrives on a separate request that a stateless server cannot match to the running call. Conversations stay durable across instances through `DATABASE_URL`; only the MCP session is per process.
- **`ALLOW_UNAUTHENTICATED` as on the A2A server.** An MCP tool here spends model money on every call and is reached by autonomous clients; there is no unauthenticated public use worth an opt-out.
- **Approve with a message, as A2A accepts the text `approve`.** The calling model writes the message, so a turn could be approved by the same model that asked for the gated call. An explicit boolean on a separate tool is visible in the MCP client's own permission prompt.

## Consequences

- `melchizedek-mcp` is a new bin and `melchizedek-agents/mcp` a new export path (`createMcpServer`, `serveMcpStdio`, `mcpHttpApp`, `mcpBindProblem`), recorded under Unreleased in the CHANGELOG.
- The executor's log lines are the MCP server's too: task ids by prefix, tool names, counts. The MCP layer logs tool names and session-id prefixes, never a message, an answer or a key.
- stdio serves no OAuth consent callback; `--http` mounts it when `OAUTH_REDIRECT_URI` is set.
- What a process remembers of a session's pause is per process and bounded (10,000 sessions); the stored events stay the source of truth for the executor.
