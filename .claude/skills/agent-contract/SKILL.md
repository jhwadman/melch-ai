---
name: agent-contract
description: The rules for editing an agent or syndicate YAML — what belongs in the YAML rather than in code, the examples/ and templates/ split, nested yaml_reference, validation, and why an edit can change nothing on a running server. Use BEFORE editing any agent YAML.
---

# The agent contract

**An agent is configuration, not code.** Its model, its instruction, its
sub-agents, its tools and its MCP server URL are declared in one YAML file that
`lib/loadSyndicate.ts` reads and `lib/syndicateSchema.ts` validates. Nothing
about an agent's behaviour is decided in a runner, a switch statement, or a
call site — if it is, that is the defect to fix, not a place to add a branch.

The schema is the contract: `config/agents/syndicate.schema.json` is generated
from `lib/syndicateSchema.ts` (`npm run schema:gen`), so an editor validates a
file as you type, and the loader refuses unknown keys, bad enums and missing
fields with the key path and a did-you-mean.

## Tools are declared in the YAML

A tool an agent may call is named in its `tools:` list, and an MCP surface it
may reach is named in `mcp_server_url`. Declaring a tool contract in
`lib/tools/` publishes nothing — an agent sees a tool only when the name is
registered (`TOOL_MAP` in `lib/toolRegistry.ts`, or `registerTool` from an
adopter) **and** in that agent's YAML. Two deliberate acts, so exposure is
always reviewable as one decision. An agent carrying a tool it does not need is
a finding.

## Shipped syndicates

- `config/agents/examples/` — the **starter pack**: small, teachable files.
- `config/agents/templates/` — **production starting points**.

`melchizedek-init --template <name>` copies one into a project, gives a
long-term-memory syndicate its own `memory_namespace`, and points it at the
JSON Schema. An edit here ships in the package: treat it as a public change,
with a CHANGELOG line when behaviour changes.

## Resolution on a server

A bare agent id is a **file** in the deployment's agents directory (ADR 0018).
The registry answers only `registry:<id>`, or bare ids the operator lists in
`A2A_REGISTRY_AGENTS`; shipped examples and templates answer only ids listed in
`A2A_SERVED_AGENTS`. There is no silent fallback between sources.

**Editing a YAML is not deploying it.** A loaded config is cached for the life
of the server process, so a change needs a restart; a registry-backed id
changes only when the new row is published and the server restarts. Nested
`yaml_reference:` agents are always read from the **file** beside their
parent, so one syndicate can be half-live — the parent from the registry, a
child from disk.

## Before you finish

- Does the file validate (`npm run doctor`, or load it once)?
- Is every tool name registered?
- Does `lib/models/providerMap.ts` route the model id where you think?
  (`model-routing`)
- Does a long-term syndicate declare its `memory_namespace`? (ADR 0020)
