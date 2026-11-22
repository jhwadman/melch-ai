---
name: phase-implementation
description: Running multi-session or multi-phase work on melch-ai — drafting the plan in plans/ in the repo's shape, stopping at the owner's three gates (plan, merge, release), splitting a phase into sessions with disjoint file ownership, the session brief, and the lead verifying each piece against acceptance checks instead of the session's report. Use when a request spans more than one session or subsystem, implements a plan in plans/, carries an open item from an ADR, or says "plan this", "implement phase", "roadmap", "epic", "split this up", "use subagents", "parallel sessions", "cut a release". Not for a single-file change or a one-session fix (do it directly, then commit-review), and not for recording one decision (use sync-wiki's ADR shape).
---

# Phase implementation — plan, gate, split, verify

This skill owns no source files. It governs how a large change moves from a
plan in `plans/` to a released version. Decisions live as ADRs in
`wiki/decisions/` (shape in `sync-wiki`); how things work lives in the
subsystem docs.

## The owner's three gates

| Gate | The lead stops and presents | The owner decides |
|---|---|---|
| **Plan** | the plan file in `plans/` with its open questions, each carrying a recommendation | scope, answers, go |
| **Merge** | every phase verified, the gates' output, what was not verified | merge or change |
| **Release** | the version, the `CHANGELOG.md` entry, what a consumer must change | ship |

Nothing is built before the plan gate, merged before the merge gate, or
tagged before the release gate. Pushing to `main`, a tag, `npm stage approve`
(ADR 0127: CI stages the release, a maintainer approves it with 2FA) and any
hand `npm publish` are the owner's acts. Ask for each one; approval at one gate
does not carry to the next.

## 1. Read before planning

`wiki-first` first: `wiki/index.md`, the graph, the docs for every subsystem
the work touches, and `wiki/decisions/` for what is settled or still `Open:`.
Then the code. Mark each claim in the plan **(verified)** — read in code this
pass — or **(verify)** — inferred, naming where to look.

## 2. Draft the plan

One file, `plans/<topic>.md`, titled with the topic and opening with
`Plan, <date>. Owner: <repo>; <who follows>.` Sections in order:

1. **The problem** — what is wrong or missing, with a table
   `Part | Where | Problem` of what exists today (file paths, verified).
2. **The design** — the one idea, as ordered layers or moves; what was
   considered and not used, and why.
3. **Phase 0 … Phase N** — each `## Phase n: <name> (<size>)`, with the files
   it changes, its tests, and what it ends with that can be run.
4. **Cross-cutting** — **Docs** (each wiki doc that moves, via `sync-wiki`),
   **Package surface** (additive = minor, breaking = major; `package-surface`),
   **Security** (what `security-final-check` will ask), **Order and
   dependencies** (which phases can run in parallel and where they meet),
   **Estimate**, **Out of scope**.
5. **Open questions** — each with a *Recommendation:*.
6. **Baseline** — numbers measured before Phase 1, filled by Phase 0 when the
   work claims an effect.

Sizes are focused working days, not calendar promises. A real choice the plan
makes becomes an ADR when it is built, not before.

## 3. Stop for the owner's review

Present the plan and wait. Carry on only with work that does not depend on an
open answer.

## 4. Split into sessions

1. **The lead writes the contract first**: the types, the `defineTool`
   schemas, the YAML keys in `config/agents/syndicateSchema.yaml`, the
   migration number. A session never invents a shared interface.
2. **Disjoint file ownership.** Each session owns a list of paths; no two
   write the same file. Contract files are read-only to all of them.
   Migration numbers are assigned by the lead.
3. **Order by dependency.** A consumer starts after its producer is verified.
4. **One purpose per session**, sized to finish and verify in one sitting.

### The session brief

```
Build <piece> of plans/<topic>.md, Phase <n>.
Read first: <wiki docs>, <contract files>. Load skills: <names>.
You own: <paths>. Do not edit: <contract files and every other session's paths>.
In order: <numbered steps>.
Done means: npx tsc --noEmit and npm test pass; <named acceptance checks> hold;
  the wiki doc for what you changed is updated and npm run wiki:check is clean.
Report: files written, commands run with their output, anything you could not verify.
Do not: commit, push, tag, publish, add a dependency, change the contract,
  touch another session's files.
```

A brief names its acceptance checks by their source (the plan's phase, a test
file), never "make it work".

## 5. Verify each piece as the lead

A session's report is a claim. Before accepting it:

1. Run the gates in `commit-review` §3 yourself and read the output.
2. Read the diff against the brief's ownership list; anything outside it is a finding.
3. Run `commit-review`, then `security-final-check`.

A piece that fails goes back to its session with the failing check quoted.

## 6. Merge in order, then prepare the release

Merge in dependency order, re-running the gates after each. Update the plan
file's phase status and fill **Baseline** with measured results. At the
release gate: the version bump and `CHANGELOG.md` entry (`package-surface`),
then the network. Two workspace skills cover that — `active-work-inventory`
(every branch, worktree and session accounted for before a release) and
`lyceum-sync` (every mirror of a fact in melchizedek-deploy, melch-app, melch
and lyceumagents). They live in `~/Desktop/Git/.claude/skills/` and load only
in a session rooted at `~/Desktop/Git`; from a session rooted here, read their
`SKILL.md` files directly.

## What holds at every stage

- The contract changes only through the lead, and every session is told.
- A convention the work creates is written into its wiki doc and its skill in the same change.
- An unanswered owner question is listed, never guessed and presented as decided.
- Scratch files are deleted when the work is done.

## Never

- Start building before the plan gate, or treat an earlier approval as covering a later gate.
- Give two sessions the same file, or let a session edit a contract file.
- Report a phase done on the strength of a session's own report.
- Push to `main`, tag, run `npm stage approve` or `npm publish` without the owner's word at that gate.
- Hide what was not verified.
