---
type: subsystem
title: Post-answer guards
description: "Checks that run after an agent writes and before the reader reads — arithmetic over the turn's tool results, never a second model opinion: the guard interface, `science` (citation closure, retraction, name correspondence) and `augustin` (the fact-check vocabulary computed from a verdicts record)."
tags:
  - tools
  - guards
  - runtime
generated:
  by: claude-code/claude-fable-5-1
  at: 2026-10-05
sources:
  - resource: lib/guards/index.ts
  - resource: lib/guards/science.ts
  - resource: lib/guards/augustin.ts
  - resource: lib/runtime/syndicateTurn.ts
---

# Post-answer guards

A guard is the engine's answer to a failure a prompt cannot hold. At
temperature 0 the same prompt returns the same sentence, so retrying a model
that wrote a plausible DOI or the wrong verdict word produces the same text
again. A guard does not re-ask: it reads the final answer together with every
plain-text tool result the turn produced, measures the one against the other,
and rewrites or annotates in place. Its notes land in the `[STATUS]` stream
and in `guardNotes` on the turn result, prefixed with the guard's name, so a
guard that ran clean is distinguishable from one that never ran.

## Where they run

`lib/runtime/syndicateTurn.ts` runs guards on every surface — the A2A server,
the REPL, the worker, the evals — after the answering turn and before the
reply ships. A syndicate names them in its root `guards:` list; guards of a
syndicate reached through `yaml_reference:` count too (`collectGuards()`). A
syndicate with guards never streams, because a guard reads the whole answer
before any of it leaves. A guard that throws is caught: the answer ships
unguarded with a `did not run` note, never blank.

## The contract

```ts
interface Guard {
  name: string;
  run(text: string, toolResultTexts: string[]): Promise<{ text: string; notes: string[] }>;
}
```

Guards are resolved by **name** from `GUARD_MAP` in `lib/guards/index.ts`,
never by module path — a YAML that could name a file to load would be a
code-loading vector. Adding one is a deliberate act in that file; a consumer
adds its own with `registerGuard()` (`{ override: true }` to replace a
built-in). An unregistered name is warned about and skipped. The map is
null-prototype so a name like `toString` cannot resolve off
`Object.prototype`.

## `science` — citations against the ledger

Run by `research.yaml`. An `IdLedger` is fed from the printed record blocks
the clinical-evidence tools emit ([evidence tools](/tools/evidence-tools.md));
only record blocks count, never a tool's echo of its own arguments, so a
model cannot launder an identifier into the ledger by calling a tool on it.
Three checks then run over the answer: identifier closure (every NCT, DOI,
PMID and PMCID in the answer must appear in a tool result from this run, or
it is marked `[UNVERIFIED IDENTIFIER …]` in place), a retraction lookup
through the corrections channel (a retracted work is annotated, and a lookup
that reached no source is noted rather than read as a clean bill), and name
correspondence (the acronym a sentence attaches to an identifier must be the
one the registry gave it).

## `augustin` — the fact-check vocabulary, computed

Run by the Augustin fact-checking syndicate (an Arbiter writing from an X
researcher's and a web researcher's reports). The web researcher ends its
report with a fenced JSON block:

```json
{"verdicts":[
  {"id":"C1","kind":"FACT","grade":"CONFIRMED","context":false,"sources":["apnews.com"]},
  {"id":"C3u","kind":"FACT","grade":"CONFIRMED","sources":["crooked.com"]},
  {"id":"C3","kind":"ARGUMENT","grade":"WEIGHED","for":1,"against":1,"sources":["washingtonpost.com"]},
  {"id":"C4","kind":"OPINION","grade":"SKIPPED"},
  {"id":"C5","kind":"FACT","grade":"UNCHECKED"}],
 "primary_read":false,
 "primary":"the episode itself (no transcript is published)",
 "sources":["apnews.com","washingtonpost.com","crooked.com"]}
```

