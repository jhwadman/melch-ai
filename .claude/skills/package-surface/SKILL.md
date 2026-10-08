---
name: package-surface
description: The published npm surface of melchizedek-agents — the exports map, the barrel, the peer dependency, versioning and publishing. Use whenever a change alters what consumers can import, before bumping a version, and before any npm publish.
---

# The package surface

This repository is the published **`melchizedek-agents`** npm package. The
`exports` map in `package.json` and the `lib/index.ts` barrel are a **versioned
public API**: everything named there is something a consumer imports and
something you cannot move without breaking them.

## What counts as a surface change

Any of these, even when the behaviour is identical:

- a path added to, removed from, or repointed in `exports`
- a symbol added to, removed from, or renamed in the `lib/index.ts` barrel
- a changed signature or type on anything reachable through those
- a removed file a mapped path resolved to
- a bin added, removed or renamed
- a dependency moved between `dependencies`, `peerDependencies` and
  `devDependencies`

Each needs a **version bump** in `package.json` and a **CHANGELOG entry**,
written in the same change. Breaking changes go first in the entry, under
"Breaking — read before upgrading".

## The peer dependency is deliberate

Since 0.20.0 `@google/adk` is an **optional** peer (ADR 0102): the native
runtime, the default, loads none of it, and `lib/adkPeer.ts` is the one
module that tries to. Never import a value from `@google/adk` anywhere else
(a type-only import is fine); reach ADK through `adkPeer.ts`'s exports or
`requireAdk(feature)`. `tests/optionalAdk.test.ts` fails when a path the
native runtime needs loads it.

It is a **peer**, not a dependency: the consumer's app owns the ADK
instance so the model registry stays a singleton. Two ADK copies in one
process means a registry that does not see half its own models. Moving it to
`dependencies` would be a silent breaking change for every consumer
(ADR 0007).

## Before publishing

`npm publish` is irreversible: a published version number can never be reused.
Confirm, in order:

1. `npm test`, `npx tsc --noEmit` and `npm run build` are clean.
2. `npm pack --dry-run` lists what `files` says, and nothing else.
3. A packed tarball installs into an empty project and loads a shipped
   syndicate (the CI smoke job does this).
4. `version` is bumped and the CHANGELOG entry matches the actual diff.

Publishing is a maintainer's act: ask before running it, naming the version
and what changed in one line.

## How a release ships

A maintainer pushes a version tag (`git tag v0.18.0 && git push origin
v0.18.0`) on the merged release commit. `.github/workflows/release.yml` then
checks the tag against `package.json`, runs tsc and the tests, builds from an
empty `dist/`, publishes with npm provenance through trusted publishing (no
token stored), and creates the GitHub Release with the CHANGELOG section and
a CycloneDX SBOM. A laptop `npm publish` still works but carries no
provenance; prefer the tag. A tag for a version already on npm skips the
publish step and still creates the Release with its SBOM. The npm side needs a one-time trusted-publisher
entry for `release.yml` in the package settings on npmjs.com.
