---
type: decision
title: 'ADR 0036: A fact-check verdict vocabulary is computed by a guard, not applied by the prompt'
description: The Augustin desk's verdict words, headline, limit line and source closure are derived mechanically from a researcher's structured verdicts block by the `augustin` post-answer guard; the Arbiter's prompt tags each bullet with a claim id and the guard writes the words — rather than ever more prompt rules, a second judge model, or a structured-output schema on the answer.
tags:
  - decision
  - guards
  - runtime
status: stable
generated:
  by: claude-code/claude-fable-5-1
  at: 2026-10-05
sources:
  - resource: lib/guards/augustin.ts
  - resource: lib/guards/index.ts
  - resource: tests/guards.augustin.test.ts
---

# ADR 0036: A fact-check verdict vocabulary is computed by a guard, not applied by the prompt

## Context

The Augustin syndicate is a fact-checking desk: an Arbiter briefs an X
researcher and a web researcher and writes a ruling from their reports,
claim by claim, in a fixed vocabulary — True, Missing context, Misleading,
False, Unverified for a fact; Supported, Unsupported, Unverified for an
argument; Opinion for what no record settles — under a bold headline
computed over the claims, with what the record did not reach stated first.

Three days of live sessions produced the same family of failures across five
different Arbiter models: the researcher's grade written as the verdict
("Confirmed", "Contradicted"), a variant of the desk's own ("Not checkable",
"True, but unproven"), an argument with one documented event behind it
called Supported, two Opinion bullets, the limit sentence after the
findings, a mixed record headlined True, and a source domain in a bullet that
neither report produced. Each got a prompt rule; the rule set is now the
longest part of the Arbiter's instruction and the failures still recur,
because at temperature 0 a prompt-level failure reproduces itself exactly and
a rule about a word does not change the token a model prefers.

The engine already has the right seam. A post-answer guard
([post-answer guards](/tools/post-answer-guards.md)) receives the final text and
every tool-result text of the turn, and the `science` guard has shown since
2026-09-08 that arithmetic over tool results — set difference, a lookup — holds
where prompt rules did not.

## Decision

1. **The vocabulary is mechanical.** The web researcher ends its report with
   a fenced JSON `verdicts` block (kind, grade, `context`, `for`/`against`
   counts, sources, `primary_read`, `primary`). The Arbiter tags each bullet
   with the claim id it rules on. The `augustin` guard
   (`lib/guards/augustin.ts`) maps each tag to its word, computes the
   headline from the words, puts the limit sentence directly under the
   verdict line when the primary source was not read, merges stray Opinion
   bullets into one, marks any cited domain the record never produced, and
   strips the tags. The model chooses what to say; the record chooses the
   word.
2. **Arguments keep the model's weighing within bounds.** The guard does not
   decide whether an argument is supported — that is the Arbiter's job — but
   it refuses `Supported` on `for ≤ 1` (one event is never a pattern) and
   rules `Unverified` when nothing was counted either way.
3. **Nothing is deleted.** The guard rewrites a word, inserts a sentence,
   appends a marker, folds Opinion bullets together; it never removes a
   finding. A reader is owed the reason, in place.
4. **Fail static.** No verdicts block, a malformed one, an unknown tag, an
   answer in another shape (overview, conversation): the text ships as
   written, tags stripped, with a note. The guard never throws into the turn.
5. **The rules are pure functions**, exported so the front end that shows
   the answer can mirror them and so each rule has an offline test.

## Alternatives considered

- **More prompt rules.** Rejected: the rule set is where the failures came
  from, and each new rule costs attention the model needs for the ruling.
- **A second model as judge** (a critic pass over the answer). Rejected: it
  doubles latency and spend per answer, it is another opinion rather than
  arithmetic, and the `science` guard's lesson is that a re-ask returns the
  same sentence.
- **Structured output on the Arbiter** (a JSON answer the front end
  renders). Rejected for now: the Arbiter runs on a Gemini model whose
  grounded search and a response schema do not combine in one call, and the
  answer's prose — quotes, the true version, the base of a figure — is the
  product; a schema flattens it. The verdicts block on the *researcher*
  gets the structure where it is cheap.
- **Making the Arbiter emit the verdicts block itself.** Rejected: the word
  must come from the agent that read the sources, not the one that writes
  the ruling; otherwise the guard enforces the Arbiter's grade against
  itself.

## Consequences

- `GUARD_MAP` ships two guards, `science` and `augustin`; the `./guards`
  entry re-exports the Augustin pure functions with an `Augustin` infix
  (`applyAugustinGuard`, `computeAugustinWord`, `computeAugustinHeadline`,
  `parseAugustinVerdicts`, `canonicalAugustinWord`,
  `AUGUSTIN_VERDICT_WORDS`). A CHANGELOG entry records the addition.
- The syndicate's YAML must now ask the web researcher for the block and the
  Arbiter for the tags, and list `guards: [augustin]` at its root; until it
  does, the guard notes `no verdicts block; vocabulary not enforced` and
  changes nothing but stray tags.
- The headline arithmetic is the contract's: a single argument bullet
  headlines its own word (`Supported` / `Unsupported`), and several
  argument bullets headline `Mixed`, because the desk's headline vocabulary
  has no argument family. An Opinion bullet beside any ruling bullet
  headlines `Mixed`: a piece whose weight is opinion is never True on the
  facts it cites along the way, and the sentence under the line says which
  part is record and which is the speaker's view.
- A sentence the model wrote in its own words that says something was
  `not read` satisfies the limit rule; the fixed sentence is inserted only
  when no such sentence sits under the verdict line.
