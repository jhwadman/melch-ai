---
type: decision
title: "ADR 0033: code_execution, context and mode as agent keys, each only where it acts"
description: "code_execution: gemini runs model code in Gemini's server-side sandbox, context: compacts a delegate orchestrator's conversation, and mode: task types a workflow node's output; the schema refuses each where it would do nothing."
tags:
  - decision
  - agents
  - runtime
status: stable
generated:
  by: claude-code/claude-opus-5-5
  at: 2026-10-18
sources:
  - resource: lib/compile.ts
  - resource: lib/syndicateSchema.ts
  - resource: tests/execution.test.ts
---

# ADR 0033: code_execution, context and mode as agent keys, each only where it acts

**Decided (2026-10-02):** Three agent keys, each allowed only where it does something: `code_execution: gemini` (Gemini's server-side sandbox, Gemini models only), `context:` compaction on a delegate syndicate's orchestrator, and `mode: task` on workflow nodes. Local execution of model-written code was not offered.

**Instead of:** local code execution behind an approval, compaction everywhere it can be set, an own summarizer
**Superseded by:** [ADR 0137](/decisions/0137-script-orchestration-and-sandboxed-code.md) (model-written code may run locally in the `run_code` sandbox), [ADR 0078](/decisions/0078-native-compaction-ports-adk-compactor.md) and [ADR 0081](/decisions/0081-native-task-mode-ends-a-node-on-finish-task.md) (native compaction and task mode)

How it works: [Native loop](/overview/native-loop.md)
