---
type: decision
title: "ADR 0101: The native loop passes a security gate and fails safe where ADK did not"
description: "Before native became the default its loop passed a security gate: a threat-model runbook with a test per path and a seeded fuzz suite, failing safe where ADK did not and throwing where ADK threw on forged input."
tags:
  - decision
  - runtime
  - security
status: stable
generated:
  by: claude-code/claude-opus-5-5
  at: 2026-10-18
sources:
  - resource: lib/models/genaiMapping.ts
  - resource: lib/runtime/valueDepth.ts
  - resource: lib/runtime/native/agentLoop.ts
  - resource: lib/runtime/native/interrupts.ts
  - resource: lib/runtime/credentials.ts
  - resource: lib/compile.ts
  - resource: tests/nativeFuzz.test.ts
---

# ADR 0101: The native loop passes a security gate and fails safe where ADK did not

**Decided (2026-10-08):** Gate the native default on a security review (WS5-5) recorded as a runbook and a seeded fuzz suite. Where ADK's behaviour was a defect the loop fails safe (contract-checked answers in the shared mapping, deep values replaced, own-key call ids, a consent resuming only the agent's own call once, self-referencing `yaml_reference` chains refused); where ADK threw on forged input, native throws the same.

**Instead of:** failing the turn on a contract breach, guarding the native step only, truncating deep values, keeping parity with ADK's consent resume
**Open:** a garbled approval answer or a response naming no call still throws (R1: return a failed result now ADK is gone)

How it works: [Native loop security](/operations/native-loop-security.md)
