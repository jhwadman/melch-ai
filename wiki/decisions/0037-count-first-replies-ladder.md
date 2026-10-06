---
type: decision
title: 'ADR 0037: A thread''s replies are counted before a page is bought — a min_likes ladder over the counts endpoint'
description: x_api_search reads a post's replies by asking /2/tweets/counts/recent how many there are and how many clear each like floor, then buying one page at the first floor that holds a page's worth, instead of buying twenty replies by relevancy out of thousands; the ladder is built on min_likes because that is the engagement operator the pay-per-use tier accepts.
tags:
  - decision
  - tools
status: stable
generated:
  by: claude-code/claude-fable-5-1
  at: 2026-10-05
sources:
  - resource: lib/tools/xApiSearchTool.ts
  - resource: tests/xApiSearch.test.ts
---

# ADR 0037: A thread's replies are counted before a page is bought

## Context

The Augustin fact-check syndicate reads a pasted post and then its thread,
because the correction usually sits in the replies — a document, a figure, a
firsthand account under a claim. Its X researcher did this with one
`conversation_id:<id>` search: twenty replies by X's relevancy ranking, out of
a thread that on a viral post runs to thousands. The prompt asked it to look
for "the reply with clearly high likes for its thread", which the page it got
could not promise to contain. Posts are billed per post returned ($0.005), so
a bigger page was a worse answer at a higher price.

The X API v2 has a counts endpoint, `GET /2/tweets/counts/recent`, that takes
the same query grammar as search and is billed per request ($0.005), however
many posts it counts. On 2026-10-05 the live token was probed: `min_likes:`,
`min_replies:` and `min_reposts:` are accepted by both counts and recent
search on this pay-per-use tier, `conversation_id:` is accepted by counts,
and the older `min_faves:`/`min_retweets:` names are refused ("Operator is
not available in current product or product packaging"). The public
changelog is contradictory on these operators; the probe is the record.

## Decision

1. **A `replies` argument** on `x_api_search` (a status link or id) reads a
   thread count-first. A query that is only `conversation_id:<id>` (with at
   most `is:reply`, `-is:retweet`, `lang:`) takes the same path, so the prompt
   that wrote the old single-page search gets the ladder without a change.
2. **Count the thread first.** One counts request on
   `conversation_id:<id> is:reply -is:retweet` over the window. Zero buys
   nothing. Twenty or fewer buys the thread whole, no ladder.
3. **Walk a like ladder from the top** — `min_likes:` 1000, 300, 100, 30, 10
   — one counts request per rung, stopping at the first rung that holds at
   least five replies. A viral thread settles in a call or two; a quiet one
   walks to the bottom for three cents.
4. **Buy ONE page at that rung**, sized to the rung's count within the
   agent's `max_results` and the deployment's `X_API_MAX_RESULTS`, most
   relevant first (recency on request). A rung with more replies than the
   page holds buys the top of it and says so.
5. **Fall back honestly.** A ladder no rung of which holds five, or a counts
   request that fails at any point, buys one unfiltered page and the block
   names the reason. Counts never block the purchase; they shape it.
6. **Report the arithmetic.** The block carries the total, every rung tried
   with its count, the rung chosen, and the replies with their metrics under
   the same evidence rules as a search page; the log line prices counts
   requests and posts separately.
7. **The sanitizer admits the operators that work.** `min_likes:`,
   `min_replies:` and `min_reposts:` pass; `min_faves:` and `min_retweets:`
   are still dropped because the API refuses them.

## Alternatives considered

- **A bigger page.** Rejected: more of the same ranking at a linear price,
  with no promise the liked reply is on it.
- **Buy a page, then filter by metrics client-side.** Rejected: the page is
  the expensive object, and filtering what was already bought cannot reach
  the replies that were not.
- **Walk the ladder bottom-up** (10, 30, 100 …), stopping when a rung falls
  under twenty. Rejected for the stopping rule: it needs a step back to the
  previous rung and a special case when the first rung already fits;
  top-down stops at the first rung that holds enough, and the viral thread —
  the case the desk meets — settles fastest.
- **Binary search over like floors.** Rejected: more code for a saving of
  at most two half-cent calls, and a block whose rungs a reader cannot
  predict.
- **A rung on `min_replies:` or `min_reposts:`.** Possible on this tier, not
  taken: the prompt's notion of a reply worth reading is likes, and one
  ladder is enough to reason about.

## Consequences

- A thread read costs the counts calls (two to six, half a cent each) plus a
  page sized to the rung — on the live probe, a 3,690-reply thread cost four
  counts calls and fourteen posts (≈$0.09) and returned the fourteen replies
  with at least a hundred likes, where the old call returned twenty by
  relevancy for $0.10.
- The counts window is the search window: recent search sees seven days, so
  a post older than that shows only the replies inside the window, and the
  zero-replies block says so instead of "nobody replied".
- The engagement operators are tier-dependent facts verified on one token on
  one day; if the API refuses one later, the counts request fails and the
  path falls back to the unfiltered page by design. The module header carries
  the dated probe.
- The lookup block's closing hint now points at `replies`; the shipped
  Augustin example's prompt still writes `conversation_id:<id>`, which the
  routing honours.
