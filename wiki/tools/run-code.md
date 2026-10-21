---
type: tool
title: Run code
description: "`run_code({ code, input? })`: an agent on any provider runs a JavaScript module in the engine's QuickJS sandbox and rests its answer on what it returned; off until the operator sets MELCHIZEDEK_CODE_SANDBOX=on."
tags:
  - tools
  - security
status: stable
generated:
  by: claude-code/claude-opus-5-5
  at: 2026-10-17
sources:
  - resource: lib/tools/runCodeTool.ts
  - resource: lib/sandbox/sandbox.ts
  - resource: lib/sandbox/worker.ts
  - resource: tests/codeSandbox.test.ts
---

# Run code

`run_code` is a registry tool: an agent lists it in `tools:` and the model writes a JavaScript module whose default export is called with `input`. The tool returns `{ result, logs, error }`: the export's JSON-serializable return value, the `console.log` output, and what stopped the code, if anything, each bounded at 20,000 characters. When `error` is set the model reads why and may run fixed code; `retries.tool_errors` applies as to any tool. Because the model only writes text, it works on every provider; `code_execution: gemini` remains for Python in Gemini's own sandbox on Gemini models ([ADR 0033](/decisions/0033-context-task-code.md)).

## The sandbox

The code runs in QuickJS compiled to wasm (`quickjs-emscripten-core` with the release sync build, pinned at 0.32.0), one fresh runtime in one fresh worker thread per run (`lib/sandbox/sandbox.ts`, `lib/sandbox/worker.ts`). It reaches the argument it is called with and `console`, and nothing else: no `fetch`, no timers, no file system, no `process`, no environment, no module imports. `Date.now`, `new Date()` with no arguments and `Math.random` throw, so a result depends only on its input. Values cross as JSON both ways.

A run has 64 MB of memory, a 1 MB stack and 5 seconds of compute, counted only while the code computes. An interrupt handler stops it at the budget; a watchdog on the main thread terminates a worker that computed past it without answering; the turn's signal terminates it on cancel or deadline. At most `MELCHIZEDEK_CODE_SANDBOX_WORKERS` runs (default 16) hold a worker at once. Running on a worker thread keeps the compute off the event loop the A2A server's turns, streams and MCP calls share.

The 64 MB is the wasm memory QuickJS allocates from, which lies outside the worker's V8 heap; the worker sets no `resourceLimits`, because the JS it runs is the QuickJS glue and strings already bounded by that limit and the result and log limits. A capped V8 heap collects often, and a collection that a background compile job asks for while the worker exits deadlocks Node's platform task drain (nodejs/node#54918): the worker never exits, and neither does its process ([ADR 0142](/decisions/0142-sandbox-worker-without-heap-caps.md)). `tests/codeSandbox.test.ts` starts eight processes that each run a mix of sandbox runs and fails any that does not exit on its own.

## The switch

Nothing runs until the operator sets `MELCHIZEDEK_CODE_SANDBOX=on`. A syndicate whose agent lists `run_code` is refused with `CodeSandboxOffError`, naming the variable, when a turn starts and before any model call; a call that reaches the tool anyway answers with the same reason. The sandbox grants no power the agent lacks, so the switch is a posture rather than a boundary: a deployment that never meant to run code does not start because a YAML changed ([ADR 0137](/decisions/0137-script-orchestration-and-sandboxed-code.md) item 4, as [ADR 0132](/decisions/0132-local-mcp-servers-over-stdio.md) gates stdio MCP).

## Attach

`run_code: { attach: true }` on the agent puts each run's code and result on the reply. The turn result carries them as `codeRuns` (`{ type: 'code_run', agent, code, result, error? }`, in order), and the A2A server publishes them as a `code_runs` artifact of data parts before the final status, so a reader can see and rerun the computation the answer rests on. The schema refuses `run_code:` on an agent whose `tools` do not list it, and on a nested or remote agent. Default off: a client that renders data parts as text would print code into its answers.

## Exposure

The model chooses the code and the input, so both are untrusted; the sandbox is what makes that safe, not a review of the code. QuickJS's C engine has had memory-safety defects; inside wasm one corrupts the instance's linear memory, so the worst case is a crashed run the worker contains. The tool is also the `script:` runner's sandbox ([Script orchestration](/overview/script-orchestration.md)).
