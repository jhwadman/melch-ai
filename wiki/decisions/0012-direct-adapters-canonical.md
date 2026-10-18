---
type: decision
title: "ADR 0012: Direct adapters are canonical; a gateway only fills absent keys"
description: "One adapter per provider serves models; a hosted gateway is an opt-in fallback for ids whose direct key is absent, never selectable from an A2A request."
tags:
  - decision
  - models
  - operations
status: stable
generated:
  by: claude-code/claude-opus-5-5
  at: 2026-10-18
sources:
  - resource: lib/models/gateway.ts
  - resource: lib/models/gatewayLlm.ts
  - resource: lib/models/capabilities.ts
  - resource: lib/doctor.ts
---

# ADR 0012: Direct adapters are canonical; a gateway only fills absent keys

**Decided (2026-09-23):** A model id whose provider key is present is always served by its own adapter; `MODEL_GATEWAY` serves only ids with no direct key, is server-environment only, and is a transport rather than a provider; "which keys" is answered by the doctor, and capability loss is stated before a request.

**Instead of:** gateway as a mode routing everything, a gateway prefix in `providerMap.ts`, Vertex AI adapters, four keys up front
**Superseded by:** [ADR 0023](/decisions/0023-bring-your-own-endpoint.md) (item 6: Vertex AI, Bedrock and Azure OpenAI are now first-class platforms)

How it works: [Provider routing](/models/provider-routing.md)
