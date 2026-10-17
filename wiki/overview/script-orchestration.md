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
- `tool(name, args)` runs a registry tool listed in `script.tools`, the only path from a script to the network or the host. A tool also in `script.require_approval` waits for a person to approve the exact call: the turn ends `input-required` with `result.approval`; approved, the pinned arguments run; refused, the script gets `{ error }`.
- `askUser(id, question, { payload?, schema? })` pauses the turn (below) and returns `{ reply, input }` when it resumes; with a schema, a JSON reply is parsed and plain text passes as is.
- `parallel(thunks, { max? })` runs calls concurrently (default 4 at once, at most 32) and returns their results in call order.
- `now()` and `random()`, journaled so a replay sees the same values; `Date` and `Math.random` throw.
- `log(text)`, one `[STATUS]` progress line.

Each `agent()` call's events reach `events.onAgentEvent` with the path `[<script>, <agent>]`. A `yaml_reference` agent that is a workflow, dispatch or script syndicate runs as its own walk or turn on a throwaway lane.

The return value is the answer, text or JSON, and the syndicate's `guards` run on it once with every tool result the script's agent calls produced.

## The journal and the pause

Every `agent`, `tool`, `askUser`, `now` and `random` call is one journal event: authored by the syndicate's name, `nodeInfo.path` `<name>.<seq>`, the call (run id, sequence, kind, name, argument hash) in `actions.agentState.script_call`, its result in `event.output`, and no content parts. Those fields survive the Supabase store's trimming, and with no text the journal stays out of the transcript digest and long-term memory. Only a paused run needs its journal, so it is stored with the pause; a run that finishes stores none, and the conversation keeps the exchange, as a dispatch turn does (every Supabase append rewrites the session's events). A resumed run that ends stores its answer and an `end` marker. Under a durable job's store (`runDurableTurn`) each event is stored as its call ends and is a checkpoint boundary, so a worker that stops mid-script resumes from its last call.

A live `askUser` lets the calls already in flight finish and be journaled, then writes ADK's input request (`adk_request_input`), so the turn ends `input-required` with the same `result.input` an `ask_user` node produces, and every surface that answers a workflow question answers this one. The pause pins the run's source, message and transcript. The next message runs the pinned source again from the top: each call is answered from the journal (matched on kind, name and argument hash), the open question takes the message as its reply, and the calls after it run live. A redeploy never breaks a waiting conversation; a new conversation gets the deployed script. A resume that does not make the calls its journal holds fails `SCRIPT_DIVERGED`. So a script keeps one rule: the same calls, with the same arguments, on every run.

## Traces

`script.invoke <name>` spans a run and `script.call <kind>:<name>` each live call, in a trace of their own, with the run id, the call's kind, name, sequence and status, and never an argument or a result; both reach `adk_telemetry`. Each `agent()` call keeps its own turn span, as a dispatch stage does, carrying `script.run` and `script.call.seq`.

## Limits and refusals

A script turn runs under the turn's `max_steps`, deadline and cancel; replayed calls are not charged again; a run past 1,000 calls fails `SCRIPT_CALL_LIMIT`, and the sandbox's own compute is held to its CPU budget. `script.source` is at most 64 KB. It needs `MELCHIZEDEK_CODE_SANDBOX=on`. The schema refuses `script` beside `dispatch` or `workflow`; on its agents, `require_approval`, the `ask_user` tool, local skill scripts and authorization_code grants (a pause inside a called agent cannot be replayed in this version), `context:`, and a root `max_concurrency`; and `code_execution: gemini` on an agent `script.models` could move off Gemini. A pause inside a called agent fails the turn `PAUSE_INSIDE_AGENT`. Every `script.models` pairing is checked before the run starts (`SCRIPT_MODEL_INVALID`).

## Nesting

A `yaml_reference` to a script syndicate runs its whole script wherever it appears, as a delegated subagent, a dispatch route or a workflow node, as a turn of its own on its own conversation (as a nested dispatch syndicate does, [ADR 0120](/decisions/0120-nested-dispatch-syndicates-route-as-at-the-top.md)); its `askUser` and gated calls pause the turn with the path, and the answer resumes it.

## In use

The deployment's Discord routers, `financial_router` and `archimedes`, are scripts: deterministic regex overrides, then the classifier reading the transcript digest, a fail-static default route, and the route answering in the conversation, with the `Routed to <route> — <reason>` progress line the Penguin's route trace parses.
