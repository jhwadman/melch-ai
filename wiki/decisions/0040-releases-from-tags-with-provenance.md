---
type: decision
title: "ADR 0040: Releases ship from a version tag with provenance and an SBOM; CI is pinned and scanned"
description: "A tag-triggered workflow publishes through npm trusted publishing with provenance and a CycloneDX SBOM; actions are SHA-pinned, images digest-pinned, CodeQL runs on every PR, and lib/ has a coverage floor."
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
  - resource: .github/workflows/codeql.yml
  - resource: .github/workflows/ci.yml
  - resource: .github/dependabot.yml
---

# ADR 0040: Releases ship from a version tag with provenance and an SBOM; CI is pinned and scanned

**Decided (2026-10-06):** A version tag is the release. CI publishes it through npm trusted publishing with provenance and attaches a CycloneDX SBOM to the GitHub Release. Third-party actions are pinned to SHAs and images to digests, CodeQL runs on every PR, and `lib/` has a coverage floor.

**Instead of:** an `NPM_TOKEN` secret, publishing on merge to `main`, tag-pinned actions
**Superseded by:** [ADR 0127](/decisions/0127-ci-stages-the-release-a-maintainer-approves-it.md) (the publish is staged, and a maintainer approves it with 2FA)

How it works: [Setup](/operations/setup.md)
