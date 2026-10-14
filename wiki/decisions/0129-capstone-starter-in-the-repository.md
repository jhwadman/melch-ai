---
type: decision
title: "ADR 0129: The capstone starter is a repository example in front of the stock A2A server, with its one tool on an MCP endpoint the starter serves"
description: "The course's capstone starter lives in examples/capstone/, outside the package's files: TypeScript run from a clone, node:http and no dependency. Its backend takes the user from a server-side session and sends it as X-User-Id with the bearer secret, puts the published event information in front of each question, and maps every failure to a fixed sentence. The agent, config/agents/examples/event_assistant.yaml, is keyless on ollama/qwen3.5:9b and reaches its one read-only tool over MCP on the starter's backend (ALLOW_PRIVATE_MCP=true, local only). Placing it in demo/, an OpenAPI tool on loopback, the event facts in the YAML, Express, and qwen3:8b were rejected."
tags:
  - decision
  - agents
  - protocols
status: stable
generated:
  by: claude-code/claude-opus-5-5
  at: 2026-10-13
sources:
  - resource: examples/capstone/server.ts
  - resource: examples/capstone/agent.ts
  - resource: examples/capstone/eval/run.ts
  - resource: config/agents/examples/event_assistant.yaml
  - resource: tests/capstoneStarter.test.ts
---

# ADR 0129: The capstone starter is a repository example in front of the stock A2A server, with its one tool on an MCP endpoint the starter serves

## Context

The lyceumagents.com course makes "Put a syndicate behind your own website" its required integration milestone and asks for a starter application in this repository at a tagged release (course roadmap item A08). The starter must run first against a mock reply, then call the A2A server with a small keyless syndicate that answers from supplied fictional event information and says when information is missing; derive the user on the backend from a session and pass `X-User-Id`; keep every secret on the backend; show a readable failure when the service or a tool is unavailable; and ship an evaluation pack with at least five case types (supported answer, missing evidence, tool failure, conflicting information, attempted boundary violation). A learner runs it from a clean clone.

## Decision

1. **Where it lives: `examples/capstone/`, in the repository and not the package.** It is TypeScript run with the repository's own `node --experimental-strip-types` scripts (`npm run capstone`, `npm run capstone:eval`), type-checked by `tsconfig.json`, and absent from `package.json`'s `files`. `demo/` stays the shipped, zero-build client: Node does not strip types under `node_modules`, so `.ts` there would not run for a package consumer.
2. **The backend has no dependency.** `node:http`, `fetch`, `node:crypto`. A learner's own backend may be any framework; the starter shows only the one function and the boundaries (`askAgent` in `agent.ts`).
3. **Identity comes from a session.** A stand-in login picks one of two fictional test accounts and stores it server-side behind an opaque `HttpOnly`, `SameSite=Strict` cookie. `/api/ask` reads only `question` from the body; the forwarded `X-User-Id` is the session's account id whatever the browser sends. POSTs must be JSON, and a foreign `Origin` is refused.
4. **The backend controls the context.** It puts `fixtures/event-info.md` in front of every question inside `<event_information>` tags and strips that tag from the visitor's text. The YAML names no fact, so swapping the event is a fixture edit.
5. **The tool is MCP, served by the starter.** `get_event_updates` is a read-only tool on `POST /mcp` of the starter's backend: a hand-written Streamable HTTP server with JSON responses, no session and one tool, returning the announcements in `fixtures/event-updates.json` (never the file's note for human readers). The YAML names it with `mcp_server_url`, `mcp_transport: streamable_http` and `mcp_tools`. The A2A server reaches loopback only with `ALLOW_PRIVATE_MCP=true`, which the README marks local-only. `CAPSTONE_TOOL_DOWN=true` turns each call into an error result. Each call is recorded in the trace `/api/ask` returns, beside the server's `[STATUS]` lines.
6. **Failures are fixed sentences.** No service, a refused bearer, a rate limit, an HTTP error, a failed task and a timeout each map to one sentence and an HTTP status (`FAILURE_MESSAGES` in `agent.ts`); the cause goes to the backend's log with the secret and model key replaced by `[redacted]`. A failed tool call keeps the answer and adds a notice.
7. **The model is `ollama/qwen3.5:9b`**, the model `lib/models/ollamaAdapter.ts` recommends for tool calling. Any tool-capable model works by changing the `model:` line.
8. **The evaluation pack is data plus a runner.** `eval/cases.json` holds seven cases; each check is either code-checked (status, a regular expression, the tool's status in the trace, the secrets' absence from the raw response, the forwarded id, a claimed outage with no failed call) or judged by a named person, and states its failure outcome (`block` exits 1, `route to a person` lists it). Mock mode skips the checks that depend on the model.

## Alternatives rejected

- **`demo/capstone/`.** It would ship in the npm package as TypeScript a consumer cannot run from `node_modules`, or force the starter into untyped `.mjs` that `tsc` does not check.
- **An OpenAPI tool on the starter's loopback address.** The OpenAPI compile refuses a loopback server unless `ALLOW_PRIVATE_OPENAPI=true`, so a shipped example would fail to load in every surface and test that compiles the starter pack; each example spec is also pinned against a recorded ADK parse that can no longer be recorded. MCP connects at run time and fails soft (no tools, a warning) when the server is down. MCP is also the tool boundary the course's capstone lesson names.
- **The event facts in the YAML instruction.** Self-contained in the terminal, but the agent would hold the data, the lesson's point about the application deciding what enters the context would be lost, and swapping the event would mean editing a prompt.
- **Express.** Already a dependency here, but a learner copying the starter would inherit it for four routes.
- **`ollama/qwen3:8b`**, the Tutor's model. In three authoring runs it answered two or three of seven cases without calling the tool, giving a superseded room, claiming an outage with no call, and once describing an announcement that does not exist; two instruction rewrites did not change that. `qwen3.5:9b` called the tool on every event question in every later run.

## Consequences

- The capstone is pinned by a repository tag, not a package version; the course links the tag.
- `tests/capstoneStarter.test.ts` holds the backend to the boundaries above and runs the whole chain through `createA2AApp` on a scripted model, against the real MCP client.
- The doctor and the onboarding guide count one more keyless example.
- Memory beyond the session (a remembered preference and its deletion) is the learner's extension: it needs a `long-term` syndicate and a database, which the starter does not require.
