---
type: decision
title: 'ADR 0034: Self-correction is on by default (ADK''s reflect-and-retry plugins); url_context and examples join the agent surface'
description: Every turn runs ADK's ReflectAndRetryModelPlugin (a malformed model reply is retried instead of failing the turn) and ReflectAndRetryToolPlugin (a tool that throws gets structured guidance and a retry cap), tunable or off through a root `retries:` key. `url_context` is Gemini's server-side URL reading, made safe to declare on any provider; `examples:` is ADK's ExampleTool from YAML pairs.
tags:
  - decision
  - runtime
  - tools
status: stable
generated:
  by: claude-code/claude-opus-5-5
  at: 2026-10-02
sources:
  - resource: lib/runtime/syndicateTurn.ts
  - resource: lib/tools/urlContextTool.ts
  - resource: lib/compile.ts
  - resource: tests/selfCorrection.test.ts
---

# ADR 0034: Self-correction on by default; url_context and examples

## Context

The last items of the owner's ADK audit, the small quality-of-life ones. Each was probed with a scripted model before deciding:

- **A malformed model reply** (`MALFORMED_FUNCTION_CALL`, which Gemini emits when it produces a function call it cannot parse) reached the turn runner as an error event and failed the turn. With `ReflectAndRetryModelPlugin` on the Runner, the same reply was retried with guidance and the turn completed.
- **A tool that throws** already came back to the model as a plain `Error in tool …` string, and models retried on their own. `ReflectAndRetryToolPlugin` replaces that string with structured guidance (what failed, the retry count, what to change) and caps the retries.
- **ADK's `URL_CONTEXT`** throws for any non-Gemini model, the same defect that made the framework wrap `google_search` as `web_search`.
- **`ExampleTool`** adds few-shot exchanges to the instruction of every request without the model ever calling it.

## Decision

1. **Both reflect-and-retry plugins run on every turn by default** (`runSyndicateTurn` passes them to each Runner it builds): model errors retried up to 2 times, tool errors up to 3, the tool plugin returning guidance rather than throwing when the cap is reached. A root `retries: { model_errors, tool_errors }` tunes either; `0` turns it off. Every retry is a model call, so `max_steps` and the deadline still bound a turn.
2. **`url_context`** is a registry tool built the way `web_search` is: on a Gemini model it adds `{ urlContext: {} }` to the request; on any other it does nothing, and the capability matrix reports it dropped. Google fetches the pages, not this host, so it opens no path into the deployment's network.
3. **`examples: [{ input, output }]`** on any agent becomes ADK's `ExampleTool`.

## Alternatives considered

- **Retries off by default, opt-in per syndicate.** Rejected: a malformed function call failing a whole turn is a defect no author would choose, and the owner asked for it on by default. The cost is a behaviour change for existing syndicates, stated in the CHANGELOG with the line that restores the old behaviour.
- **ADK's `URL_CONTEXT` as is.** Rejected: declaring it on a Claude agent would fail every request at build time.
- **Few-shot examples in the instruction prose** (what the starter pack does today). Still fine, and still the norm in the shipped files; `examples:` is for authors who want them as data.

## Consequences

- A turn that would have failed on one malformed reply now spends one or two more model calls and completes. The retries show up in the ledger as ordinary model calls.
- The plugins are per Runner, so each agent run (a classifier, a route, an orchestrator, a workflow) has its own counters.
- `tests/selfCorrection.test.ts` holds the defaults, the off switch, `url_context` on both kinds of provider, and `examples`; `url_context` was verified live on Gemini.
