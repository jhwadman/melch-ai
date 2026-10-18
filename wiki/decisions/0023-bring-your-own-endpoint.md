---
type: decision
title: "ADR 0023: Each provider takes a configured endpoint and credential source"
description: "Where an adapter sends requests and how it authenticates are per-provider configuration, with Vertex AI, Bedrock and Azure OpenAI first-class."
tags:
  - decision
  - models
status: stable
generated:
  by: claude-code/claude-opus-5-5
  at: 2026-10-18
sources:
  - resource: lib/models/providerMap.ts
  - resource: lib/models/gptLlm.ts
  - resource: lib/models/claudeLlm.ts
  - resource: lib/doctor.ts
---

# ADR 0023: Each provider takes a configured endpoint and credential source

**Decided (2026-10-01):** Direct adapters stay canonical, but each provider takes a platform, base URL, model map and credential source (environment key, the cloud's own chain, or the `credentials` plug point); Gemini on Vertex AI, Claude on Bedrock and Vertex AI, and GPT on Azure OpenAI are first-class.

**Instead of:** documenting SDK environment overrides only, routing everything through a hosted gateway
**Supersedes:** [ADR 0012](/decisions/0012-direct-adapters-canonical.md) (item 6)
**Open:** cloud platform paths tested against mocked clients only, never the live clouds; native web search on Bedrock, Claude on Vertex AI and Azure unverified, so not sent

How it works: [Provider routing](/models/provider-routing.md)
