# melchizedek-agents

An agent-orchestration framework: syndicates of agents declared in YAML, run
on Google ADK behind one turn runner, served over A2A, with memory, a
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
5. **`security-final-check`** — LAST, before commit. Report an explicit PASS.

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
  with `scripts/a2a_server.ts` as a thin bin. ADK stays behind that seam
  (ADR 0024); `tests/syndicateTurn.test.ts` is the boundary suite.
- The `exports` map in `package.json` and the `lib/index.ts` barrel are a
  versioned public API: a change to either needs a version bump and a
  `CHANGELOG.md` entry in the same change (`package-surface`).
- The wiki carries two layers: `npm run wiki:build` derives the entity graph
  into `wiki/.graph/graph.json` (never edited by hand); judgments asserted from
  prose go through `wiki_relate` into `wiki/.graph/relations.json`, which the
  build never touches.
- A choice between real alternatives gets an ADR in `wiki/decisions/`, in the
  same change. Supersede by adding a newer record, never by editing an old one.
- `npm publish` and pushing to `main` are human acts.
