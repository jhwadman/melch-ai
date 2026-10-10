---
name: package-surface
description: The published npm surface of melchizedek-agents — the exports map, the barrel, the dependencies, versioning and publishing. Use whenever a change alters what consumers can import, before bumping a version, and before any npm publish.
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

## The dependencies are deliberate

The package has **no Google ADK dependency** of any kind (ADR 0107): 1.0.0
removed the ADK runtime, its optional peer and its dev dependency, and every
turn runs on the engine's own agent loop. Do not add it back, as a value
import, a type import, or an entry in `package.json`.

`@google/genai` is a **dependency**, pinned exact, and only three things
reach it: the Gemini adapter (`lib/models/geminiAdapter.ts`, with the genai
mapping it speaks in `lib/models/genaiMapping.ts`), the image tools
(`generate_image`, `inspect_image`, and `x_api_search`'s photo
transcription) and memory embeddings (`lib/memory/providers.ts`).
`tests/importGraph.test.ts` enforces that list from source: a new module
that imports `@google/genai`, or any other `@google/*` package, fails it.
Route a new Gemini need through one of those modules, or add it to the
suite's allowlist with its reason in the same change.

The peers (redis, the Bedrock and Vertex SDKs, `@azure/identity`) are
**optional**: a consumer installs one only for the feature that loads it.
Moving a package between `dependencies` and `peerDependencies` is a surface
change (above).

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
empty `dist/`, stages the tarball on npm with provenance through trusted
publishing (no token stored), and creates the GitHub Release with the CHANGELOG section and
a CycloneDX SBOM. A laptop `npm publish` still works but carries no
provenance; prefer the tag. A tag for a version already on npm skips the
publish step and still creates the Release with its SBOM. The npm side needs a one-time trusted-publisher
entry for `release.yml` (environment `npm`, permission "npm stage publish")
in the package settings on npmjs.com. A staged version goes public only when a
maintainer runs `npx npm@11 stage approve <stage-id>` with 2FA (ADR 0127).
