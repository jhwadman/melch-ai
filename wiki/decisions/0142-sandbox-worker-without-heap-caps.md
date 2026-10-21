---
type: decision
title: "ADR 0142: The sandbox worker runs without V8 heap caps"
description: "A sandbox worker sets no resourceLimits: capping its V8 heap made a background compile job's GC request deadlock Node's task drain at worker exit, so the worker and its process never exited; the code stays bounded by the wasm memory limit."
tags:
  - decision
  - security
  - tools
status: stable
generated:
  by: claude-code/claude-opus-5-5
  at: 2026-10-21
sources:
  - resource: lib/sandbox/sandbox.ts
  - resource: tests/codeSandbox.test.ts
  - resource: tests/fixtures/sandbox/exitAfterRuns.ts
---

# ADR 0142: The sandbox worker runs without V8 heap caps

**Decided (2026-10-21):** `runInSandbox` starts its worker without `resourceLimits`. The code's memory is the wasm heap `setMemoryLimit` holds; the 96 MB old and 16 MB young caps on the V8 heap around it bounded only the glue, and made collections frequent enough that one requested by a background Maglev job during worker exit deadlocked `NodePlatform::DrainTasks` (nodejs/node#54918). The worker never exited and kept its process alive: about one process in four that ran a mix of sandbox runs on Node 23.2, none of 120 without the caps.

**Instead of:** `--no-maglev` (a process-wide V8 flag a library cannot set for its host, and a Worker's `execArgv` refuses); larger caps (rarer, not gone); a child process per run, which could be killed when stuck (a process start per run, and a new protocol); a warm worker pool (fewer exits, the same deadlock at each one)
**Supersedes:** none
**Open:** a worker stuck in that drain still cannot be stopped from JavaScript; a child-process runner is the remedy if a Node release brings the deadlock back without the caps

How it works: [Run code](/tools/run-code.md)
