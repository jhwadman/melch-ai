---
type: runbook
title: Parity harness
description: "`npm run parity` runs one fixed syndicate through runSyndicateTurn on every funded provider and reports, per provider, whether delegation, a client-side tool, structured output, streaming, a second turn and token usage work end to end — the run each runtime gate is."
tags:
  - operations
  - models
  - testing
status: stable
generated:
  by: claude-code/claude-opus-5-5
  at: 2026-10-07
sources:
  - resource: scripts/parity_check.ts
  - resource: tests/fixtures/parity.yaml
  - resource: tests/parityHarness.test.ts
  - resource: lib/runtime/syndicateTurn.ts
  - resource: lib/models/registry.ts
---

# Parity harness

`npm run parity` (`scripts/parity_check.ts`) answers one question per provider: does the engine's core work end to end on it? It loads one fixed syndicate, `tests/fixtures/parity.yaml`, binds its model ids to the provider's, and runs four turns on one in-memory conversation through `runSyndicateTurn`, the seam every surface uses ([ADR 0024](/decisions/0024-adk-behind-the-runtime-seam.md)). A runtime gate is a run of this script, not a manual check.

## Running it live

The live run needs the provider keys, so it runs from the main checkout, where `.env` lives (a worktree has none):

```bash
npm run parity                                    # every funded provider
npm run parity -- --providers gemini,anthropic    # some of them
npm run parity -- --model anthropic=claude-haiku-4-5   # another model for one provider
npm run parity -- --timeout 180                   # per-turn deadline in seconds (default 120)
```

**Funded** means what the doctor means ([provider routing](/models/provider-routing.md)): `providerStatuses()` reports a direct key, a configured cloud platform, or the gateway standing in for an absent key. A provider served by the gateway runs, and its row says `(gateway:<id>)`. Ollama runs only when its endpoint (`OLLAMA_BASE_URL`, default `http://localhost:11434/v1`) answers. Every other provider is listed as skipped, with the variable that would fund it.

Each provider runs its default model (`lib/config.ts`) for the orchestrator and both subagents unless `--model` names another. `--model` rejects an id that routes to a different provider. One provider costs about nine model calls with short prompts, and `max_steps: 12` caps each turn. A thinking model (`kimi-k3`) bills its reasoning as output on every call. With the telemetry sink on, the spend reaches the ledger like any other turn's, tagged `surface.name = parity`.

## The turns and what each check proves

| Turn | The message asks | Checks it carries |
|---|---|---|
| 1 `delegate` | Echo to repeat a fresh code word | delegation |
| 2 `tool` | `parity_lookup` for the key `alpha` | client tool |
| 3 `structured` | Recorder to file a record (city, a second code word, a count) | structured output |
| 4 `followup`, streamed | the code word of the first message | streaming, second turn |
| every turn | — | token usage |

| Check | Passes when | What it proves |
|---|---|---|
| delegation | the orchestrator calls `Echo` with the code word in its arguments, and Echo's reply carries it back | a subagent is reachable as a tool on this provider, the argument schema survives translation, and the argument reaches the subagent: its own session is empty, so the code word can only come from the call |
| client tool | `parity_lookup` (registered by the harness in its own process) runs for the key `alpha`, and the answer contains the value it returned | a function tool's declaration reaches the model, the call comes back parsed, and the result is fed to the model and used. The value is random per run, so it cannot be guessed |
| structured output | the Recorder's response, as the orchestrator received it, parses against the `outputSchema` its YAML declares | the adapter sends the schema in the provider's structured-output form, and what comes back conforms. The schema is the YAML's, read through `z.fromJSONSchema`, never a second copy |
| streaming | the streamed turn fires `onTextDelta` at least once | the adapter streams partial text through the runtime to a surface |
| second turn | the turn resumed the session, and its reply names the first turn's code word (turn 3 uses a different one) | history from earlier turns reaches the model on a later turn |
| token usage | every completed turn reports model calls and input and output tokens greater than zero | the adapter reports usage and the turn's accounting (`TurnUsage`, what budgets and the ledger count) receives it |

Every check also requires its turn to have completed. A turn that failed reports `turn '<name>' ended failed [<code>]`, the code being the provider's or the turn runner's (`429`, `STEP_LIMIT`, `DEADLINE_EXCEEDED`).

The live models are not deterministic. A failure detail separates the two causes:

- **The model chose differently** ("the orchestrator never called Echo", "the answer does not use parity_lookup's value"). Rerun that provider with `--providers` before calling it a regression.
- **The engine or provider failed** (a turn that ended failed, a schema mismatch). Investigate.

## Output

- **stdout**: a provider-by-check table (✓/✗, the model id, the provider's wall time), one line per failed check with the harness's own reason, the skipped providers and a PASS or FAIL line. Only provider ids, model ids, outcomes and timings appear: never a key, a header or a request body. Console spans are forced off for the run, because a failed call's span carries its request payload.
- **The JSON report** goes to `outputs/parity-<UTC date and time>.json` (`outputs/` is gitignored; `--out <dir>` puts it elsewhere). It has the run's mode and runtime, and per provider: the transport, the models, each turn's status, duration, model calls and tokens, and each check's outcome and detail. A provider's error message is kept here only, cut to 500 characters, with key-shaped strings redacted by the ledger's `secret` pattern (`lib/observability/redact.ts`).
- **Exit code**: 0 when every check passed, 1 when any check failed or no provider ran, 2 on a usage error.

## The runtime flag

`MELCHIZEDEK_RUNTIME` (`adk` or `native`, default `adk`; anything else is a usage error) picks the runtime: every turn passes it to `runSyndicateTurn` as the `runtime` option ([ADR 0073](/decisions/0073-one-agent-spec-and-a-runtime-flag.md)). The report records it as `runtime.requested` and `runtime.ran`, and the table's first line names it. The script sets the engine's log level (`lib/runtime/logging.ts`), never ADK's.

## The self-test

`npm run parity -- --scripted` replaces every provider's models with scripted ones (`tests/helpers/scriptedLlm.ts`): no key, no `.env`, no network. One deterministic stand-in plays each agent's role by reading the request: it is offered `Echo` as a tool (the orchestrator), it is asked for a response schema (the Recorder; `responseSchema` in the request ADK builds, `responseJsonSchema` in the native request read back as an `LlmRequest`), or it is neither (Echo). Its report is named `parity-scripted-…` and says `mode: scripted`, so it can never pass for a live gate. `--fault <check>` (scripted only) makes the stand-ins break one behaviour.

`tests/parityHarness.test.ts` runs it inside `npm test`:

- a clean scripted run passes all 36 checks;
- each fault fails exactly its own check, so no check can pass vacuously;
- the CLI exits 0 with a dated report, 1 with a deliberately failing check, and 2 on a usage error;
- nothing key-shaped, header-shaped or body-shaped reaches stdout or the report.
