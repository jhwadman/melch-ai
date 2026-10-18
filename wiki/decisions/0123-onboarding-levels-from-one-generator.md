---
type: decision
title: "ADR 0123: Onboarding by authentication level, from one generator, detected by the doctor"
description: "melchizedek-setup routes newcomers by authentication level from one generator that also writes ONBOARDING.md, and detects the level through the doctor."
tags:
  - decision
  - operations
  - onboarding
  - skills
status: stable
generated:
  by: claude-code/claude-opus-5-5
  at: 2026-10-18
sources:
  - resource: lib/onboarding.ts
  - resource: scripts/setup.ts
  - resource: lib/doctor.ts
  - resource: lib/skills.ts
  - resource: scripts/skills_install.ts
  - resource: ONBOARDING.md
  - resource: AGENTS.md
  - resource: tests/onboarding.test.ts
---

# ADR 0123: Onboarding by authentication level, from one generator, detected by the doctor

**Decided (2026-10-09):** Onboarding levels and guides live once in `lib/onboarding.ts`: the setup menu prints them, `ONBOARDING.md` is generated from them under an equality test, and `--auto` reads the doctor's result. Onboarding skills are hand-written procedures that print the guides; consumer subscription sign-ins get an honest entry, not a code path.

**Instead of:** hand-written guide docs, a second detector, Scribe-written onboarding skills, writing `AGENTS.md` on every install, a symlinked repository copy, reusing subscription tokens
**Superseded by:** [ADR 0126](/decisions/0126-sign-in-with-chatgpt-local-only.md) (Sign in with ChatGPT becomes its own level; the unsupported entry covers the rest)

How it works: [Setup](/operations/setup.md)
