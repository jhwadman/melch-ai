---
type: decision
title: 'ADR 0038: media_transcript reads YouTube captions keylessly and leads every block with a RETRIEVAL STATUS'
description: A video's transcript comes from the caption track YouTube already holds, fetched through YouTube's own player endpoint as the ANDROID client with no API key, no third-party service and no binary; the first line of every result is one of OK, NO_CAPTIONS, BLOCKED, UNSUPPORTED_URL or ERROR, and only OK is followed by text, because a fact-check desk must never be handed a guessed transcript.
tags:
  - decision
  - tools
  - security
status: stable
generated:
  by: claude-code/claude-fable-5-1
  at: 2026-10-05
sources:
  - resource: lib/tools/mediaTranscriptTool.ts
  - resource: tests/mediaTranscript.test.ts
  - resource: lib/net/addressGuard.ts
---

# ADR 0038: `media_transcript` — keyless YouTube captions behind a retrieval status

## Context

The Augustin fact-check syndicate is handed podcast episodes and clips. Its
researchers had `web_search` and `web_extract`; a YouTube watch page
extracts to nothing, so the words spoken in the episode were the one thing
the desk could not read, and every ruling on "what the guest said" rested on
clips and on coverage of the episode. The prompt already names this limit
("The episode itself was not read: no transcript is published"); the tool
exists to remove it where YouTube holds a caption track.

YouTube's web player gets its caption URLs from the watch page's
`ytInitialPlayerResponse`, but since 2025 those URLs are gated on a
proof-of-origin token the browser computes: a plain fetch returns HTTP 200
with an empty body. Probed from a residential address on 2026-10-05, the
innertube player endpoint (`/youtubei/v1/player`) answered as the ANDROID
client returned the same track list with URLs that serve (srv3 XML); the
WEB, MWEB and TVHTML5 clients were refused ("Video unavailable", "The page
needs to be reloaded", "Sign in to confirm you're not a bot"). YouTube
refuses datacenter egress — Heroku's included — more readily than a home
connection, and changes all of this without notice.

## Decision

1. **Captions, not speech recognition.** The transcript is the caption track
   YouTube already holds: the uploader's when there is one, YouTube's
   automatic one otherwise, English by default, `language:` to choose. The
   block names the kind, because automatic captions mishear names and
   numbers.
2. **Keyless and first-party.** No API key, no third-party transcript
   service, no `youtube-dl` binary. The tool talks to `www.youtube.com`
   only: the player endpoint as the ANDROID client, then the caption URL
   YouTube returns, held to https on a `*.youtube.com` host and the SSRF
   guard's literal rules, under timeouts and byte caps.
3. **The model's URL is an id, not a fetch target.** It is parsed down to an
   eleven-character video id (watch, shorts, live, embed, youtu.be shapes);
   anything else is `UNSUPPORTED_URL` and nothing is fetched. Audio-only
   podcasts are out of scope: there is no keyless way to transcribe audio.
4. **A RETRIEVAL STATUS leads every block** — `OK | NO_CAPTIONS | BLOCKED |
   UNSUPPORTED_URL | ERROR` — and only `OK` is followed by text. A bot
   check, a sign-in demand, an HTTP 403/429 or an empty caption body is
   `BLOCKED`; a video that is private, removed or unplayable is `ERROR` with
   YouTube's reason; a video with no track is `NO_CAPTIONS`. Every non-OK
   block tells the agent to say the video was not read.
5. **Bounded output.** Cues are grouped into timestamped paragraphs of about
   thirty seconds; the text is cut at 60,000 characters on a paragraph
   boundary and the cut is declared with the total length.
6. **Exposure stays a YAML act.** The contract is registered as
   `media_transcript`; no shipped syndicate declares it. A deployment adds
   it to the researcher that needs it.

## Alternatives considered

- **A transcript API or a hosted service.** Rejected: a key, a vendor, a
  second place the video's words pass through, and a dependency the
  framework's keyless mode cannot carry.
- **`yt-dlp` as a subprocess.** Rejected: a binary on the host, a shell the
  model's URL would approach, and a dependency outside npm.
- **The watch page's caption URLs.** Rejected by the probe: they return
  empty bodies without the browser's token. The watch page is not fetched
  at all.
- **Transcribing audio with a speech model** (the server holds a Gemini
  key). Deferred: it is a second surface — arbitrary media fetched from
  arbitrary hosts — and a separate decision on cost and on the SSRF guard's
  reach. It would also serve podcasts; this record does not.
- **Returning the best available prose when captions fail** (a summary from
  search, say). Rejected absolutely: a transcript that did not come from
  YouTube's bytes is a fabrication the desk would quote.

## Consequences

- From a residential address on 2026-10-05: a TEDx talk returned OK with its
  uploaded English track (27 other tracks listed), a music video returned OK,
  Big Buck Bunny returned NO_CAPTIONS, an unavailable live-stream recording
  returned ERROR with YouTube's reason, a one-second short returned OK with
  one auto-generated Spanish cue, and a podcast MP3 URL and a metadata-IP
  URL returned UNSUPPORTED_URL with nothing fetched.
- From a Heroku dyno the expected result is often BLOCKED. That is the
  contract working: the prompt's "the episode itself was not read" stays
  true and is now a tool result rather than an assumption. A deployment
  that needs captions from a datacenter will need an egress YouTube accepts,
  which is an operations decision, not a change to this tool.
- The client version and the srv3 format are YouTube's to change. The parser
  also reads the legacy `<transcript><text>` shape; an unrecognised body is
  `ERROR` naming its size, never a transcript.
