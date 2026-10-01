---
name: wiki-first
description: Read the knowledge bundle before designing or coding — wiki/index.md, the entity graph, and the directory that owns what you are touching. Use at the start of every change, including small ones.
---

# Wiki-first development

`wiki/` is an **OKF v0.2 bundle**: one always-current document per subsystem,
frontmatter on every doc, and `index.md` / `log.md` maintained by the build
(never hand-edited). It is the fastest way to find the constraint you are
about to violate.

## Procedure

1. **Read `wiki/index.md`.** It is the map.

2. **Query the graph before grepping.** `npm run wiki:build` maintains a typed
   entity graph — agents, tools, models, modules, tables, environment
   variables, and the relations between them — in `wiki/.graph/graph.json`.
   Judgments read out of prose are asserted separately through `wiki_relate`
   into `wiki/.graph/relations.json`. Ask the graph which agents use the tool
   you are changing, then grep for what the graph cannot see.

3. **Read the directory that owns what you are touching:**

   | Touching | Read |
   |---|---|
   | a syndicate or agent prompt | `wiki/agents/` |
   | a tool, its schema, its exposure | `wiki/tools/` |
   | a provider, a model id, routing | `wiki/models/` |
   | memory, embeddings, supersession | `wiki/memory/` |
   | MCP or A2A interop | `wiki/protocols/` |
   | deployment, failure modes | `wiki/operations/` |
   | why something is the way it is | `wiki/decisions/` (ADRs) |

4. **Before designing, answer in writing:**
   - Which of the repo's invariants does the change touch?
   - What existing mechanism does it extend, rather than paralleling? (A new
     tool is a `defineTool` contract, not a bespoke schema. A new capability
     for an agent is a YAML edit, not a code branch. A new provider is an
     adapter behind the registry, not a call site. A new identity, policy or
     storage choice is a plug point option, not a fork of the server.)
   - Does it change what a consumer imports? (`package-surface`)

## Exit criteria

You may start implementing when you can state: the docs you read, what the
graph said, the invariants in play, and the mechanism you are extending.
`sync-wiki` closes what this opens.
