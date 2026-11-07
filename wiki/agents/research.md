---
type: syndicate
title: Research
description: The Research syndicate.
tags:
  - syndicate
generated:
  by: process:wiki-build
  at: 2026-09-25
sources:
  - resource: config/agents/examples/research.yaml
---

# Research

<!-- wiki:fill slot="charter" -->
Research answers questions about clinical and biomedical evidence from the trial registry and the peer-reviewed literature. It links every claim to the record the claim rests on and states how far that evidence goes, on a fixed ladder: established, reported, registered, preprint, contested, retracted. Its [clinical-evidence tools](/tools/evidence-tools.md) read Europe PMC, ClinicalTrials.gov, Crossref and OpenAlex, and `web_extract` reads a paper's page. The sources are public, and the tools are read-only and need no API key.

A turn's time is model steps, not tool time, so the routes hold no tool whose work is done elsewhere: the guard checks every printed identifier for retraction and literature results flag retracted work, so there is no separate retraction call, and `cited_by` sits on `landscape` alone. A shared tool budget asks each route to issue independent calls in one step and to research in at most three steps; `max_steps: 16` is the backstop.

The shape is plan-dispatch. A small triage model picks one of three routes: `define` for a term, `lookup` for a named trial or paper (a message containing an NCT number, DOI or PMID goes there directly), or `landscape` for a body of evidence. The chosen route's output is the answer. Each route holds its own tools instead of delegating to researcher subagents, because a subagent tool returns only the subagent's final text. The `science` guard checks the answer against the tool output on the same stream. It marks any DOI, PMID or NCT number that no tool returned as unverified, checks retractions, and catches a trial acronym attached to the wrong identifier.

Research reports evidence and does not give advice. It declines to direct treatment for a person, to predict efficacy or approval, and to pick a winner between conflicting papers. `npm run mcp:science` serves the same tools over MCP to any client.
<!-- /wiki:fill -->

<!-- wiki:generated section="composition" source="config/agents/examples/research.yaml" -->
- memory: `session-only`
- orchestrator: **Triage** (`gemini-3.5-flash-lite`)

| Subagent | Model | Tools | MCP |
|---|---|---|---|
| define | `gemini-3.5-flash-lite` | — | — |
| lookup | `gemini-3.5-flash-lite` | `resolve_identifier`, `search_trials`, `search_literature` | — |
| landscape | `gemini-3.8-flash` | `search_trials`, `search_literature`, `search_preprints`, `resolve_identifier`, `web_extract`, `cited_by` | — |
<!-- /wiki:generated -->
