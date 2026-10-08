---
type: decision
title: 'ADR 0033: Three ADK agent features as YAML keys, each placed where it means something: code_execution, context, mode'
description: '`code_execution: gemini` runs the model''s Python in Gemini''s server-side sandbox; `context:` compacts a long delegate conversation with ADK''s token-based compactor and an LLM summarizer; `mode: task` makes a workflow node''s output its finish_task arguments. The schema refuses each where it would do nothing or something unintended; local execution of model code stays out.'
tags:
  - decision
  - agents
  - runtime
status: stable
generated:
  by: claude-code/claude-opus-5-5
  at: 2026-10-02
sources:
  - resource: lib/compile.ts
  - resource: lib/syndicateSchema.ts
  - resource: tests/execution.test.ts
---

# ADR 0033: code_execution, context and mode as agent keys

## Context

The owner's audit of what ADK 2.2 ships and the framework does not use listed, after workflows, questions and OpenAPI tools: code execution, context compaction and task mode. Each is a field on ADK's `LlmAgent` (`codeExecutor`, `contextCompactors`, `mode`) that the compiler never set. Each was probed before this design: Gemini's built-in executor through the engine's own Gemini adapter (it wrote and ran Python, verified its answer a second way, and replied correctly); the token-based compactor with an LLM summarizer over five turns of an in-memory session; `mode: task` in a plain run and as a workflow node.

## Decision

1. **`code_execution: gemini`** sets ADK's `BuiltInCodeExecutor`: Gemini runs the model's code in Google's server-side sandbox and returns the output to the model. Gemini models only (the schema refuses others). **Local execution of model-written code is not offered**: ADK's `UnsafeLocalCodeExecutor` runs it on the host with no sandbox, and its container executor needs a Docker daemon the framework does not otherwise require. The one local execution path stays the harness's skill scripts, operator-installed and approved per run ([ADR 0029](/decisions/0029-skills-read-like-a-harness.md)).
2. **`context: { compact_after_tokens, keep_recent_events?, summary_model? }`** sets ADK's `TokenBasedContextCompactor` with an `LlmSummarizer` on the summary model (default the agent's own, resolved like any model). Past the threshold, earlier events become one compacted event and the most recent stay verbatim; the full history stays stored, and only what the model reads shrinks. Allowed on the **orchestrator of a delegate syndicate** only: a plan-dispatch route already reads a bounded projection (40,000 characters, 16 turns), a workflow node sees only its input, and a delegated subagent starts fresh on every call, so in each of those places the key would do nothing.
3. **`mode: task`** passes through. In a plain run it only adds a `finish_task` tool whose result the turn never reads, so the schema allows it on **workflow nodes** only, where ADK makes the node's output the `finish_task` arguments, validated against the agent's `outputSchema`: an agent can use its tools and still hand the next node a typed value.

> **Note (2026-10-08):** Since 0.20.0 the native runtime is the default ([ADR 0102](/decisions/0102-native-default-and-optional-adk-peer.md)), and it runs all three keys itself: `code_execution: gemini` through the Gemini adapter, `context:` compaction ported from ADK's compactor ([ADR 0078](/decisions/0078-native-compaction-ports-adk-compactor.md)), and `mode: task` ending a node on `finish_task` ([ADR 0081](/decisions/0081-native-task-mode-ends-a-node-on-finish-task.md)). The ADK classes named above serve only the optional adk runtime, which 1.0.0 removes ([ADR 0045](/decisions/0045-own-runtime-behind-the-seam.md)).

## Alternatives considered

- **Local code execution behind an approval** (as skill scripts are). Rejected for now: a skill script is code the operator installed and can read; a model's code is written fresh each time, so an approval prompt would ask a person to review generated code under time pressure.
- **Compaction everywhere it can be set.** Rejected: on a dispatch route or a subagent it changes nothing, and a key that silently does nothing is the defect the strict schema exists to prevent.
- **Our own summarizer.** ADK's compactor already keeps tool calls and responses paired when it cuts, and marks its event so later compactions fold the old summary in.

## Consequences

- A compacted event is stored like any other (the Postgres store writes the whole event; the storage trim keeps the marker), so a resumed conversation reads the summary, not the full history.
- A summary is an extra model call when the threshold is crossed, on `summary_model`; a cheap model is the usual choice.
- `tests/execution.test.ts` holds the three keys and their placement.
