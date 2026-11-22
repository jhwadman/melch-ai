---
name: commit-review
description: Review of one melch-ai change before it is committed or merged — fixing exactly what is under review, the contracts that must move together (the package surface, migrations, the turn seam, tool contracts, agent YAML, the derived wiki), the CI gates run locally, the eight checks only a change can get wrong, and a verdict of PASS or a list of blockers. Use on a staged change, a working-tree diff, a commit, a branch or a pull request, or when a request says "review this", "is this ready to commit", "check the diff", "before I merge". Runs after sync-wiki and before security-final-check, which stays last. Not for a whole-repo sweep, not for the threat model (use security-final-check), and not for writing the wiki (use sync-wiki).
---

# Commit review — one change, one purpose, nothing left behind

This skill owns no source files. It reads a change and returns a verdict. The
rules it checks against are the rules of thumb in `CLAUDE.md` and the area
skills (`agent-contract`, `tool-contract`, `model-routing`, `package-surface`).

## 1. Fix the change under review

Name exactly what is being reviewed before reading any of it.

| Under review | Read it with |
|---|---|
| the staged change | `git diff --cached` |
| the working tree | `git diff` and `git status --short` (untracked files are part of the change) |
| one commit | `git show <sha>` |
| a branch | `git diff main...HEAD` and `git log --oneline main..HEAD` |

Other worktrees (`git worktree list`) belong to other sessions; review only the
one named.

## 2. When to read outside the diff

Read beyond the changed lines only for these:

- **The package surface.** A change to the `exports` map in `package.json` or
  to the `lib/index.ts` barrel → a version bump and a `CHANGELOG.md` entry in
  the same change, and `README.md` / `DOCUMENTATION.md` where they describe it
  (`package-surface`).
- **The schema.** A file in `db/migrations/` → it is the next number, it is
  idempotent (re-applies cleanly), it records itself in
  `melchizedek_schema_version`, and `db/hardening.sql` still covers any new
  table. No prose doc repeats the DDL.
- **The turn seam.** `lib/runtime/syndicateTurn.ts` (`runSyndicateTurn`) or
  `lib/a2a/app.ts` → every surface that calls it, and
  `tests/syndicateTurn.test.ts`, the boundary suite.
- **A tool contract.** A `defineTool` schema (`lib/tools/toolContract.ts`) →
  both derived dialects (`declaration()` for the native loop,
  `toMcpToolDefinition()` for MCP) and every agent YAML that names the tool.
  Exposure changes only in `lib/toolRegistry.ts` plus the YAML (`tool-contract`).
- **An agent YAML** in `config/agents/` → `agent-contract`; a change to
  `config/agents/syndicateSchema.yaml` → `npm run schema:gen` regenerated
  `syndicate.schema.json` in the same change.
- **The wiki's derived layers.** `wiki/.graph/graph.json`, `wiki/index.md`
  and `wiki/log.md` change only through `npm run wiki:build`; a hand edit is a
  blocker. Asserted judgments go in `wiki/.graph/relations.json` via
  `wiki_relate`.

## 3. Run the gates

These mirror `.github/workflows/ci.yml`'s `test` job.

```bash
npx tsc --noEmit
```

```bash
npm test
```

```bash
node --disable-warning=DEP0040 --disable-warning=ExperimentalWarning --experimental-strip-types --experimental-test-coverage --test-coverage-include='lib/**' --test-coverage-lines=85 --test-coverage-branches=78 --test-coverage-functions=80 --test 'tests/**/*.test.ts'
```

```bash
npm run build && npm pack --dry-run
```

```bash
npm run wiki:check
```

`npm test` is offline (scripted models, no keys); a test that reaches a
provider is a blocker. Read the `npm pack --dry-run` file list: nothing that is
not for consumers.

**Only when `db/` or the storage code changed:** the `postgres` job. It needs
a local Postgres 17 with pgvector and the three Supabase roles
(`anon`, `authenticated`, `service_role`) created first; then
`npm run db -- apply --telemetry` twice against `DATABASE_URL` (the second
apply must be a no-op), and
`node --disable-warning=DEP0040 --experimental-strip-types --test tests/postgresStorage.test.ts`
with `TEST_DATABASE_URL` set. With no local Postgres, say so in the verdict;
CI's `postgres` job is then the proof.

**When a dependency changed:** `npm audit --omit=dev --audit-level=high`.

A failing gate is a blocker; quote the failing line. A gate not run is named in
the verdict.

## 4. What only a change can get wrong

| # | Check | A blocker when |
|---|---|---|
| 1 | **One purpose.** | the change mixes a feature with an unrelated refactor, or its description needs "and also" |
| 2 | **Both sides of a contract moved together.** | any coupling in §2 moved on one side only |
| 3 | **Saved records survive.** | a stored session event, a ledger row, a memory record or a table changes shape with no migration, or old sessions no longer read |
| 4 | **A fix carries its test.** | a bug is fixed without a `tests/` case that failed before the fix |
| 5 | **Nothing left behind.** | a `console.log`, a `debugger`, commented-out code, a `TODO` with no owner, a scratch file, a `.only`, a captured transcript |
| 6 | **A new dependency earns its place.** | a package was added for what the platform or thirty lines would do, or `@google/adk` became anything but a peer, or no ADR says why |
| 7 | **The description matches the diff.** | the summary claims something the diff does not do, or omits something it does |
| 8 | **Stale documents are updated in the same change.** | a wiki doc, a skill, `README.md`, `DOCUMENTATION.md` or `CLAUDE.md` now says something false; a real choice has no ADR in `wiki/decisions/` |

## 5. Findings, fixes, verdict

Each finding:

```
<blocker | should | note>  <file>:<line>  <what is wrong>  — <which check>  — <the fix>
```

Fix blockers that are mechanical and inside the change's purpose (a leftover
log, a stale doc line, a missed `wiki:build`), then re-run the gates. Do not
fix by widening the change; report instead.

End with exactly one of:

- `PASS` — every gate ran and passed, no blocker remains. List what was fixed
  during review and what was not checked. Then run `security-final-check`.
- `BLOCKERS` — the numbered list, each with its fix.

## Never

- Review a moving target: if the change shifts during review, start again from step 1.
- Pass a change whose gates you did not run, without saying so.
- Rewrite the author's approach when it is correct; review what is there.
- Add unrelated improvements to someone else's change.
- Commit, amend, push, tag, publish or merge as part of a review unless the owner asked.
- Revert, stash or discard uncommitted work that belongs to another session or worktree.
