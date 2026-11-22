# melchizedek-agents

An agent-orchestration framework: syndicates of agents declared in YAML, run
on the engine's own agent loop behind one turn runner, served over A2A, with memory, a
telemetry ledger and a knowledge-bundle wiki. This repository is the source of
truth for the engine and the published npm package `melchizedek-agents`.

## Mandatory workflow — every change

Skills in `.claude/skills/` define the lifecycle of a change:

1. **`wiki-first`** — BEFORE designing or coding. Read `wiki/index.md`, query
   `wiki/.graph/graph.json` before grepping, and read the directory that owns
   what you are touching.
2. The skill that owns the area: **`agent-contract`** (a syndicate YAML),
   **`tool-contract`** (a tool, its schema, its exposure), **`model-routing`**
   (a model id, a provider, spend), **`package-surface`** (anything a consumer
   imports).
3. **`secrets-hygiene`** — BEFORE any task touching `.env` or a key.
4. **`sync-wiki`** — AFTER the change works. The wiki IS the record; there is
   no separate design log. Rebuild the derived layers.
5. **`commit-review`** — the diff against its contracts and CI's gates; PASS or blockers.
6. **`security-final-check`** — LAST, before commit. Report an explicit PASS.

Work spanning sessions, phases or a release follows **`phase-implementation`** (plans in `plans/`, the owner's three gates).

**`owasp-security`** is the standard's framing behind the gate — background
reading for a change that opens a new surface.

## Rules of thumb

- `npm test` (offline: scripted models, no provider calls) and
  `npx tsc --noEmit` must both be clean.
- The SQL schema lives in ONE place: the numbered, idempotent migrations in
  `db/migrations/` (each records itself in `melchizedek_schema_version`),
  applied in order by `melchizedek-db apply`, followed by `db/hardening.sql`.
  The prose docs point to them and never repeat the DDL.
- Every surface runs turns through `lib/runtime/syndicateTurn.ts`
  (`runSyndicateTurn`); the A2A server is `lib/a2a/app.ts` (`createA2AApp`)
  with `scripts/a2a_server.ts` as a thin bin. The engine's own loop is the one
  runtime behind that seam (ADR 0024, ADR 0107); `tests/syndicateTurn.test.ts` is the boundary suite.
- The `exports` map in `package.json` and the `lib/index.ts` barrel are a
  versioned public API: a change to either needs a version bump and a
  `CHANGELOG.md` entry in the same change (`package-surface`).
- `wiki/.graph/graph.json` is derived by `npm run wiki:build` and never
  edited by hand; asserted judgments go through `wiki_relate` into
  `wiki/.graph/relations.json`, which the build never touches (`sync-wiki`
  has the rest).
- A choice between real alternatives gets an ADR in `wiki/decisions/` in the
  same change; how the thing works goes in the subsystem doc, never in the
  ADR. `sync-wiki` has the shape and the supersede/`Open:` rules.
- Approving a staged release (`npm stage approve`, ADR 0127), any hand
  `npm publish`, and pushing to `main` are human acts.
