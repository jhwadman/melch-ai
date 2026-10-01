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

`@google/adk` is a **peer**, not a dependency: the consumer's app owns the ADK
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
