---
type: syndicate
title: Editorial Pipeline
description: The Editorial Pipeline syndicate.
tags:
  - syndicate
generated:
  by: process:wiki-build
  at: 2026-10-03
sources:
  - resource: config/agents/examples/pipeline.yaml
---

# Editorial Pipeline

<!-- wiki:fill slot="charter" -->
The Editorial Pipeline is the starter pack's specimen of the third orchestration method, a syndicate as a graph ([ADR 0030](/decisions/0030-workflow-graphs.md)): its agents are the nodes of a `workflow:` block and `edges` says what runs after what. The Planner reads one request and answers in JSON; its `kind` field is the route. An article fans out to the Writer, who drafts from the brief, and the Checker, who lists the claims the piece must get right, running at the same time; Both, a join, hands the Editor `{ Writer, Checker }`, and the Editor, which retries once on a model error, merges them into the final draft. Confirm then pauses the turn with a question; the person's next message is the answer, and the Publisher receives `{ reply, input }`: the decision and the draft it concerns, returning the draft unchanged on a yes or with the one change the reply names. Anything that is not an article takes the `default` route to the Answerer, who replies directly. Every node receives only the previous node's output, so each agent's input is one value a person can read in the trace. Run `npm run syndicate:pipeline`; on Gemini an article spends four model calls to the pause and one after it. The block's contract is `lib/workflow.ts`; the rules the schema holds a graph to, and the pauses it refuses for now, are in [DOCUMENTATION §6](/overview/architecture.md).
<!-- /wiki:fill -->

<!-- wiki:generated section="composition" source="config/agents/examples/pipeline.yaml" -->
Run: `npm run syndicate:pipeline`

- memory: `internal-only`
- orchestrator: **Planner** (`gemini-3.8-flash`)
- workflow (a graph; the orchestrator is a node):
  - `START → Planner → { article: [Writer, Checker], default: Answerer }`
  - `[Writer, Checker] → Both → Editor → Confirm → Publisher`
- nodes:
  - **Planner**: agent · route_key
  - **Both**: join
  - **Editor**: agent · retry
  - **Confirm**: ask_user "Publish this draft? Reply yes, or say what to change."

| Subagent | Model | Tools | MCP |
|---|---|---|---|
| Writer | `gemini-3.8-flash` | — | — |
| Checker | `gemini-3.8-flash` | — | — |
| Editor | `gemini-3.8-flash` | — | — |
| Publisher | `gemini-3.5-flash-lite` | — | — |
| Answerer | `gemini-3.5-flash-lite` | — | — |
<!-- /wiki:generated -->
