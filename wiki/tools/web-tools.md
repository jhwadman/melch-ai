---
type: tool
title: Web tools
description: "Reading the open web: deterministic page extraction as a contract, beside the provider-native search sentinels."
tags:
  - tools
  - web
generated:
  by: process:wiki-build
  at: 2026-10-06
sources:
  - resource: lib/tools/webExtractTool.ts
  - resource: lib/tools/webSearchTool.ts
  - resource: lib/tools/xApiSearchTool.ts
  - resource: lib/tools/mediaTranscriptTool.ts
---

# Web tools

<!-- wiki:fill slot="overview" -->
Search and extract are complements. `web_search` runs on the provider's side and returns the snippets the provider chose — it finds. `web_extract` runs here, fetches the URLs the agent chose, and returns the whole page as clean text — it reads past the headline. A research agent searches to find sources and extracts to read them.

Because the agent picks the URL, `web_extract` is the framework's main outbound surface (`media_transcript` takes a URL too, but fetches only from YouTube's hosts and only the video id from it). Every hop, redirects included, passes `lib/net/addressGuard.ts`: only http(s); local names and private, loopback and link-local addresses in every encoding the URL parser emits are refused; and the host name is resolved and refused when any address it resolves to is non-public. The same guard covers MCP servers and remote A2A agents. DNS rebinding between the check and the connection is the stated remaining limit.
<!-- /wiki:fill -->

<!-- wiki:generated section="contracts" source="lib/tools/webExtractTool.ts" -->
| Tool | Arguments | Does |
|---|---|---|
| `web_extract` | `urls`, `offset?` | Read web pages in full. |
| `x_api_search` | `query?`, `post?`, `replies?`, `days?`, `sort?`, `max_results?`, `read_images?` | Search X (Twitter) posts from the last 7 days through the X API and read the pictures. |
| `media_transcript` | `url`, `language?` | Read the transcript of a YouTube video (watch, shorts, live or youtu.be link) from its captions — the uploader’s when they exist, YouTube’s automatic ones otherwise. |
<!-- /wiki:generated -->

`x_api_search` reads X through the X API v2 recent search: one page of the last seven days per call, each post verbatim with handle, date, metrics and URL. It is a boolean keyword match, not a semantic search; the engagement floors `min_likes:`, `min_replies:` and `min_reposts:` are the ones this access tier accepts (the older `min_faves:`/`min_retweets:` names are refused by the API and dropped by the query hygiene). Passing an x.com status link or id as `post` reads that one post. Passing it as `replies` reads the thread **count first, buy second**: one request to `/2/tweets/counts/recent` says how many replies the window holds, then counts calls walk a like ladder (`min_likes:` 1000, 300, 100, 30, 10) from the top until a rung holds at least five replies, and one page is bought at that rung, sized to it, most relevant first. A thread of twenty replies or fewer is bought whole with no ladder; a thread with none in the window buys nothing; a ladder no rung of which holds five, or a counts endpoint that fails, falls back to one unfiltered page and the block says which. The block reports the total, every rung tried with its count, the rung chosen, and the replies with their metrics. A query that is only `conversation_id:<id>` takes the same path, so a prompt written for the old single page gets the ladder without a change. Counts requests are priced per request ($0.005) and posts per post returned ($0.005), both dated in the module header; the log line prices each call by both. Each attached photo is fetched only from the API's media host and transcribed beneath its post by a Gemini vision pass; `read_images: false` turns that off. It needs `X_BEARER_TOKEN` in the server environment, and `X_API_MAX_RESULTS` can lower the page size. Without the token it returns an UNAVAILABLE line instead of throwing. [ADR 0036](/decisions/0036-count-first-replies-ladder.md) records the ladder.

`media_transcript` reads a YouTube video's captions as text — the uploader's track when there is one, YouTube's automatic one otherwise, English by default and `language:` to choose. It is keyless and uses no third-party service: the model's URL is parsed down to an eleven-character video id and nothing from it is fetched; the tool asks YouTube's own player endpoint (`/youtubei/v1/player`, as the ANDROID client, whose caption URLs serve where the web client's return empty bodies) for the track list and fetches the chosen track from a `*.youtube.com` host only, under timeouts and byte caps. The first line of every block is `RETRIEVAL STATUS:` — `OK`, `NO_CAPTIONS`, `BLOCKED`, `UNSUPPORTED_URL` or `ERROR` — and only `OK` is followed by a transcript (title, channel, duration, caption language and kind, timestamped paragraphs, cut at 60,000 characters with the cut declared). A bot check, a sign-in demand, an HTTP 403/429 or an empty caption body is `BLOCKED`; the tool never fills a gap with prose. YouTube refuses datacenter addresses more readily than home connections, so a deployment should expect `BLOCKED` and treat it as "the video was not read". Audio-only podcasts are `UNSUPPORTED_URL`. [ADR 0037](/decisions/0037-transcript-retrieval-status.md) records the contract.

`web_search`, `x_search`, and `collections_search` are not contracts — they are sentinels that enable each provider's native server-side search (see [provider routing](/models/provider-routing.md)). `web_extract`, `x_api_search` and `media_transcript` execute client-side, so they work on any provider; `web_extract` and `media_transcript` need no key and run on local models.

A route no agent calls (a deployment's own HTTP endpoint over the same X API, say) does not belong in the engine: a deployment mounts it through `createA2AApp`'s `routes` option, or `startServer(name, { routes })` from `melchizedek-agents/server`, and checks `currentRequestContext().operator` when only operator credentials may spend the quota behind it.
