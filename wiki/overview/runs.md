---
type: subsystem
title: Runs and steps
description: "How a program that runs several turns is recorded: traceRun and traceStep open step spans in a trace of their own, every turn stays its own trace and carries the run's key, traceModelCall traces a model call made outside an agent, and the ledger keeps the key in run_id and run_step_span_id."
tags:
  - observability
  - operations
status: stable
generated:
  by: claude-code/claude-fable-5-2
  at: 2026-11-15
sources:
  - resource: lib/observability/run.ts
  - resource: lib/observability/runContext.ts
  - resource: lib/observability/tracer.ts
  - resource: lib/observability/lineage.ts
  - resource: lib/observability/supabaseSpanExporter.ts
  - resource: db/migrations/0026_run_key.sql
  - resource: tests/runKey.test.ts
---

# Runs and steps

A program that runs several turns (a pipeline, a batch job) records itself as a **run**: a trace of **steps**, with each turn it starts tied to the step that started it ([ADR 0159](/decisions/0159-a-run-is-a-trace-of-steps-a-turn-joins-it-by-key.md)). The functions are in `lib/observability/run.ts`, exported from the package index and at `melchizedek-agents/observability/run`.

```ts
import { runSyndicateTurn, traceModelCall, traceRun, traceStep } from 'melchizedek-agents';

await traceRun({ name: 'daily', id: '2026-11-15', meta: { edition: '2026-11-15' } }, async () => {
  const found = await traceStep('collect', () => runSyndicateTurn({ config, parts, appName, userId, sessionId }));
  await traceStep('label', () =>
    traceModelCall({ provider: 'gemini', model: 'gemini-3.5-flash-lite' }, async () => {
      const response = await callTheProvider(found);
      return { result: response.text, usage: { inputTokens: response.inputTokens, outputTokens: response.outputTokens } };
    }),
  );
});
```

## What is recorded

```
run trace   step.execute daily              the run: run.id, run.name, run.llm_calls, run.models
              step.execute collect          run.id
              step.execute label            run.id
                llm.request                 run.id (a direct call)
turn trace  Syndicate Execution: <name>     run.id, run.name, run.step_span_id = <collect>
              agent.invoke … model.call … llm.request
```

- **A step** is a span named `step.execute <name>` (scope `melchizedek.runtime`). `ledgerSpanKind` returns `step` for it, so it has an `adk_telemetry` row with its parent, its timing and its `error` flag. It carries `step.name`, `run.id` and its labels as `meta.<key>`. It records no argument and no result. A step whose function throws is marked failed with `error.type` (the error's name) and the error is rethrown; the message is not recorded, because a step's row has no session to be erased with.
- **A run** is a step with no parent. `traceRun({ name, id?, meta? }, fn)` opens it as the root of a new trace and makes it the run context of everything `fn` starts. Its id is the caller's (a non-empty string of at most 256 characters, refused when shaped like a credential, since ids are never redacted) or a UUID; its name is the root step's, one line of at most 128 characters, refused on the same ground (a span's name is stored as written). When it ends, the root step takes the model calls made directly in its trace and writes `run.llm_calls` and `run.models`. A run started inside a run is a separate run.
- **`traceStep(name, fn, { meta? })`** opens a child of the step that is active, in the run's trace, whatever other span the calling code has active. Outside a run it is a run of its own (a UUID, the step's name), so a step is always reachable from a run.
- **A turn** started inside a run is the root of its own trace, as every turn is: `traceAgentRun` opens its span with `root: true`, so a span active in the calling code is never its parent and two turns never share a trace id. Its root span carries `run.id`, `run.name` and `run.step_span_id`, the span id of the step that was active.
- **A direct model call**: `traceModelCall({ provider, model }, fn)` wraps one call made outside an agent in the `llm.request` span every agent's call gets. `fn` returns `{ result, usage? }`, the usage in the model contract's terms (`lib/models/contract.ts`), and `result` is returned. Inside a step the span is the step's child and carries `run.id`. Inside a turn it is the turn's: it counts against the turn's step budget, stops with the turn, and a refused call throws without calling `fn`. No request and no response is recorded, and a failed call keeps no payload row.
- **`currentRun()`** returns `{ id, name, traceId, stepSpanId }` inside a run, else undefined.

## The stamp

OpenTelemetry has no attribute inheritance, so the run key is written when a span starts. The run context is an `AsyncLocalStorage` (`lib/observability/runContext.ts`), as the turn's controls are, and the tracer's lineage processor reads it in `onStart`, in the code that opened the span:

| Span | Gets |
|---|---|
| a turn's root | `run.id`, `run.name`, `run.step_span_id` |
| a step | `run.id` (its own run's, set when it opens) |
| any other span the ledger keeps, opened outside a turn (an `llm.request` under a step, a script's `script.invoke` and `script.call`) | `run.id` |
| a span inside a turn | nothing: the turn names the run |

A script run keeps its own key (`script.run`) and its own spans.

## Step metadata

`meta` on a run or a step follows the one set of metadata limits (`lib/observability/metadata.ts`, [ADR 0141](/decisions/0141-metadata-and-the-task-state-hook.md)): a key of letters, digits and `_ . : -` (at most 64), a string value of at most 256 characters, a finite number or a boolean, at most 32 keys. An entry outside the rule, a credential-shaped value, a key starting `agent.` and anything past 32 are dropped with one warning that names the keys, never a value. String values pass through the telemetry redactor in force.

## In the ledger

Migration `0026_run_key` adds the columns, and `db/telemetry.sql` adds them for a fresh install:

- `adk_turns.run_id` and `adk_turns.run_step_span_id`: the run that started the turn and the step, a `span_id` of an `adk_telemetry` row in the run's trace. `adk_turns.attributes` holds `run.name` beside them.
- `adk_telemetry.run_id`: on each step row and on each span opened in the run outside a turn. NULL on a turn's own rows, its root row included, so a run's rows in `adk_telemetry` are its steps and direct calls only.
- Partial indexes on `(run_id, ts)` in both tables, holding only rows in a run.

A run's tree is the `adk_telemetry` rows of its `run_id` nested by `parent_span_id`, with each `adk_turns` row of the same `run_id` hung under the step its `run_step_span_id` names. A direct `llm.request` row is priced by the ledger's trigger when its model id is one `model_pricing` holds (an exact id, or a `prefix/*` row); a run's cost is its turns' `cost_usd` plus its direct calls'.

The sinks write the new columns on every row, so migration 0026 is applied before an engine that writes them starts against a ledger ([Setup](/operations/setup.md)).

## In a turn that opted out of tracing

Inside `runSyndicateTurn({ trace: false })` a step goes through `startEngineSpan` and gets a non-recording span: its function runs, nothing is recorded, and no run context is set.
