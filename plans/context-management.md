# Context management on the native loop

Plan, 2026-11-02. Owner: the melch-ai repo; the app and melch.ai follow.

## The problem

Long-term memory is bounded (10 recalled records, dated, superseded values
marked). Conversation history is not. Unless a syndicate sets `context:`,
every model step resends the whole conversation, every tool result in it,
at the full input price, until the model's window fills. No shipped
syndicate sets `context:`, and nothing in the loop recovers from an
overflow.

What exists today, and what each part gets wrong:

| Part | Where | Problem |
|---|---|---|
| Compaction | `lib/runtime/native/compaction.ts` | Opt-in; delegate orchestrators only (`lib/syndicateSchema.ts` ~1026). The summary reads text parts only (`textOf`), so tool calls and results vanish. The prompt asks for "concise" with no structure, and each summary folds the last in, so facts erode. A failed summary fails the turn. |
| History projection | `lib/runtime/native/history.ts` | Every stored tool result goes to the model verbatim until a compaction removes it. |
| Tool result caps | `lib/tools/tool.ts` `capResult`, `lib/tools/toolContract.ts` `maxResultChars` | 20,000 chars on MCP and OpenAPI tools; off on `defineTool` tools unless set. |
| Prompt caching | `lib/models/claudeAdapter.ts` | Reads `cache_read_input_tokens`; never sends `cache_control`. |
| Prefix stability | `lib/runtime/native/request.ts` | `preload_memory` and other per-turn instruction text land in the system prompt, which sits before the history in every provider's cache prefix, so a changed recall misses the whole history. |
| Overflow | `lib/models/errorResponse.ts`, `lib/runtime/native/step.ts` | A "prompt too long" error is a plain 400: not retryable, not recognised, no compaction forced. Ollama truncates silently instead. |
| Window sizes | `lib/models/*` | No table of context windows per model, so there is nothing to derive a default threshold from. |

ADR 0078 made compaction a rule-for-rule port of ADK's compactor. That
constraint is gone: the engine is ADK-independent, so the stored event
shape stays (old sessions still read) and the behaviour changes.

## The design

Five layers, each cheaper than the next, applied in order:

1. **Cache the prefix.** Stable system prompt and tools; volatile per-turn
   text goes at the end of the history, not in the system prompt. Claude
   gets `cache_control`. Costs nothing per step.
2. **Mask old tool results.** The projection replaces a result outside the
   verbatim tail with a short stub carrying a reference. The stored event
   is untouched. No model call.
3. **Compact with a structured, anchored summary.** Past a threshold the
   cut span is merged into a persistent summary with fixed sections,
   including tool activity. A failed summary skips compaction instead of
   failing the turn.
4. **Make it restorable.** Stubs and the summary's artifact list carry
   references; a `recall_tool_result` tool reads the original back.
5. **Turn it on by default, and recover from overflow.** Thresholds come
   from a per-model window table; a context-overflow error forces a
   compaction and one retry.

Provider-side compaction (Anthropic `compact_20260112`, OpenAI
`context_management`) is not used as the core: it is per provider, OpenAI's
result is opaque, and neither survives `fallback_model` moving a
conversation to another provider. Nothing stops an adapter adding it later
as an optimisation under the same thresholds.

## Phase 0: baseline (half a day)

Numbers first, so each phase shows its effect.

- A script, `scripts/context-report.ts`, over the ledger's turn and
  llm.request rows: per chat, input tokens per step against step index,
  cache-read share, steps per turn, and the share of input that is tool
  results. Run it on the owner's own app database and on a scripted 30-turn
  chat (`tests/e2e`, a syndicate with web tools).
