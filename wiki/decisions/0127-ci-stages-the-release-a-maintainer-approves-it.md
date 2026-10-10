---
type: decision
title: 'ADR 0127: CI stages the release on npm; a maintainer approves it with 2FA'
description: The tag-triggered release workflow runs `npm stage publish --provenance` through trusted publishing instead of `npm publish`. The staged tarball is not public until a maintainer runs `npm stage approve` with 2FA, so CI builds and attests every release while the publish itself stays a human act. Full CI publishing and laptop publishing were rejected.
tags:
  - decision
  - operations
  - security
status: stable
generated:
  by: claude-code/claude-opus-5-5
  at: 2026-10-10
sources:
  - resource: .github/workflows/release.yml
  - resource: wiki/decisions/0040-releases-from-tags-with-provenance.md
---

# ADR 0127: CI stages the release on npm; a maintainer approves it with 2FA

## Context

[ADR 0040](/decisions/0040-releases-from-tags-with-provenance.md) made a
version tag the release: `release.yml` builds from an empty `dist/` and
publishes with provenance through npm trusted publishing. Until the
trusted-publisher entry existed, every release from 1.0.0 to 1.2.0 failed at
that step and was published by hand from a laptop, which carries no
provenance and once shipped 40 stale modules (1.0.0).

The project's rule is that `npm publish` is a human act (CLAUDE.md), while
tagging is delegated (the orchestrating agent tags after CI is green). A CI
job that publishes on the tag would let a tag alone release to npm.

npm 11 adds staged publishing: `npm stage publish` uploads a tarball that is
not public, and a maintainer releases it with `npm stage approve <stage-id>`,
which demands proof of presence (2FA). A trusted publisher can be granted
"stage publish" without "publish". The owner configured the entry on
2026-10-09 with stage publish only.

## Decision

- `release.yml` runs `npm stage publish . --provenance --access public
  --ignore-scripts` (npm `^11.21.0`) in place of `npm publish`, through the
  existing trusted publisher (repository `jhwadman/melch-ai`, workflow
  `release.yml`, environment `npm`, permission "npm stage publish"). No npm
  token is stored.
- The job prints a notice naming the next step. A maintainer then runs
  `npx npm@11 stage list melchizedek-agents` and
  `npx npm@11 stage approve <stage-id>` with 2FA.
- A version already on npm is not staged again; the tag then only creates the
  GitHub Release and its SBOM, as before.

## Alternatives

- **Grant the trusted publisher "publish" and let CI publish on the tag.**
  Fully automatic, but a pushed tag alone would release, and tagging is
  delegated to an agent. Rejected: the publish stays a human act.
- **Keep publishing from a laptop.** No provenance, depends on the laptop's
  `dist/` and npm login (1.0.0's stale modules; expired logins). Rejected.

## Consequences

- Every release is built and attested by CI from the tagged commit; the
  maintainer's step is one approval, with nothing built locally.
- The GitHub Release is created when the tag runs, before the version is
  public on npm; it names the version the approval will publish.
- A staged version that is never approved stays private; `npm stage reject`
  discards it.
