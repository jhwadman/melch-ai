---
type: decision
title: "ADR 0064: Model tests assert from a ModelRequest, guarded by a scanned allowlist"
description: "The model suites drive the contract adapters with ModelRequests and assert the wire body; a scanned allowlist keeps new tests from building genai LlmRequests."
tags:
  - decision
  - models
  - testing
status: stable
generated:
  by: claude-code/claude-opus-5-5
  at: 2026-10-18
sources:
  - resource: tests/shimBodies.test.ts
  - resource: tests/llmRequestBoundary.test.ts
  - resource: tests/helpers/capabilityInputs.ts
  - resource: tests/helpers/scriptedLlm.ts
  - resource: tests/helpers/scriptedModel.ts
  - resource: tests/capabilityMatrix.test.ts
  - resource: tests/models.test.ts
  - resource: tests/modelRetry.test.ts
---

# ADR 0064: Model tests assert from a ModelRequest, guarded by a scanned allowlist

**Decided (2026-10-08):** The model suites drive the contract adapters with `ModelRequest`s and assert the wire body, so the native runtime inherits them. `tests/llmRequestBoundary.test.ts` fails any test file that builds a genai `LlmRequest` unless an explicit allowlist names it with a reason, and the moved model suites can never be listed. Until 1.0.0 one shim suite held each ADK class to its adapter's body.

**Instead of:** shim cases inside every model suite, round-tripping scripted responses through the mapping, `ScriptedLlm` tracing by its own path, converting every ADK-path suite at once, matching only a type import

**Superseded by:** [ADR 0107](/decisions/0107-release-1-0-0-removes-adk.md) (the shim suite and the ADK shim removed; `ScriptedLlm` is now a contract adapter)

How it works: [Model contract](/models/model-contract.md)