FACT grades are `CONFIRMED` (with `context: true` when the record holds
something the claim leaves out), `MISLEADING`, `CONTRADICTED`, `UNVERIFIED`
(searched, nothing solid) and `UNCHECKED` (not reached in budget); an
ARGUMENT is `WEIGHED` with integer counts of documented events `for` and
`against`; an OPINION is `SKIPPED`. An id ending in `u` is the utterance half
of a claim ("X said it"), ruled as a fact whatever its kind. The guard parses
the **last** such block across all tool-result texts, tolerates missing
optional fields and never throws on a malformed one.

The Arbiter writes a FACT CHECK answer as a bold verdict line
(`**Fact check: <Word>**`), one or two sentences, then bullets opening with a
verdict word and closing with a source parenthesis and the claim id(s) in
brackets: `- Misleading: … (theguardian.com) [C2]`. On that shape the guard
applies, in order:

1. **Words are computed.** Each tagged bullet's word is replaced by the one
   its claim's verdict implies — FACT: `True` (`Missing context` when
   `context` is true), `Misleading`, `False`, `Unverified`, and `Unverified`
   plus ` (not reached)` for `UNCHECKED`; OPINION: `Opinion`; ARGUMENT: the
   model's `Supported` / `Unsupported` / `Unverified` stands, except that
   `for ≤ 1` is never `Supported` (it becomes `Unsupported`), no events
   either way is `Unverified`, and any other word is `Unverified`. A bullet
   citing several ids is ruled from the first non-`u` id; a tag the record
   does not hold leaves the word and records a note. The allowed words
   anywhere are True, Missing context, Misleading, False, Unverified,
   Supported, Unsupported and Opinion; a bullet opening with anything else
   (`Not checkable`, `Confirmed`, `Mixed`) is noted and, when tagged,
   rewritten.
2. **One Opinion bullet.** Later Opinion bullets fold into the first — texts
   joined with `; `, source parentheses unioned — and are dropped.
3. **The headline is arithmetic** over the tagged bullets' computed words:
   one bullet, its word (`Missing context` reads `True, but missing
   context`); all Opinion, `Opinion`; otherwise the non-Opinion words must
   all sit in one fact family — {True, Missing context}, {Misleading},
   {False}, {Unverified} — to carry it, and anything else, argument words
   included, is `Mixed`. The word in the verdict line is replaced; when tagged
   bullets exist with no verdict line, one is inserted first.
4. **Limits first.** When `primary_read` is false, the sentence directly under
   the verdict line is made to begin
   `The <primary> was not read; this rests on what could be found about it.`
   (a leading "the" in `primary` is folded; default `primary source`). A
   sentence there already saying something was `not read` is left alone.
5. **Sources must be in the record.** The allowed set is the block's
   `sources`, every verdict's `sources`, and every domain-like token and
   `@handle` in any tool-result text (the X report cites handles in prose).
   A domain in a bullet's source parenthesis outside that set gets
   ` [unsourced: <domain>]` appended after the parenthesis; nothing is
   deleted.
6. **Tags are stripped** from the shipped text.

An OVERVIEW answer (bullets, no verdict line, no tags) is touched only by
rule 4, the limit sentence prepended as the first line when `primary_read` is
false. A CONVERSATIONAL answer (no bullets) is left alone. With no verdicts
block the text ships unchanged, stray tags stripped, with the note
`no verdicts block; vocabulary not enforced`. Each correction is one note:
`C3 Supported→Unsupported (for=1)`, `headline True→Mixed`,
`limit line inserted`, `opinion bullets merged (2)`,
`unsourced domain example.com in C2`.

The rules are pure functions over strings — `parseVerdicts`, `computeWord`,
`computeHeadline`, `canonicalWord`, `applyGuard` — exported from
`lib/guards/augustin.ts` and re-exported from the `./guards` entry with an
`Augustin` infix, so a front end can mirror the checks and
`tests/guards.augustin.test.ts` exercises each rule on fixture answers. Why
the vocabulary is computed rather than prompted is
[ADR 0036](/decisions/0036-verdict-vocabulary-computed-by-guard.md).
