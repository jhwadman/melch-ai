---
type: decision
title: 'ADR 0045: Own the runtime behind the seam: a native runtime beside ADK, built in stages, with ADK removed at 1.0'
description: The engine owns its agent loop, model contract, tools, sessions and workflow engine behind runSyndicateTurn. MELCHIZEDEK_RUNTIME (adk or native) carries the migration, adk by default until 0.19.0, and 1.0.0 removes ADK. Five gates and two stop rules govern it; ADR 0024's seam, boundary suite and A2A stance stand, and four stored or wire shapes never change without an ADR.
tags:
  - decision
  - models
  - protocols
status: stable
generated:
  by: claude-code/claude-opus-5-5
  at: 2026-10-07
sources:
  - resource: lib/runtime/syndicateTurn.ts
  - resource: lib/models/capabilities.ts
  - resource: tests/syndicateTurn.test.ts
  - resource: package.json
---

# ADR 0045: Own the runtime behind the seam: a native runtime beside ADK, built in stages, with ADK removed at 1.0

## Context

[ADR 0024](/decisions/0024-adk-behind-the-runtime-seam.md) (1 October 2026) kept Google's ADK as the agent runtime behind `runSyndicateTurn` and deferred owning the agent loop. It named three triggers for revisiting that: an ADK upgrade that breaks the boundary suite beyond what a pin can hold, ADK stalling its TypeScript line, or a required capability that only forking ADK's loop can provide.

Since then ADRs 0028 to 0034 built approval gates, Agent Skills, workflow graphs, `ask_user`, OpenAPI tools, code execution, context compaction and self-correction on ADK's mechanisms. That roughly tripled the surface that depends on ADK. An ADK independence audit (7 October 2026) found:

- **ADK runs through the library.** 65 ADK symbols are imported across 40 of the 102 files in `lib/`.
- **ADK is part of the published contract.** Consumers install `@google/adk` as a peer and construct ADK session services (`README.md`, `QUICKSTART.md`), although ADR 0024 keeps ADK types out of what callers write against.
- **The message format has no slot for reasoning state.** The internal format is `@google/genai` `Content`, which cannot carry provider-opaque reasoning state across a tool call. That is why the capability matrix (`lib/models/capabilities.ts`) marks `thinking_with_tools` unsupported on Claude and degraded on GPT, Grok and Kimi.
- **Four structural limits come from ADK's loop:**
  - `outputSchema` cannot share an agent with `AgentTool`, so an agent that returns a schema cannot also delegate.
  - A pause inside a delegated subagent is swallowed by `AgentTool`, so `require_approval` and `ask_user` are refused there.
  - A `Workflow` cannot be a subagent, so a `yaml_reference` to a workflow syndicate compiles only its orchestrator.
  - ADK's step ceiling resets inside each `AgentTool`, so `lib/runtime/turnControl.ts` bounds the turn instead, charging every model call at the adapters' shared choke point.
- **ADK's TypeScript line ships only Gemini models.** Every other adapter is this repository's own.
- **The standard is the protocol, not the framework.** A2A, which joined the Linux Foundation's Agentic AI Foundation in August 2026, is served by this repository's own server and client (`lib/a2a/`), with no ADK in the path.

ADR 0024's third trigger has partly fired: these limits can be removed, rather than worked around, only by owning the loop.

## Decision

1. **The engine owns its runtime, in stages, behind the seam.** The agent loop, the model contract, tools, sessions and the workflow engine become the framework's own: the native runtime. The model contract is the engine's own message format, with a slot for the provider-opaque reasoning state that `@google/genai` `Content` cannot carry. ADR 0024's seam (`runSyndicateTurn` in `lib/runtime/syndicateTurn.ts` is the only place a turn runs), its boundary suite (`tests/syndicateTurn.test.ts`) and its A2A stance stand unchanged.
2. **A runtime flag carries the migration.** `MELCHIZEDEK_RUNTIME` selects `adk` or `native`. The default is `adk` until release 0.19.0, which makes `native` the default. Release 1.0.0 removes ADK: its runtime path and its peer dependency.
3. **Five gates, each signed off in the gate log below:**
   - **G1:** every capability-matrix cell asserts against the engine's own model contract.
   - **G2:** the boundary, approval, question, self-correction, streaming, governance and A2A suites pass under both runtimes. One live turn succeeds on each of the six providers (Gemini, Anthropic, OpenAI, xAI, Moonshot, Ollama). A pause opened under `adk` resumes under `native`.
   - **G3:** the Gemini row's evidence in the capability matrix changes from `adk` to `test`.
   - **G4:** the workflow suite passes under `native`, and `config/agents/examples/pipeline.yaml` runs live.
   - **G5:** release 1.0.0.
4. **Four shapes never change without an ADR:**
   - the stored Event JSON in `adk_sessions.events` and `adk_session_events`;
   - the interrupt names `adk_request_confirmation` and `ask_user`, and their argument shapes;
   - the A2A surface;
   - the `runSyndicateTurn` signature.
5. **Two stop rules:**
   - The default does not flip to `native` while any ADK-written session fixture fails to resume under `native`.
   - The ADK path is deleted only after two weeks in production with `native` as the default and no incident attributed to the runtime.

> **Note (2026-10-07):** The stored Event JSON in item 4 carries an elided tool result's size inside its marker text. `trimEventForStorage` (`lib/session/transcript.ts`) now writes that size with en-US digit grouping (`2,563`) on every server, where it used to follow the server's locale (`2.563` in German, `2 563` in French). The JSON shape and the marker's wording are unchanged, and an en-US server writes the same bytes as before. Rows already stored keep the grouping they were written with, and no code parses the size.

