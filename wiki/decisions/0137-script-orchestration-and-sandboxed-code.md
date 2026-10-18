---
type: decision
title: "ADR 0137: Script orchestration and run_code in a QuickJS sandbox"
description: "Syndicates may orchestrate with a script: function in a QuickJS-wasm sandbox, resumed by replaying a journal of its calls, and agents get a provider-neutral run_code tool in the same sandbox, both off until the operator opts in."
tags:
  - decision
  - orchestration
  - tools
  - security
status: stable
generated:
  by: claude-code/claude-opus-5-5
  at: 2026-10-18
sources:
  - resource: lib/syndicateSchema.ts
  - resource: lib/workflow/pause.ts
  - resource: lib/workflow/resume.ts
  - resource: lib/workflow/turn.ts
  - resource: lib/runtime/turnControl.ts
  - resource: lib/runtime/native/checkpoint.ts
  - resource: lib/session/transcript.ts
  - resource: lib/tools/toolContract.ts
  - resource: lib/compile.ts
  - resource: lib/sandbox/sandbox.ts
  - resource: lib/sandbox/worker.ts
  - resource: lib/tools/runCodeTool.ts
  - resource: lib/script/run.ts
  - resource: lib/script/journal.ts
  - resource: tests/codeSandbox.test.ts
  - resource: tests/scriptOrchestration.test.ts
---

# ADR 0137: Script orchestration and run_code in a QuickJS sandbox

**Decided (2026-10-17):** A fourth orchestration method, `script:`, holds one JavaScript function that calls the syndicate's agents, tools and `askUser`, run in a QuickJS-wasm sandbox on a worker thread and resumed after a pause by replaying a journal of its calls. Agents on any provider get a `run_code` registry tool in the same sandbox. Both stay off until the operator sets `MELCHIZEDEK_CODE_SANDBOX=on`.

**Instead of:** an expression language on workflow edges, a `code:` workflow node only, `node:vm`, `isolated-vm`, a sandbox on the calling thread, the asyncify build, `code_execution: "sandbox"`, on by default, attach always on, a journal in function responses, replay keyed on completion order, sandbox snapshots, resuming on the newly deployed script, free model choice in `agent()`
**Supersedes:** [ADR 0033](/decisions/0033-context-task-code.md) (the clause that local execution of model-written code is not offered)
**Open:** `run_code` calling the agent's tools; pauses inside an agent a script calls; Python (Pyodide) in the sandbox

How it works: [Script orchestration](/overview/script-orchestration.md), [run_code](/tools/run-code.md)
