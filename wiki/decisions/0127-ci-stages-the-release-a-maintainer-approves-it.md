---
type: decision
title: "ADR 0127: CI stages the release on npm; a maintainer approves it with 2FA"
description: "The tag-triggered release workflow stages the package with provenance, and a maintainer publishes it with npm stage approve under 2FA."
tags:
  - decision
  - operations
  - security
status: stable
generated:
  by: claude-code/claude-opus-5-5
  at: 2026-10-18
sources:
  - resource: .github/workflows/release.yml
  - resource: wiki/decisions/0040-releases-from-tags-with-provenance.md
---

# ADR 0127: CI stages the release on npm; a maintainer approves it with 2FA

**Decided (2026-10-10):** The release workflow runs `npm stage publish --provenance` through trusted publishing instead of `npm publish`; a staged version goes public only when a maintainer runs `npm stage approve` with 2FA, so CI builds and attests every release while the publish stays a human act.

**Instead of:** granting the trusted publisher full publish on the tag, publishing from a laptop
**Supersedes:** [ADR 0040](/decisions/0040-releases-from-tags-with-provenance.md) (CI's direct `npm publish` step)

How it works: [Setup](/operations/setup.md)
