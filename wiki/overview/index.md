# Overview

<!-- wiki:generated section="listing" source="directory contents" -->
- [Architecture](/overview/architecture.md) — The moving parts — loader, registries, adapters, persistence — and the five reasons the work is split across subagents instead of one omniscient agent.
- [Melchizedek](/overview/melchizedek.md) — A pure Google ADK multi-agent orchestration framework — YAML-defined syndicates, five-provider model optionality, Supabase persistence and memory, MCP and A2A interop.
- [Native loop](/overview/native-loop.md) — The native runtime's agent loop (lib/runtime/native/): one model step builds the request the ADK runtime would send for the same agent and session, calls the adapter under the turn's controls inside one llm.request span, and stores the answer as the event ADK would store. What the request holds and in what order, how the history is projected, what a stopped turn records, and what the step returns.
<!-- /wiki:generated -->
