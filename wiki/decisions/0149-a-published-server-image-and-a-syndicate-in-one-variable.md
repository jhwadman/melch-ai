---
type: decision
title: "ADR 0149: Every release publishes the server image, and a syndicate can arrive in one variable"
description: "The release workflow builds the Dockerfile for amd64 and arm64, boots it once, and pushes it to ghcr.io as melchizedek-serve with a provenance attestation and the digest on the Release; MELCHIZEDEK_AGENT_YAML carries a whole syndicate file base64-encoded, so a host that only takes environment variables runs one without a build, a mount or a database."
tags:
  - decision
  - operations
status: stable
generated:
  by: claude-code/claude-opus-5-5
  at: 2026-10-28
sources:
  - resource: .github/workflows/release.yml
  - resource: lib/envSyndicate.ts
  - resource: scripts/a2a_server.ts
  - resource: tests/envSyndicate.test.ts
---

# ADR 0149: Every release publishes the server image, and a syndicate can arrive in one variable

**Decided (2026-10-28):** A version tag publishes the server image beside the npm package: `ghcr.io/<owner>/melchizedek-serve:<version>` for linux/amd64 and linux/arm64, built from the repository's own `Dockerfile`, pushed only after it boots on amd64, attested, and pinned by the digest the Release carries. A deployment pulls a known image instead of building one, which is what the desktop app's one-click deploy needs (melch-app `plans/one-click-deploy.md`). For a host with no mount and no database, the syndicate is one environment variable, `MELCHIZEDEK_AGENT_YAML`, base64 of the file, written to a private agents directory at boot and loaded once so a bad one stops the boot.

**Instead of:** a per-syndicate image built on each deploy (slow, fragile, and a prompt change is a rebuild); the YAML as plain text in the variable (several hosts' forms and APIs mangle newlines; base64 survives all of them); a new `env:` source beside `registry:` in the loader (a second load path through the A2A app; writing a file reuses the file path's jail, validation and nested loading unchanged); Docker Hub (a second account and token; ghcr.io authenticates with the workflow's own token); cosign signatures (GitHub's build-provenance attestation already binds the digest to this workflow and tag)
**Open:** a server that re-reads its syndicate without a restart (today a new version in the registry or the variable takes a restart, as the config cache is per process); a size above one variable's limit except through the registry

How it works: [Setup paths](/operations/setup.md#path-c--a-container-30-min)
