---
type: decision
title: 'ADR 0040: Releases ship from a version tag, with npm provenance and an SBOM; CI is pinned and scanned'
description: A tag-triggered workflow publishes through npm trusted publishing with provenance and attaches a CycloneDX SBOM to the GitHub Release; actions are pinned to SHAs, images to digests, CodeQL runs on every PR, and lib/ has a coverage floor.
tags:
  - decision
  - operations
  - security
status: stable
generated:
  by: claude-code/claude-opus-5-5
  at: 2026-10-06
sources:
  - resource: .github/workflows/release.yml
  - resource: .github/workflows/codeql.yml
  - resource: .github/workflows/ci.yml
  - resource: .github/dependabot.yml
---

# ADR 0040: Releases ship from a version tag, with npm provenance and an SBOM; CI is pinned and scanned

## Context

An enterprise readiness audit (6 October 2026) could not trace a published
version to its source: releases were published by hand from a laptop, npm
showed registry signatures but no provenance attestation, there were no
version tags or GitHub Releases, and no SBOM (B2). CI ran tests and
`npm audit` but no static analysis, pinned actions by tag, pinned no
container image, and measured no coverage (OPS-05, OPS-06, OPS-08).

## Decision

- **A version tag is the release.** `release.yml` runs on `v*.*.*`: it
  refuses a tag that differs from `package.json`, runs tsc and the tests,
  builds from an empty `dist/`, and publishes with `--provenance` through
  npm trusted publishing, so no npm token is stored in the repository. It
  generates a CycloneDX SBOM (`npm sbom`, production dependencies) and
  creates the GitHub Release with the CHANGELOG section and the SBOM.
  The job runs in a GitHub environment named `npm`, where a maintainer can
  require approval.
- **Pinned inputs.** Every third-party action is pinned to a commit SHA with
  its release in a comment; the Dockerfile's base image, the compose
  services and the CI Postgres service are pinned by digest. Dependabot's
  `github-actions`, `docker` and `docker-compose` ecosystems propose updates.
- **CodeQL** (`security-extended`) on every PR, every push to `main`, and
  weekly.
- **A coverage floor** for `lib/` on the Node 24 job: lines 85, branches 78,
  functions 80, a few points under the measured 87.8 / 82.1 / 83.2.

## Alternatives

- **An `NPM_TOKEN` secret.** Works, but a long-lived publish token in CI is
  the credential trusted publishing exists to remove, and it carries no
  OIDC identity for the provenance statement.
- **Publishing on merge to `main`.** It would publish versions nobody chose
  to release; the tag keeps publishing a deliberate act.
- **Tag-pinned actions with Dependabot.** A moved tag runs new code without
  review; a SHA cannot move.

## Consequences

- One-time setup by a maintainer on npmjs.com: a trusted publisher for
  `jhwadman/melch-ai`, workflow `release.yml`, environment `npm`. Until
  then the publish step fails and nothing is published.
- Branch protection should require the new checks (`codeql`, the Postgres
  job, the audit job); that is a repository setting, not a file.

*2026-10-10:* the publish step now stages the tarball and a maintainer approves it with 2FA ([ADR 0127](/decisions/0127-ci-stages-the-release-a-maintainer-approves-it.md)); the rest of this record stands.
