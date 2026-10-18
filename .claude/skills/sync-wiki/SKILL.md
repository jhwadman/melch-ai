---
name: sync-wiki
description: Bring the knowledge bundle up to date after a change works — every touched subsystem's doc in the present tense, the derived layers rebuilt, judgments asserted, and an ADR for any real choice. Use after every change, before security-final-check.
---

# Sync the wiki

`wiki/` describes the **present state**, always. No "previously", no "we
changed X to Y", no dated narrative in a subsystem doc — a reader arriving
today should not be able to tell a doc was edited. History lives in git and in
the decision records.

## What to update

1. **Every doc whose subsystem the change touched.** A change that spans
   subsystems updates all of them — integration facts live in the seams.

2. **Rebuild the derived layers.** Never hand-edit them.

   ```bash
   npm run wiki:build     # entity graph + indexes + log + lint
   npm run wiki:check     # lint only
   ```

3. **Assert what the parser cannot see.** A judgment read out of prose — an
   agent depending on a tool, a decision constraining a module — is asserted
   with evidence through `wiki_relate` into `wiki/.graph/relations.json`.

4. **Record the judgment call.** A choice between real alternatives gets an
   ADR in `wiki/decisions/`, in the same change, as short as this:

   ```markdown
   # ADR NNNN: <the decision, ~12 words>

   **Decided (YYYY-MM-DD):** <1–3 sentences: the choice, not how it works>

   **Instead of:** <rejected alternatives, a few words each>
   **Supersedes:** [ADR NNNN](/decisions/NNNN-….md) (<which part>)
   **Open:** <what is deliberately left open>

   How it works: [<subsystem doc>](/<dir>/<doc>.md)
   ```

   Facts, defaults, env vars, algorithms and file paths go in the subsystem
   doc (step 1), never in the ADR; if a doc already says it, the ADR does not.
   A later choice is a **new** record; the earlier one gains only a
   `**Superseded by:**` line (and `status: deprecated` when replaced
   entirely). Remove an `Open:` item in the change that closes it.

5. **Keep the other copies of a fact in step.** The SQL schema has one home
   (`db/migrations/`); the prose docs point to it. The package surface is
   described in `README.md`, `DOCUMENTATION.md` and `CHANGELOG.md` — a change
   to what consumers import touches all three.

## Done means

The code works, `npm run wiki:check` is clean, every touched subsystem's doc
describes the present state, and judgment calls have an ADR. Then
`security-final-check`.
