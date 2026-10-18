---
type: decision
title: "ADR 0086: Skill scripts get a minimal environment the YAML extends by name"
description: "An approved skill script starts from an allowlisted environment extended by names under skills.env (secret-shaped names only under skills.secret_env), and its stdout and stderr are capped."
tags:
  - decision
  - tools
  - security
status: stable
generated:
  by: claude-code/claude-opus-5-5
  at: 2026-10-18
sources:
  - resource: lib/tools/skills/env.ts
  - resource: lib/tools/skills/executor.ts
  - resource: lib/tools/skills/tools.ts
  - resource: lib/tools/skillToolset.ts
  - resource: lib/syndicateSchema.ts
  - resource: tests/skillScriptEnv.test.ts
---

# ADR 0086: Skill scripts get a minimal environment the YAML extends by name

**Decided (2026-10-08):** A script's environment is an interpreter allowlist plus the variable names the YAML lists under `skills.env`; a secret-shaped name is accepted only under `skills.secret_env`. stdout and stderr are each capped at 20,000 characters.

**Instead of:** inherit and scrub by denylist, a per-entry secret flag, refusing secret names outright, a YAML-configurable cap, a byte cap

**Open:** skill scripts run unsandboxed as the server's user

How it works: [Skill harness](/tools/skill-harness.md)
