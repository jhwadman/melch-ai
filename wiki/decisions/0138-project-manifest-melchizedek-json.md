---
type: decision
title: "ADR 0138: A project manifest, melchizedek.json, joins the agents-directory chain"
description: "A repository declares its agents folder, exact engine pin and per-file shipping records in a melchizedek.json at its root; the engine finds it without crossing the repository root and reads it after MELCHIZEDEK_AGENTS_DIR, so deployments are unchanged."
tags:
  - decision
  - configuration
  - setup
status: stable
generated:
  by: claude-code/claude-opus-5-5
  at: 2026-10-18
sources:
  - resource: lib/project.ts
  - resource: lib/doctor.ts
  - resource: tests/project.test.ts
---

# ADR 0138: A project manifest, melchizedek.json, joins the agents-directory chain

**Decided (2026-10-18):** A repository that holds syndicates may carry a `melchizedek.json` at its root naming its agents folder, the exact engine version it is written for, and how each file ships. The engine reads it as the third step of the agents-directory chain, after the explicit option and `MELCHIZEDEK_AGENTS_DIR`, and never above the repository root; the doctor fails `--check` on a pin mismatch. It is the shared contract between a consumer repository, the engine's bins and the desktop app's projects.

**Instead of:** a forced folder layout (`melch/`, `config/agents` everywhere), `.melchizedek/project.json`, a `melchizedek` key in `package.json` (not every consumer is a Node project), a semver range for the engine, the manifest ahead of the env variable, walking past the repository root
**Supersedes:** none
**Open:** the desktop app's project model (melch-app `plans/repo-native-projects.md`); `melchizedek-registry publish` reading `publish.id`; suites as files and `melchizedek-test`; generated deliverables

How it works: [Projects and melchizedek.json](/operations/projects.md)