- Record the two curves in this file under "Baseline" before Phase 1 lands.
- The metric that matters is tokens per task, not per request: a 30-turn
  chat's total input tokens, and whether the last turn still answers probe
  questions about the first (Phase 3's eval).

## Phase 1: prompt caching and a stable prefix (2 days)

**Contract.** `ModelRequest` gains `turnNotes?: string`: text the loop wants
the model to read this step that is not part of the durable instruction
(recalled facts, a workflow's per-turn input note). Each adapter places it
where its provider caches best: Claude, GPT, Gemini, DeepSeek and Kimi
cache prefixes, so it goes after the history, as a `SystemMessage` before
the last user message (the contract already defines that role for "a
turn-scoped note"), or appended to the last user message on a provider with
no in-history system role (`systemText` already handles that fallback).
`system` keeps only text that is the same from turn to turn.

**Request builder** (`lib/runtime/native/request.ts`): the
`instructionTexts` pass sorts each tool's text into `system` or `turnNotes`
by a flag on `InstructionTool` (`volatile: true`). `preload_memory` is
volatile. Few-shot examples and an own tool's note are stable. The skills
index is stable. Audit `injectSessionState`: a `{state_key}` placeholder
that changes per turn moves the instruction into the volatile class for
that agent; log it once per run so the owner can see why caching misses.

**Stability audit**, with a test that renders the same agent's request
twice across two turns and asserts the system string and tool declarations
are byte-identical: no dates or times in identity or instruction text;
tool declarations serialised in declaration order with sorted keys
(`contractToolDeclaration`); toolsets expanded in a fixed order; no
per-request ids in the prefix.

**Claude adapter.** Send top-level `cache_control: { type: 'ephemeral' }`
on every request (automatic breakpoint on the last cacheable block). Gate
by `endpoint.platform`: Anthropic and Vertex and Bedrock support it, but
confirm against each before enabling; a platform that rejects the field
gets none. Explicit per-block breakpoints are not used, so the four-slot
limit is never hit. TTL stays the default; a 1-hour TTL is a later knob.

**Other adapters.** Nothing to send: OpenAI, Gemini 2.5+, DeepSeek and
Kimi cache prefixes automatically. Ollama keeps its KV cache across
requests only with an unchanged prefix, which the stability work gives it.

**Telemetry.** No new span attribute: the ledger already stores
`input_tokens` and `cache_read_tokens` per llm.request, and
`scripts/context_report.ts` divides them. The app's model-call row shows
the cached share next to input tokens from the same two columns (Phase 6).

**Done (2026-11-02):** `turnNotes` on the contract and in every adapter;
`InstructionTool.volatile`, set on `preload_memory`; the request builder's
split; `cache_control` on Anthropic's own API; `tests/promptPrefix.test.ts`.
Not done: the `{state_key}` audit (an instruction whose placeholder changes
per turn still breaks the prefix, silently), and the stability test over
every shipped example and template (it covers one scripted syndicate).

**Acceptance.** On Claude, from the second step of a turn and the second
turn of a chat, `cacheReadTokens >= 0.8 × inputTokens` in the e2e chat.
The stability test passes for every shipped example and template.

**Risks.** Moving recalled facts out of the system prompt may change how
strongly a model weighs them; Phase 3's probe eval covers recall too, so a
regression shows there. A tool whose `instruction` is really volatile but
unflagged breaks caching silently: the stability test catches it for
shipped tools, and the once-per-run log covers the rest.

ADR 0151: the prefix is stable and per-turn text goes last; Claude requests
carry automatic cache control.

## Phase 2: tool-result masking and a default cap (3 days)

**Policy.** In `projectHistory`, a function response outside the verbatim
tail, and longer than `mask_over_chars` (default 1,000), is replaced by a
stub: `{ masked: true, tool, ref, chars, head }` where `ref` is the stored
event's id, `chars` the original length, and `head` its first 200
characters. Smaller results stay: they are cheap and often carry the
decision. The function call part stays as it is, so the model still sees
what it asked for.

**The boundary is stored, not slid.** A window that moves one event per
step changes the prefix every step and defeats Phase 1. Instead the session
carries a marker event (`author: system`, `contextMark: { maskedBefore:
<timestamp> }`, visible to the projection only). The loop advances it
before a step only when the eligible results beyond the current marker
total at least `mask_batch_chars` (default 20,000), and then to the start
of the verbatim tail. Between advances the projection is identical step to
step, so the cache holds; each advance costs one cache miss, paid for by
the tokens it removes. A compaction's `endTime` is also a boundary:
everything a summary covers is already gone from the projection.

**Where it applies.** Every agent that runs a loop over an accruing
history: a delegate orchestrator across turns, and any agent inside one
long tool loop (the case JetBrains measured). Subagents and script
`agent()` calls start fresh, so the marker never advances for them; a
workflow node's bounded input is unaffected. The schema's delegate-only
rule for `context:` is lifted with the key's new shape (Phase 5).

**Restore.** `recall_tool_result({ ref })` (in `lib/tools/`, registered
through `lib/toolRegistry.ts`) returns the stored result, capped by
`capResult`, for an event in the caller's own session and isolation scope;
any other ref is "no such result". The loop lists it automatically on any
agent whose projection currently masks something, and its one-line
instruction says what masking is. It never leaves the session: no network,
no file system.

**Default cap.** `defineTool` results are capped at `MAX_RESULT_CHARS`
unless the tool sets `maxResultChars` (a larger number, or `0` for none).
Audit own tools that return large payloads on purpose
(`webExtractTool`, the wiki tools, `runCodeTool`) and set each
deliberately. An ADK-shaped tool from a toolset keeps its own cap.

**Tests.** `tests/historyMasking.test.ts`: stub shape; small results kept;
the marker advances only in batches; the projection is byte-identical
between advances; a compaction boundary masks nothing twice; the recall
tool refuses a foreign ref and an out-of-scope ref; the stored events are
unchanged throughout. Extend `tests/llmRequestBoundary.test.ts` for the
stub reaching every adapter as a function result.

**Acceptance.** In the e2e chat, input tokens per step on turn 20 are at
most 50% of the Phase 0 baseline, with Phase 1's cache ratio held.

ADR 0152: old tool results are masked in the projection behind a stored
boundary, and `recall_tool_result` reads them back.

## Phase 3: structured, anchored compaction (4 days)

**The summary** is one document with fixed sections, every one present
even when empty:

```
## Intent          what the person is trying to get done, in their words
## Stated facts    what they asserted, with values and units as stated
## Decisions       what was decided, by whom, and what it replaced
## Artifacts       files, URLs, ids, and tool results worth reading again,
                   each with its ref (event id, path or URL)
## Open            unresolved questions and next steps
## Last state      where the conversation stood when the summary was cut
```

**Anchored.** The summariser's input is the previous summary (when there
is one) and the newly cut span only, never the whole history again. The
instruction: update each section, keep every item that is still true,
mark one that was superseded as such with what replaced it, add refs, stay
under a word budget (default 1,200), add nothing the span does not say.
The span is rendered as the model saw it: text, each function call as
JSON, each function result as its stub or capped text, so tool activity
survives. `[Event i - Author]` framing stays.

**The call** stays an `llm.request` under the agent span, charged to the
turn, on `summary_model` or the agent's own model, with `max_tokens`
bounded (2,048) and the request's `system` carrying only the summariser
instruction (its own stable prefix, so repeated summaries cache too).

**Failure.** A summary with no text, an error, or a result over the budget
by more than half: log, set `compaction.skipped` with the reason on the
span, store nothing, run the step uncompacted. The next step tries again.
The turn fails only if the step then overflows and Phase 5's forced
compaction also fails.

**Stored shape** is the same `CompactedEvent` (`isCompacted`, `startTime`,
`endTime`, `compactedContent`), plus `summaryFormat: 'sections/1'`. A
session compacted under the old prompt reads as before; the next
compaction rewrites it into sections. `history.ts` keeps the
"[Previous Context Summary]" frame.

**Eval.** `tests/compactionProbes.test.ts`: scripted sessions that plant
facts, decisions and artifact refs in early turns (a number with a unit, a
corrected value, a file path, a URL, an open question), compact twice, and
assert each survives in the summary by string match, with the superseded
value marked and the correction current. No judge model: the checks are
exact, so the test is deterministic and cheap. Record the pass rate for
the old prompt first; it is the regression floor.

**Tests to change.** `tests/compaction.test.ts` loses its "as on ADK"
recorded request fixtures and keeps: the threshold and tail rules,
`retainStartIndex`, folding an earlier summary in, charging and tracing,
continuing an ADK-compacted session, and `runSyndicateTurn` end to end.
The "a summary model that answers no text fails the turn" case inverts.

**Acceptance.** Every probe survives two compactions on the default
summary model for each shipped provider family (Claude, Gemini, GPT,
Ollama qwen3); token count of the summary stays under budget.

ADR 0153: compaction writes a sectioned, anchored summary that includes
tool activity and skips on failure. Supersedes ADR 0078.

## Phase 4: restorability (folded into 2 and 3, half a day of docs)

Nothing new to build beyond `recall_tool_result` and the Artifacts
section: this phase is the rule and the check. The rule, written into the
summariser instruction and the stub format: nothing leaves the projection
without a handle to get it back (an event ref, a path, a URL, or a memory
key `load_memory` can search). The check: Phase 3's probes include one
that asks for a masked result's content and passes only when the model
calls `recall_tool_result` and answers from it.

## Phase 5: defaults, thresholds and overflow (3 days)

**Window table.** `contextWindow` per model id, next to the existing
capability data: Claude in `claudeModels.ts` (per generation), GPT, Gemini,
Grok, DeepSeek and Kimi in their adapters (the Kimi and DeepSeek adapters
already comment the numbers), Ollama from `ollama show`'s `num_ctx` when
reachable (the onboarding text already warns about the 4,096 default),
else 8,192. Unknown id: the provider's newest row. Exposed through
`describeCapabilities`.

**Default threshold.** `compact_after_tokens` defaults to 60% of the
window, floor 12,000; `keep_recent_events` stays 6; `mask_over_chars` and
`mask_batch_chars` as in Phase 2. `context: off` disables everything for
an agent. The schema allows `context:` on any agent (the Phase 2 scope
rule decides where it has an effect, and `doctor` says so instead of the
schema refusing). `config/agents/syndicateSchema.yaml` and the app's
`syndicate-file.md` document the new keys and defaults.

**Overflow.** `errorResponse.ts` classifies a context-overflow error as
`error.kind: 'context_overflow'`: Anthropic's `prompt is too long` 400 and
the `model_context_window_exceeded` stop reason, OpenAI's
`context_length_exceeded`, Gemini's token-limit 400, Grok's and the
chat-completions family's equivalents (collect the exact strings in
`tests/overflowErrors.test.ts` from recorded bodies). On that kind the
loop forces a compaction (threshold ignored, tail halved, marker advanced
to the tail) and retries the step once; a second overflow ends the step on
the error as today. The fallback adapter never redirects it: it is the
request's fault, not the provider's. Ollama cannot report it, which is why
its threshold comes from `num_ctx`.

**Acceptance.** A chat on a 32k Ollama window runs 40 turns without a
truncated answer; a Claude chat forced past the window recovers in one
retry; the e2e token curve flattens after the first compaction.

ADR 0154: compaction is on by default from a per-model window table, and a
context overflow forces one compaction and retry.

## Phase 6: the app (1 day, through the app skills)

- Traces already shows the summary's llm.request; add the cache-read
  share to the model-call row and a `compacted` mark on the step
  (`content-display`, `desktop-typography`).
- The chat shows nothing for a compaction: the full history is stored and
  rendered as before. The one exception is a quiet marker when the person
  asks why an answer forgot something, which is Traces' job, not the
  transcript's.
- Settings gets no new control. `context:` in the syndicate file is the
  control.

## Cross-cutting

**Docs** (`sync-wiki`, each in the same change): `wiki/overview/native-
loop.md` (Compaction, and a new Masking section), `wiki/models/model-
contract.md` (`turnNotes`, `error.kind`, `contextWindow`), `wiki/models/
claude-adapter.md` (cache control), `wiki/tools/` (the recall tool, the
default cap), `wiki/memory/sessions.md` (marker and compacted events),
`wiki/operations/failure-modes.md` (overflow). App: `src/knowledge/
syndicate-file.md`, `memory.md`. Site: `melch` drift check after the app
release; the schema comment in `syndicateSchema.yaml` feeds the site's
reference.

**Package surface.** `ModelRequest.turnNotes`, `InstructionTool.volatile`,
`error.kind`, the schema's new keys and lifted rule, and the recall tool
are additive: a minor version. The app re-vendors the tarball (remove the
installed package first, then install the tarball path, or npm serves the
cached copy).

**Security.** `recall_tool_result` reads the caller's own session and
scope only. Summaries and stubs are session events like any other: they
pass the same redaction before telemetry, and a tool result that carried a
secret is no more exposed by its stub than it was by the result. The
summariser gets no tools and no network. The forced-compaction path cannot
loop: one retry.

**Order and dependencies.** 0 → 1 → 2 → 3 → 5 → 6; 4 is a rule inside 2
and 3. Phase 2 depends on Phase 1's stability test to prove the batched
marker holds the cache. Phase 5 depends on 3 (a forced compaction needs a
summariser that does not fail the turn). Phases 1 and 3 can be built in
parallel by two sessions if 3 keeps the old threshold rules; they meet in
`agentLoop.ts` at one call site.

**Estimate.** About 14 working days end to end, plus the app release and
drift check.

**Out of scope.** Provider-side compaction as the primary path; a judge-
model eval; summarising across sessions (that is long-term memory's job);
any change to the fact store.

## Baseline

Filled in by Phase 0.
