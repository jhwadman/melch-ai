---
type: syndicate
title: Classifier
description: Decides a support message's department, its urgency and whether a person must look, as typed answers with probabilities.
tags:
  - syndicate
generated:
  by: process:wiki-build
  at: 2026-10-24
sources:
  - resource: config/agents/examples/classifier.yaml
---

# Classifier

<!-- wiki:fill slot="charter" -->
_TODO(fill): why this syndicate exists, what it does well, and when to run it — from the YAML header comment and the orchestrator instruction_
<!-- /wiki:fill -->

<!-- wiki:generated section="composition" source="config/agents/examples/classifier.yaml" -->
Run: `npm run syndicate:classifier`

- memory: `internal-only`
- orchestrator: **Triage** (`jev-latest`)

| Subagent | Model | Tools | MCP |
|---|---|---|---|
<!-- /wiki:generated -->
