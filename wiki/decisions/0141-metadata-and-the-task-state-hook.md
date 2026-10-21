---
type: decision
title: "ADR 0141: Turn metadata from the YAML and the request, and a task-state hook"
description: "Static metadata: in the YAML and per-request metadata over A2A become meta.* span attributes under one set of limits; the operator's keys win over a caller's, a malformed header refuses the request while a message entry that is not metadata is skipped, and onTaskState reports each published task state."
tags:
  - decision
  - observability
  - a2a
status: stable
generated:
  by: claude-code/claude-opus-5-5
  at: 2026-10-20
sources:
  - resource: lib/observability/metadata.ts
  - resource: lib/a2a/executor.ts
  - resource: lib/a2a/app.ts
  - resource: tests/metadata.test.ts
---

# ADR 0141: Turn metadata from the YAML and the request, and a task-state hook

**Decided (2026-10-20):** A syndicate's `metadata:` becomes `meta.<key>` on the turn's root spans and an agent's `meta.agent.<key>` on its agent span; an A2A request adds its own through `X-Melch-Meta-*` headers and the scalar entries of `Message.metadata`, under the same limits (a key `[A-Za-z0-9_][A-Za-z0-9_.:-]{0,63}`, scalar values of at most 256 characters, 32 keys a turn) and the same redaction. A credential-shaped value is dropped with a warning that names the key, never refused. A caller cannot set a key the YAML declares, nor one starting `agent.`; an in-process caller's `trace.attributes` does win, being the operator's own code. A malformed header refuses the request (400), as `X-Surface` does, while a message entry that is not metadata is skipped, because protocol extensions share that object. A header wins a key both name. `A2AAppOptions.onTaskState` reports each new state the executor publishes, consecutive repeats folded, rather than reading states off `createMetrics()`, whose `TaskRecord` sees only a task's end.

**Instead of:** refusing a YAML file or a request over a secret-shaped value; a caller's metadata relabelling the operator's; refusing a whole task over a stray `Message.metadata` entry; dropping a malformed header silently; a `metadata.melch` sub-object; one hook call per `[STATUS]` line; a `working` status published at turn start only to feed the hook
**Supersedes:** none
**Open:** per-request metadata for the MCP server and the worker; a task the reaper fails on a dead instance reaches no hook (it is written to the task store, not published)

How it works: [A2A](/protocols/a2a.md), [the spans](/overview/native-loop.md#the-spans)
