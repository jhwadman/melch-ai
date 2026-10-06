# Contributing

Thank you for helping. This page is the short version; the repository's own
working rules are in [CLAUDE.md](./CLAUDE.md) and `.claude/skills/`, and they
apply to human contributors too.

## Before you start

- **A security issue?** Do not open an issue or a PR. Report it privately per
  [SECURITY.md](./SECURITY.md).
- **A large change?** Open an issue first, so the design can be agreed before
  you write it. A choice between real alternatives gets an ADR in
  `wiki/decisions/` in the same PR.
- **Read the wiki first.** `wiki/index.md` maps every subsystem, and
  `wiki/decisions/` explains why things are the way they are.

## The checks a PR must pass

```bash
npm ci
npx tsc --noEmit
npm test            # offline: scripted models, no keys, no network
npm run wiki:check  # after a change to wiki/ or anything it describes
```

CI also runs the Postgres integration suite, `npm audit`, CodeQL and a
coverage floor for `lib/`.

## What a good PR has

- **Tests** that fail without the change and pass with it.
- **Docs in the present tense:** the wiki page for each subsystem you
  touched, and `DOCUMENTATION.md` where users meet it. Rebuild the derived
  layers with `npm run wiki:build`.
- **A CHANGELOG entry** for anything a consumer of the package can see.
  A change to the `exports` map or the `lib/index.ts` barrel also needs a
  version bump ([VERSIONING.md](./VERSIONING.md)).
- **No secrets**, ever: not in code, tests, fixtures or logs.

## Licence

By contributing you agree that your contribution is licensed under the
project's MIT licence.