## Alternatives considered

- **Keep ADK and fix the gaps inside it.** Carry provider-opaque reasoning state on a part field by convention, add Anthropic vision, and add a provider-neutral `reasoning:` key. This closes the reasoning-replay gaps but none of the four structural limits, and the peer dependency stays. Partly adopted: it is the first workstream, because every other option needs it too.
- **Strip ADK in one move.** Rejected. It is the same work done on one branch with no release in between, which freezes releases for a quarter. It reverses the ADK mechanisms of ADRs 0028 to 0034 at once, and every stored pause and workflow must resume on the first day.
- **Adopt another runtime** (the Vercel AI SDK, Mastra, the OpenAI Agents SDK). Rejected, as in ADR 0024. Each is a migration of the same size with its own lock-in, and pauses inside delegation and workflows as subagents would follow that framework's rules instead of ADK's.

## Consequences

- Before 0.19.0 a consumer runs on ADK unless they set `MELCHIZEDEK_RUNTIME=native`. `@google/adk` stays a peer dependency, pinned with `@google/genai` as ADR 0024 sets out.
- Once the native runtime runs a turn, every suite named in G2 runs under both runtimes until 1.0.0. A test that passes under only one is a parity defect.
- The capability matrix records progress: G1 is met when every cell's test asserts against the engine's own model contract, and G3 when the Gemini row's evidence moves from `adk` to `test`.
- The `thinking_with_tools` gaps close once the engine's model contract carries provider-opaque reasoning state.
- The risks are Gemini parity (grounding, thought signatures, streaming), resuming ADK-shaped stored sessions, and workflow semantics. The stop rules and the cross-runtime resume in G2 guard them.
- At 1.0.0 consumers stop installing `@google/adk` and stop constructing ADK session services. That change goes through `package-surface` with a breaking `CHANGELOG.md` entry.
- ADRs 0028 to 0034 keep their YAML surface. As each one's mechanism moves off ADK, that ADR gets a dated note pointing here.
- ADR 0024 carries a dated note pointing here. Its seam, turn-wide controls, boundary suite and A2A items stand, and its "track ADK's current major" item holds while ADK is a runtime.

## Gate log

Each gate's line is signed when its review passes, with the date, the evidence and who signed.

- **G1** (own model contract): **signed 2026-10-08 by the owner (jhwadman).** Evidence: the model contract (ADR 0048, #67); every provider's adapter on it behind the ADK shim (Claude #86, GPT and Grok #85, Kimi, Ollama and the gateway #87, Gemini through the temporary wrapper #82 and the engine's own adapter #75, unregistered); the genai mapping (#76); the shim (#80, ADR 0053); JSON mode on the contract (#88); fallback on error responses (#74); live checks on Claude, GPT, Grok, Kimi and Gemini during the reviews. Still open when signed, and owed before 0.19.0: WS1-11 (the tests assert from `ModelRequest`), WS1-12 (the `./model` export with no ADK in its import graph), and the live parity run under `adk` with every adapter behind the shim.
- **G2** (both runtimes, six providers, cross-runtime resume): **signed 2026-10-08 by the owner (jhwadman).** Evidence: the native loop and its parts (WS2-5a #97, WS2-5b #102, delegation #104, self-correction #105, telemetry #106, the runtime flag #107, compaction #108, approvals #109, questions #113, the A2A executor off ADK #110, code execution and task mode #112, the skills harness #114, OAuth consent #115); the dual-runtime suites (WS2-12, ADR 0084): the boundary, approval, question, self-correction, streaming, governance, transcript, memory, A2A, identity, turn-lock, trace, audit, MCP, remote-agent and Postgres suites under both runtimes, CI running the offline suite and the storage job once per runtime; approvals and questions opened under `adk` resume under `native` and the reverse (session fixtures 03 and 04 included). Signed ahead of: the live turn on each of the six providers under `native`, owed before the release that makes `native` the default. Open differences carried forward: Gemini's `MALFORMED_FUNCTION_CALL` is not retried on `native` (a todo case, ADR 0075's open point), and a resolver returning a custom ADK model class is not honoured on `native`.
  - *2026-10-08, after signing:* the live turn under `native` ran (`npm run parity`, all six providers): 35 of 36 checks pass. The one miss, Ollama `qwen3:8b` structured output, fails the same way under `adk`, so it is the Ollama adapter or the model, not the runtime. The two carried differences are closed by ADR 0088: Gemini's `MALFORMED_FUNCTION_CALL` is retried on `native`, and a custom ADK model class is refused on `native` instead of replaced.
- **G3** (Gemini evidence `test`): open.
- **G4** (native workflows, `pipeline.yaml` live): **signed 2026-10-08 by the owner (jhwadman).** Evidence: the engine's own workflow engine (graph #111, scheduler #118, controls #122, agent nodes #121, tool nodes #120, pause #123, parity gaps #124, resume #125) and the native workflow turn (#126, ADR 0095); `tests/workflow.test.ts` passes under both runtimes, the ADK-written workflow-pause fixture resumes under `native` through `runSyndicateTurn`, and the ledger shows per-node attribution. `config/agents/examples/pipeline.yaml` ran live under `native` and under `adk` (Gemini 3.8 flash and 3.5 flash lite): an article request runs Planner, Writer and Checker in parallel, the join, Editor, pauses at Confirm `input-required`, and the reply resumes it to Publisher, with the same node sequence and statuses on both runtimes. That run found and #128 fixed a native-only failure (the reflection tool declared to Gemini, ADR 0097). Still open when signed: WS4-7 (a workflow syndicate as a subagent), which the plan lets land after G4.
- **G5** (release 1.0.0): open.
