---
type: syndicate
title: Patient Advocate
description: The Patient Advocate syndicate.
tags:
  - syndicate
generated:
  by: process:wiki-build
  at: 2026-10-01
sources:
  - resource: config/agents/examples/patient_advocate.yaml
---

# Patient Advocate

<!-- wiki:fill slot="charter" -->
The Patient Advocate syndicate exists to assist patients and caregivers in navigating complex medical situations and communicating effectively with care teams. Led by the Asclepius orchestrator, it pairs in-depth scientific research with plain-language translations of test results, medical events, and doctor's orders. The syndicate excels at coaching bedside advocacy by providing actionable scripts, tracking health trends, separating normal symptoms from emergency red flags, and maintaining a persistent long-term health record across sessions so patient history is never lost. Run this syndicate when users need real-time support during active care, help interpreting lab trends or clinical records, research on treatment guidelines and drug interactions via MedScribe, or structured preparation for clinician visits.
<!-- /wiki:fill -->

<!-- wiki:generated section="composition" source="config/agents/examples/patient_advocate.yaml" -->
Run: `npm run syndicate:advocate`

- memory: `long-term`
- orchestrator: **Asclepius** (`gemini-3.8-flash`) · tools: `preload_memory`, `load_memory`

| Subagent | Model | Tools | MCP |
|---|---|---|---|
| MedScribe | `gemini-3.5-flash-lite` | `google_search` | — |
<!-- /wiki:generated -->

## The patient profile

Memory holds a whole-person profile as well as the chart. `memory_extraction_rules` file every record under one of fourteen domains from the `profile_domains` variable: identity, conditions, medications, allergies, results, care-plan, care-team, symptoms, nutrition, lifestyle, psychology, values, support and communication. The domain word opens the record's text (`nutrition: The patient…`) and is never an index key; keys name the specific thing (a drug, a food, a clinician), never the domain, the person's name or a trait, and each record holds one fact, so a correction retires only the record it is about ([memory architecture](/memory/architecture.md)). Each record names whose it is, the patient's or the caregiver's.

Psychology records hold what the person says about themselves, or an `INSIGHT` for a pattern the conversation shows at least twice with its evidence; never a diagnosis, a personality type or a judgment. A mental health diagnosis is stored only under conditions, with the clinician who made it as its source. `never_store` (insurance and government identifiers, full dates of birth, contact and payment details, MedScribe findings and Asclepius's own suggestions) resolves into both the extractor's rules and Asclepius's instruction.

`memory_preload_queries` preload the core of the profile with every message: allergies, current medications, communication, values, support and psychology ([ADR 0156](/decisions/0156-standing-preload-queries.md)). Asclepius's `<patient_profile>` section uses the domains when it answers, notes each personal fact in one line as it arrives so the user can correct it before it is stored, and asks for a missing domain one at a time, never during an emergency.
