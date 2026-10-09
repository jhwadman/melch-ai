---
type: syndicate
title: Council
description: The Council syndicate.
tags:
  - syndicate
generated:
  by: process:wiki-build
  at: 2026-10-01
sources:
  - resource: config/agents/examples/council.yaml
---

# Council

<!-- wiki:fill slot="charter" -->
The Council exists as a local multi-agent specimen that runs entirely on open-weights models (`ollama/qwen3:8b`) without requiring API keys, tools, or a database. It stress-tests claims, plans, and decisions by gathering independent perspectives before reaching a conclusion.

Run the Council when evaluating a proposed claim or decision. The Moderator consults both subagents in a single step: one response carries both function calls, each passing the user's full claim verbatim, to the Advocate to build the strongest honest case for it and to the Skeptic to identify risks and failure modes. The two run at once under the syndicate's `max_concurrency` ([ADR 0116](/decisions/0116-a-steps-subagent-calls-run-at-once-under-max-concurrency.md)), and their reports come back in call order. Once both subagents report, the Moderator weighs both perspectives to output a structured report detailing the case for, the case against, and a final verdict.
<!-- /wiki:fill -->

<!-- wiki:generated section="composition" source="config/agents/examples/council.yaml" -->
Run: `npm run syndicate:council`

- memory: `internal-only`
- orchestrator: **Moderator** (`ollama/qwen3:8b`)

| Subagent | Model | Tools | MCP |
|---|---|---|---|
| Advocate | `ollama/qwen3:8b` | — | — |
| Skeptic | `ollama/qwen3:8b` | — | — |
<!-- /wiki:generated -->
