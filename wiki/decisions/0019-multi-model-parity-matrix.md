---
type: decision
title: "ADR 0019: Multi-model means orchestration parity, stated as a tested matrix"
description: "Any provider may run any role including orchestrators; what each keeps or loses is data in the capability matrix, printed by the doctor and backed by request-shape tests."
tags:
  - decision
  - models
status: stable
generated:
  by: claude-code/claude-opus-5-5
  at: 2026-10-18
sources:
  - resource: lib/models/capabilities.ts
  - resource: lib/doctor.ts
  - resource: lib/models/gptLlm.ts
---

# ADR 0019: Multi-model means orchestration parity, stated as a tested matrix

**Decided (2026-10-01):** Any provider may run any role; adapters build declarations from the tool's own declaration, and `lib/models/capabilities.ts` is a provider-by-capability matrix whose every cell is asserted by an offline request-shape test and printed by the doctor.

**Instead of:** "Gemini orchestrators, any-provider leaves"

How it works: [Provider routing](/models/provider-routing.md)
