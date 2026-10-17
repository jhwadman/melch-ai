---
type: subsystem
title: Script orchestration
description: "The `script:` block: a syndicate's orchestration as one JavaScript module, run in the engine's sandbox, calling its agents, its allowed tools and the person as functions; every call journaled in the conversation, a paused run resumed by replaying the journal on the source it pinned."
tags:
  - orchestration
  - workflow
status: stable
generated:
  by: claude-code/claude-opus-5-5
  at: 2026-10-17
sources:
  - resource: lib/script/run.ts
  - resource: lib/script/journal.ts
  - resource: lib/script/config.ts
  - resource: lib/runtime/syndicateTurn.ts
  - resource: lib/syndicateSchema.ts
  - resource: tests/scriptOrchestration.test.ts
---

# Script orchestration

A syndicate orchestrates in one of four ways: DELEGATE (subagents as tools), plan-dispatch (`dispatch:`, a classifier names one route), a workflow graph (`workflow:`), or a script (`script:`). The first three decide the order agents run in; a script also holds the logic between them. It is one JavaScript module in the YAML, run in the engine's [sandbox](/tools/run-code.md), so a routing rule, a model chosen per call or a question to the person changes with a deploy of the file, not an engine release ([ADR 0137](/decisions/0137-script-orchestration-and-sandboxed-code.md)).

```yaml
script:
  models: ["gemini-3.8-flash", "claude-opus-5-5"]
  tools: ["web_extract"]
  source: |
    export default async ({ message, transcript, agent, askUser, log }) => {
      const triage = await agent("Triage", message);
      log(`Routed to ${triage.route}`);
      return agent(triage.route, null, { conversation: true });
    };
```

The YAML still declares the agents with their instructions, tools, guards and schemas. The orchestrator is an agent the script may call like any other; nothing delegates.

## What the script gets

The default export is called with:

- `message`, `transcript` and `variables`: the turn's message text, the classifier's digest of the conversation before it (`renderTranscriptDigest`), and the YAML's `variables` as the loader bound them. `{{token}}` interpolation never touches `script.source`.
- `agent(name, input, opts?)` runs a declared agent on `input` (text, or JSON sent as its text; `null` sends the message) and returns its parsed JSON when the agent has an output schema, else its text. A failed run throws into the script, which may catch it: fail-static is the script's to write. `opts.model` (one of `script.models`), `opts.reasoning` and `opts.temperature` change the call's agent, compiled once per turn per combination. By default the call runs on a throwaway lane and sees only its input, as a workflow node does; `opts.conversation: true` runs it as a dispatch route runs, in the conversation through the projection, its exchange stored there and its reply streamed.
- `tool(name, args)` runs a registry tool listed in `script.tools`, the only path from a script to the network or the host.
- `askUser(id, question, { payload?, schema? })` pauses the turn (below) and returns `{ reply, input }` when it resumes.
- `parallel(thunks, { max? })` runs calls concurrently (default 4 at once, at most 32) and returns their results in call order.
- `now()` and `random()`, journaled so a replay sees the same values; `Date` and `Math.random` throw.
- `log(text)`, one `[STATUS]` progress line.

The return value is the answer, text or JSON, and the syndicate's `guards` run on it once with every tool result the script's agent calls produced.

## The journal and the pause

Every `agent`, `tool`, `askUser`, `now` and `random` call is one journal event: authored by the syndicate's name, `nodeInfo.path` `<name>.<seq>`, the call (run id, sequence, kind, name, argument hash) in `actions.agentState.script_call`, its result in `event.output`, and no content parts. Those fields survive the Supabase store's trimming, and with no text the journal stays out of the transcript digest and long-term memory. Only a paused run needs its journal, so it is stored with the pause; a run that finishes stores none, and the conversation keeps the exchange, as a dispatch turn does (every Supabase append rewrites the session's events). A resumed run that ends stores its answer and an `end` marker.

A live `askUser` lets the calls already in flight finish and be journaled, then writes ADK's input request (`adk_request_input`), so the turn ends `input-required` with the same `result.input` an `ask_user` node produces, and every surface that answers a workflow question answers this one. The pause pins the run's source, message and transcript. The next message runs the pinned source again from the top: each call is answered from the journal (matched on kind, name and argument hash), the open question takes the message as its reply, and the calls after it run live. A redeploy never breaks a waiting conversation; a new conversation gets the deployed script. A resume that does not make the calls its journal holds fails `SCRIPT_DIVERGED`. So a script keeps one rule: the same calls, with the same arguments, on every run.

## Limits and refusals

A script turn runs under the turn's `max_steps`, deadline and cancel; replayed calls are not charged again; a run past 1,000 calls fails `SCRIPT_CALL_LIMIT`, and the sandbox's own compute is held to its CPU budget. `script.source` is at most 64 KB. It needs `MELCHIZEDEK_CODE_SANDBOX=on`. The schema refuses `script` beside `dispatch` or `workflow`; on its agents, `require_approval`, the `ask_user` tool, local skill scripts and authorization_code grants (a pause inside a called agent cannot be replayed in this version), `context:`, and a root `max_concurrency`; and `code_execution: gemini` on an agent `script.models` could move off Gemini. A `yaml_reference` to a script syndicate is refused by name.

## In use

The deployment's Discord routers, `financial_router` and `archimedes`, are scripts: deterministic regex overrides, then the classifier reading the transcript digest, a fail-static default route, and the route answering in the conversation, with the `Routed to <route> — <reason>` progress line the Penguin's route trace parses.
