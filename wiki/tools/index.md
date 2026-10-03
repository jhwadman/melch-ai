# Tools

<!-- wiki:generated section="listing" source="directory contents" -->
- [Ask the user](/tools/ask-user.md) — `ask_user(question, options?)`: an agent asks the person mid-turn; the turn ends input-required with the question, and the next message on the conversation is the call's result.
- [Clinical-evidence tools](/tools/evidence-tools.md) — Read-only clinical-evidence tool contracts: literature, preprints, the trial registry, citations and corrections.
- [OpenAPI tools](/tools/openapi-tools.md) — The `openapi:` agent key: an HTTP API with an OpenAPI 3 spec file becomes one tool per operation — GET operations unless others are named, credentials from environment variables, every server held to the SSRF guard, results bounded.
- [Skill harness](/tools/skill-harness.md) — The `skills:` agent key: a directory of Agent Skills held the way a coding harness holds them — the frontmatter index injected into the instruction, one SKILL.md and one file read on demand, `allowed-tools` honoured under the YAML's permit, and a skill's scripts run only after a person approves each run.
- [Task tools](/tools/task-tools.md) — A to-do list and a background-job queue in one local store; the tools write the queue, a separate worker runs it.
- [Tool contracts](/tools/tool-contracts.md) — Define a tool once — name, description, zod schema, execute — and derive every serving surface from it; exposure remains a separate, deliberate act.
- [Web tools](/tools/web-tools.md) — Reading the open web: deterministic page extraction as a contract, beside the provider-native search sentinels.
- [Wiki tools](/tools/wiki-tools.md) — The knowledge-bundle tool surface: navigation, gated writing, and agentic composites, defined once as zod contracts.
<!-- /wiki:generated -->
