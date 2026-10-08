---
type: decision
title: "ADR 0084: The turn-level suites register every case once per runtime, and CI runs the offline suite again with native as the default"
description: "WS2-12 puts the suites ADR 0045's G2 names on both runtimes. tests/helpers/runtime.ts registers each turn-level case as `[adk]` and `[native]` in every npm test, sets the turn's runtime option and MELCHIZEDEK_RUNTIME for it and restores the environment, and registers conversations written on one runtime and continued on the other both ways. A case native cannot run yet is skipped with its reason and ticket; an open difference runs as a todo. CI runs npm test a second time with MELCHIZEDEK_RUNTIME=native, as a second step, so the required check names stay. Running the whole suite twice under the environment variable alone, a matrix axis, and skipping or pinning the cases that differ were rejected."
tags:
  - decision
  - runtime
  - operations
status: stable
generated:
  by: claude-code/claude-opus-5-5
  at: 2026-10-08
sources:
  - resource: tests/helpers/runtime.ts
  - resource: tests/syndicateTurn.test.ts
  - resource: tests/postgresStorage.test.ts
  - resource: tests/remoteAgent.test.ts
  - resource: .github/workflows/ci.yml
  - resource: lib/compileNative.ts
  - resource: lib/runtime/native/step.ts
---

# ADR 0084: The turn-level suites register every case once per runtime, and CI runs the offline suite again with native as the default

## Context

[ADR 0045](/decisions/0045-own-runtime-behind-the-seam.md) says that once the native runtime runs a turn, every suite G2 names runs under both runtimes until 1.0.0, and a test that passes under only one is a parity defect. [ADR 0073](/decisions/0073-one-agent-spec-and-a-runtime-flag.md) gives a turn its runtime by the `runtime` option, else `MELCHIZEDEK_RUNTIME`, else `adk`. Before WS2-12 only the question suites and `tests/nativeTurn.test.ts` ran conversations on both runtimes; the boundary suite and the surface suites ran on whatever the environment said, which in CI was ADK.

Running the whole offline suite with `MELCHIZEDEK_RUNTIME=native` showed 81 failures. Most were the test harness: the ADK-shaped scripted model read an `LlmRequest` that the native path never built. Three were native defects, fixed in their own commits:

- the native step sent a request under the YAML id where ADK sends it under the resolved model's own id, so Claude, GPT, Grok and Kimi chose thinking and replay by the wrong id;
- an adapter that threw escaped `runSyndicateTurn` on native, where ADK stores an `UNKNOWN_ERROR` event and fails the turn;
- a thrown provider failure never reached `fallback_model` on native.

Two are open questions (the WS2-12 PR): the `MALFORMED_FUNCTION_CALL` retry through the contract, and a resolver that returns an ADK model class which is not a shim. The rest were workflow syndicates (WS4) and tests whose subject is ADK itself.

## Decision

1. **Every turn-level case runs on both runtimes in every `npm test`.** `forEachRuntime(name, fn)` in `tests/helpers/runtime.ts` registers `name [adk]` and `name [native]`. For each it sets the turn's option, which a suite spreads in with `runtimeOption()`, and `MELCHIZEDEK_RUNTIME`, which the A2A server and the scripts read, and puts the environment back after the case, pass or fail.
2. **Conversations cross runtimes in both directions.** `acrossRuntimes(name, fn)` registers `[adk → native]` and `[native → adk]`. The boundary suite, the transcript suite, the A2A approval suite, the remote-agent suite and the Postgres suite each continue a conversation on the runtime that did not write it and require the results, the stored events (or rows) and the history every request carried to equal an all-ADK run. A session native wrote resumes under adk: the rollback path until 1.0.
3. **Nothing is skipped silently.** A case a runtime cannot run yet names the runtime, the reason and the ticket (`notOn`), and that runtime's test is registered as skipped with the reason on its SKIP line. A known difference still open runs as a todo (`differsOn`), so the output shows whether it still differs. A test whose subject is ADK itself (the `LlmRequest` an `LlmAgent` builds, ADK's own memory tools) pins `runtime: 'adk'` and says why.
4. **CI runs the offline suite a second time with native as the default.** The test job keeps `npm test` and adds a step with `MELCHIZEDEK_RUNTIME=native`; the storage job does the same for the Postgres suite. Every suite that is not dual-runtime then runs on native too, and the job names, so the required checks, do not change.

## Alternatives considered

- **Run the whole suite twice under the environment variable alone.** It needs no helper, but a developer's `npm test` would run one runtime, cross-runtime cases could not be expressed, and a test that pins a runtime could not say so. Kept as the second CI step, on top of the helper.
- **A matrix axis for the runtime in CI.** It would run the jobs in parallel, but it renames `test (node 22)` and `test (node 24)`, which are required checks. The second step costs the offline suite's wall time once more, about half a minute locally.
- **Run only the dual-runtime suites under native.** Cheaper, but the stop rule in ADR 0045 is about every stored shape, and the second full run found the defects listed above in suites G2 does not name (fallback, reasoning state).
- **Skip, or pin to ADK, a case that differs.** It would make both runs green and hide the difference the suites exist to find. An open difference runs as a todo and is listed in the PR that found it.

## Consequences

- `npm test` registers about 110 more cases; the wall time is about the same, since files run in parallel. CI adds one run of the offline suite and one of the Postgres suite.
- `tests/helpers/scriptedLlm.ts` runs on native: an ADK-shaped script reads the `LlmRequest` the native `ModelRequest` maps to.
- `scripts/parity_check.ts` runs its turns on the runtime `MELCHIZEDEK_RUNTIME` names and reports it, and sets the engine's log level.
- When native becomes the default (0.19.0), `notOn` and `differsOn` are the list of what still blocks: each carries its reason and ticket.
