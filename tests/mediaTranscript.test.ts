/**
 * tests/mediaTranscript.test.ts — offline tests for the media_transcript tool.
 *
 * NO network: the call takes its fetch through `MediaTranscriptDeps`, so the
 * URL parser, the player-response reader, the caption XML parser, the
 * paragraphing, the cap and every RETRIEVAL STATUS run against fixtures.
 * The fixtures are trimmed from live responses captured on 2026-10-05 (the
 * innertube ANDROID client's player body and its srv3 caption XML).
 */

import { test } from 'node:test';
import assert from 'node:assert';

import {
  captionUrlReason,
  formatTimestamp,
  mediaTranscriptContract,
  parseCaptionXml,
  parsePlayerResponse,
  parseVideoId,
  pickTrack,
  renderTranscript,
  runMediaTranscript,
  TRANSCRIPT_MAX_CHARS,
  TRANSCRIPT_RULES,
  truncateTranscript,
  type MediaTranscriptDeps,
} from '../lib/tools/mediaTranscriptTool.ts';
import { executeContract } from '../lib/tools/toolContract.ts';

// ── Fixtures ────────────────────────────────────────────────────────────────

const TIMEDTEXT = 'https://www.youtube.com/api/timedtext?v=8S0FDjFBj8o&caps=asr&xoaf=5&hl=en&ip=0.0.0.0&ipbits=0&expire=1&sparams=ip&signature=abc&key=yt8&fmt=srv3';

const PLAYER = {
  playabilityStatus: { status: 'OK', playableInEmbed: true },
  videoDetails: {
    videoId: '8S0FDjFBj8o',
    title: 'How to sound smart in your TEDx Talk | Will Stephen | TEDxNewYork',
    lengthSeconds: '356',
    author: 'TEDx Talks',
  },
  captions: {
    playerCaptionsTracklistRenderer: {
      captionTracks: [
        { baseUrl: `${TIMEDTEXT}&lang=ar`, name: { simpleText: 'Arabic' }, vssId: '.ar', languageCode: 'ar' },
        { baseUrl: `${TIMEDTEXT}&lang=en`, name: { simpleText: 'English' }, vssId: '.en', languageCode: 'en' },
        { baseUrl: `${TIMEDTEXT}&lang=en&kind=asr`, name: { runs: [{ text: 'English (auto-generated)' }] }, vssId: 'a.en', languageCode: 'en', kind: 'asr' },
        { baseUrl: `${TIMEDTEXT}&lang=pt-BR`, name: { simpleText: 'Portuguese (Brazil)' }, vssId: '.pt-BR', languageCode: 'pt-BR' },
      ],
    },
  },
};

const SRV3 = `<?xml version="1.0" encoding="utf-8" ?><timedtext format="3">
<body>
<p t="0" d="7000">Translator: Gustavo Rocha
Reviewer: Ariana Bleau Lugo</p>
<p t="12540" d="2100">Hear that?</p>
<p t="15600" d="1800">That&#39;s nothing.</p>
<p t="31000" d="3000"><s>Which</s><s> is</s><s> what</s><s> I</s>, as a speaker, have for you.</p>
<p t="33000" d="1000"></p>
<p t="64000" d="2000">Thank you &amp; good night.</p>
</body>
</timedtext>`;

const LEGACY = `<?xml version="1.0" encoding="utf-8" ?><transcript><text start="0.5" dur="2">First &quot;line&quot;</text><text start="3.1" dur="2">Second line</text></transcript>`;

function deps(over: {
  player?: () => Response | Promise<Response>;
  captions?: () => Response | Promise<Response>;
} = {}): MediaTranscriptDeps & { calls: Array<{ url: string; init?: RequestInit }> } {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  return {
    calls,
    fetch: async (input, init) => {
      const url = String(input);
      calls.push({ url, init });
      if (url.startsWith('https://www.youtube.com/youtubei/v1/player')) {
        return over.player ? over.player() : new Response(JSON.stringify(PLAYER), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (url.startsWith('https://www.youtube.com/api/timedtext')) {
        return over.captions ? over.captions() : new Response(SRV3, { status: 200, headers: { 'content-type': 'text/xml' } });
      }
      throw new Error(`unexpected fetch ${url}`);
    },
  };
}

// ── URL parsing ─────────────────────────────────────────────────────────────

test('parseVideoId reads every supported YouTube link shape', () => {
  for (const url of [
    'https://www.youtube.com/watch?v=8S0FDjFBj8o',
    'https://youtube.com/watch?feature=share&v=8S0FDjFBj8o&t=12',
    'https://m.youtube.com/watch?v=8S0FDjFBj8o',
    'https://youtu.be/8S0FDjFBj8o?si=xyz',
    'youtu.be/8S0FDjFBj8o',
    'https://www.youtube.com/shorts/8S0FDjFBj8o',
    'https://www.youtube.com/live/8S0FDjFBj8o?feature=share',
    'https://www.youtube.com/embed/8S0FDjFBj8o',
    'https://www.youtube-nocookie.com/embed/8S0FDjFBj8o',
  ]) {
    assert.deepStrictEqual(parseVideoId(url), { id: '8S0FDjFBj8o' }, url);
  }
});

test('parseVideoId refuses what it cannot read, with a reason', () => {
  const reason = (s: string): string => (parseVideoId(s) as { reason: string }).reason;
  assert.match(reason(''), /no URL/);
  assert.match(reason('https://feeds.megaphone.fm/ep.mp3'), /feeds\.megaphone\.fm is not YouTube/);
  assert.match(reason('http://169.254.169.254/latest/meta-data'), /is not YouTube/);
  assert.match(reason('ftp://www.youtube.com/watch?v=8S0FDjFBj8o'), /only http\(s\)/);
  assert.match(reason('https://www.youtube.com/watch?v=nope'), /carries no video id/);
  assert.match(reason('https://www.youtube.com/@TEDx'), /carries no video id/);
  assert.match(reason('https://youtu.be/'), /carries no video id/);
  assert.match(reason('https://evil.example.com/watch?v=8S0FDjFBj8o'), /is not YouTube/);
});

// ── Player response ─────────────────────────────────────────────────────────

test('parsePlayerResponse reads status, details and tracks, tolerating what is missing', () => {
  const info = parsePlayerResponse(PLAYER);
  assert.strictEqual(info.status, 'OK');
  assert.strictEqual(info.title, 'How to sound smart in your TEDx Talk | Will Stephen | TEDxNewYork');
  assert.strictEqual(info.author, 'TEDx Talks');
  assert.strictEqual(info.lengthSeconds, 356);
  assert.strictEqual(info.tracks.length, 4);
  assert.deepStrictEqual(info.tracks[2], { baseUrl: `${TIMEDTEXT}&lang=en&kind=asr`, languageCode: 'en', kind: 'asr', name: 'English (auto-generated)' });
  const bare = parsePlayerResponse({ playabilityStatus: { status: 'LOGIN_REQUIRED', reason: 'Sign in to confirm you’re not a bot' } });
  assert.strictEqual(bare.status, 'LOGIN_REQUIRED');
  assert.strictEqual(bare.reason, 'Sign in to confirm you’re not a bot');
  assert.deepStrictEqual(bare.tracks, []);
  assert.strictEqual(parsePlayerResponse(null).status, 'UNKNOWN');
});

test('pickTrack prefers the asked-for language, uploaded before automatic, then English, then anything', () => {
  const tracks = parsePlayerResponse(PLAYER).tracks;
  assert.strictEqual(pickTrack(tracks)!.baseUrl, `${TIMEDTEXT}&lang=en`, 'English, uploaded');
  assert.strictEqual(pickTrack(tracks, 'ar')!.languageCode, 'ar');
  assert.strictEqual(pickTrack(tracks, 'pt')!.languageCode, 'pt-BR', 'a bare code matches its regional variant');
  assert.strictEqual(pickTrack(tracks, 'xx')!.baseUrl, `${TIMEDTEXT}&lang=en`, 'an unknown language falls back to English');
  const asrOnly = [{ baseUrl: 'https://www.youtube.com/api/timedtext?lang=es', languageCode: 'es', kind: 'asr' }];
  assert.strictEqual(pickTrack(asrOnly)!.languageCode, 'es');
  assert.strictEqual(pickTrack([]), undefined);
});

// ── Caption XML ─────────────────────────────────────────────────────────────

test('parseCaptionXml reads srv3 cues (with word segments and entities) and skips empty ones', () => {
  const cues = parseCaptionXml(SRV3);
  assert.deepStrictEqual(cues.map((c) => c.start), [0, 12.54, 15.6, 31, 64]);
  assert.strictEqual(cues[0]!.text, 'Translator: Gustavo Rocha Reviewer: Ariana Bleau Lugo');
  assert.strictEqual(cues[2]!.text, "That's nothing.");
  assert.strictEqual(cues[3]!.text, 'Which is what I, as a speaker, have for you.');
  assert.strictEqual(cues[4]!.text, 'Thank you & good night.');
});

test('parseCaptionXml reads the legacy transcript shape too', () => {
  assert.deepStrictEqual(parseCaptionXml(LEGACY), [
    { start: 0.5, text: 'First "line"' },
    { start: 3.1, text: 'Second line' },
  ]);
  assert.deepStrictEqual(parseCaptionXml('<html>not captions</html>'), []);
});

test('renderTranscript groups cues into timestamped paragraphs of about thirty seconds', () => {
  const text = renderTranscript(parseCaptionXml(SRV3));
  assert.strictEqual(
    text,
    "[0:00] Translator: Gustavo Rocha Reviewer: Ariana Bleau Lugo Hear that? That's nothing.\n" +
      '[0:31] Which is what I, as a speaker, have for you.\n' +
      '[1:04] Thank you & good night.',
  );
  assert.strictEqual(formatTimestamp(3725), '1:02:05');
  assert.strictEqual(formatTimestamp(59.9), '0:59');
});

test('truncateTranscript cuts on a paragraph boundary and reports the whole length', () => {
  const para = `[0:00] ${'word '.repeat(200).trim()}`;
  const text = Array.from({ length: 80 }, (_, i) => para.replace('0:00', formatTimestamp(i * 30))).join('\n');
  assert.ok(text.length > TRANSCRIPT_MAX_CHARS);
  const cut = truncateTranscript(text);
  assert.strictEqual(cut.truncated, true);
  assert.strictEqual(cut.total, text.length);
  assert.ok(cut.text.length <= TRANSCRIPT_MAX_CHARS);
  assert.ok(!cut.text.endsWith('\n'));
  assert.ok(text.startsWith(cut.text));
  assert.deepStrictEqual(truncateTranscript('short'), { text: 'short', truncated: false, total: 5 });
});

// ── The caption URL gate ────────────────────────────────────────────────────

test('captionUrlReason lets YouTube’s https hosts through and nothing else', () => {
  assert.strictEqual(captionUrlReason(TIMEDTEXT), null);
  assert.strictEqual(captionUrlReason('https://youtube.com/api/timedtext?v=1'), null);
  assert.match(captionUrlReason('http://www.youtube.com/api/timedtext?v=1')!, /not https/);
  assert.match(captionUrlReason('https://evil.example.com/api/timedtext')!, /is not YouTube/);
  assert.match(captionUrlReason('https://notyoutube.com/x')!, /is not YouTube/);
  assert.match(captionUrlReason('https://169.254.169.254/')!, /is not YouTube/);
  assert.match(captionUrlReason('nonsense')!, /not a URL/);
});

// ── The whole call ──────────────────────────────────────────────────────────

test('OK: the block opens with the status, carries title, duration, language and the paragraphs', async () => {
  const d = deps();
  const out = await runMediaTranscript({ url: 'https://youtu.be/8S0FDjFBj8o' }, d);
  const lines = out.split('\n');
  assert.strictEqual(lines[0], 'RETRIEVAL STATUS: OK');
  assert.strictEqual(lines[1], 'TITLE: How to sound smart in your TEDx Talk | Will Stephen | TEDxNewYork — TEDx Talks');
  assert.strictEqual(lines[2], 'DURATION: 5:56');
  assert.strictEqual(lines[3], 'CAPTIONS: en (uploaded, "English"); 3 other tracks available — pass language: to choose');
  assert.strictEqual(lines[4], 'SOURCE: https://www.youtube.com/watch?v=8S0FDjFBj8o');
  assert.strictEqual(lines[5], TRANSCRIPT_RULES);
  assert.strictEqual(lines[6], 'TRANSCRIPT:');
  assert.match(lines[7]!, /^\[0:00\] Translator: Gustavo Rocha/);
  assert.ok(!out.includes('truncated'));

  // the player call: ANDROID client, the video id, nothing from the model's URL
  assert.strictEqual(d.calls.length, 2);
  const player = d.calls[0]!;
  assert.strictEqual(player.init?.method, 'POST');
  const body = JSON.parse(String(player.init?.body));
  assert.strictEqual(body.videoId, '8S0FDjFBj8o');
  assert.strictEqual(body.context.client.clientName, 'ANDROID');
  assert.strictEqual((player.init?.headers as Record<string, string>)['X-YouTube-Client-Name'], '3');
  assert.strictEqual(d.calls[1]!.url, `${TIMEDTEXT}&lang=en`);
});

test('language picks the track and marks automatic captions', async () => {
  const d = deps();
  const out = await runMediaTranscript({ url: 'https://www.youtube.com/watch?v=8S0FDjFBj8o', language: 'ar' }, d);
  assert.match(out, /^RETRIEVAL STATUS: OK\n.*\n.*\nCAPTIONS: ar \(uploaded, "Arabic"\)/);
  assert.strictEqual(d.calls[1]!.url, `${TIMEDTEXT}&lang=ar`);

  const asr = { ...PLAYER, captions: { playerCaptionsTracklistRenderer: { captionTracks: [PLAYER.captions.playerCaptionsTracklistRenderer.captionTracks[2]] } } };
  const out2 = await runMediaTranscript({ url: 'https://www.youtube.com/watch?v=8S0FDjFBj8o' }, deps({ player: () => new Response(JSON.stringify(asr), { status: 200 }) }));
  assert.match(out2, /CAPTIONS: en \(auto-generated, "English \(auto-generated\)"\)\n/);
});

test('UNSUPPORTED_URL fetches nothing', async () => {
  const d = deps();
  const out = await runMediaTranscript({ url: 'https://feeds.megaphone.fm/ep.mp3' }, d);
  assert.match(out, /^RETRIEVAL STATUS: UNSUPPORTED_URL\nREASON: feeds\.megaphone\.fm is not YouTube/);
  assert.match(out, /say the recording itself was not read/);
  assert.deepStrictEqual(d.calls, []);
});

test('NO_CAPTIONS when YouTube holds no track, with the title it did return', async () => {
  const none = { ...PLAYER, captions: undefined };
  const out = await runMediaTranscript({ url: 'https://www.youtube.com/watch?v=8S0FDjFBj8o' }, deps({ player: () => new Response(JSON.stringify(none), { status: 200 }) }));
  assert.match(out, /^RETRIEVAL STATUS: NO_CAPTIONS\nREASON: YouTube holds no caption track for this video, uploaded or automatic\nTITLE: How to sound smart/);
  assert.match(out, /never describe or quote what it says/);
});

test('BLOCKED on the sign-in bot check, on 403/429, and on an empty caption body', async () => {
  const login = { playabilityStatus: { status: 'LOGIN_REQUIRED', reason: 'Sign in to confirm you’re not a bot' } };
  const out1 = await runMediaTranscript({ url: 'https://www.youtube.com/watch?v=8S0FDjFBj8o' }, deps({ player: () => new Response(JSON.stringify(login), { status: 200 }) }));
  assert.match(out1, /^RETRIEVAL STATUS: BLOCKED\nREASON: YouTube asked this server to sign in \("Sign in to confirm you’re not a bot"\)/);
  assert.ok(!/TRANSCRIPT:/.test(out1));

  const out2 = await runMediaTranscript({ url: 'https://www.youtube.com/watch?v=8S0FDjFBj8o' }, deps({ player: () => new Response('denied', { status: 403 }) }));
  assert.match(out2, /^RETRIEVAL STATUS: BLOCKED\nREASON: YouTube refused this server \(HTTP 403\)/);

  const out3 = await runMediaTranscript({ url: 'https://www.youtube.com/watch?v=8S0FDjFBj8o' }, deps({ captions: () => new Response('', { status: 200 }) }));
  assert.match(out3, /^RETRIEVAL STATUS: BLOCKED\nREASON: YouTube returned an empty caption body — the proof-of-origin gate/);
  assert.match(out3, /TITLE: How to sound smart/);

  const out4 = await runMediaTranscript({ url: 'https://www.youtube.com/watch?v=8S0FDjFBj8o' }, deps({ captions: () => new Response('', { status: 429 }) }));
  assert.match(out4, /^RETRIEVAL STATUS: BLOCKED\nREASON: YouTube refused the caption fetch \(HTTP 429\)/);
});

test('ERROR on an unplayable video, a network failure, a non-JSON body and unrecognised captions', async () => {
  const gone = { playabilityStatus: { status: 'UNPLAYABLE', reason: 'This live stream recording is not available.' }, videoDetails: { title: 'lofi', author: 'Lofi Girl' } };
  const out1 = await runMediaTranscript({ url: 'https://www.youtube.com/watch?v=jfKfPfyJRdk' }, deps({ player: () => new Response(JSON.stringify(gone), { status: 200 }) }));
  assert.match(out1, /^RETRIEVAL STATUS: ERROR\nREASON: the video is not playable \(UNPLAYABLE: "This live stream recording is not available\."\)/);
  assert.match(out1, /TITLE: lofi — Lofi Girl/);

  const out2 = await runMediaTranscript({ url: 'https://www.youtube.com/watch?v=8S0FDjFBj8o' }, deps({ player: () => { throw new Error('ECONNRESET'); } }));
  assert.match(out2, /^RETRIEVAL STATUS: ERROR\nREASON: YouTube player endpoint: network: ECONNRESET/);

  const out3 = await runMediaTranscript({ url: 'https://www.youtube.com/watch?v=8S0FDjFBj8o' }, deps({ player: () => new Response('<html>', { status: 200 }) }));
  assert.match(out3, /^RETRIEVAL STATUS: ERROR\nREASON: YouTube player endpoint returned a body that is not JSON/);

  const out4 = await runMediaTranscript({ url: 'https://www.youtube.com/watch?v=8S0FDjFBj8o' }, deps({ captions: () => new Response('<html>consent</html>', { status: 200 }) }));
  assert.match(out4, /^RETRIEVAL STATUS: ERROR\nREASON: the caption body \(20 bytes\) held no cues this parser recognises/);
});

test('a caption url that is not YouTube’s is refused before it is fetched', async () => {
  const foreign = { ...PLAYER, captions: { playerCaptionsTracklistRenderer: { captionTracks: [{ baseUrl: 'https://evil.example.com/steal', languageCode: 'en' }] } } };
  const d = deps({ player: () => new Response(JSON.stringify(foreign), { status: 200 }) });
  const out = await runMediaTranscript({ url: 'https://www.youtube.com/watch?v=8S0FDjFBj8o' }, d);
  assert.match(out, /^RETRIEVAL STATUS: ERROR\nREASON: refusing the caption url YouTube returned \(caption url host evil\.example\.com is not YouTube\)/);
  assert.strictEqual(d.calls.length, 1, 'the foreign host was never fetched');
});

test('an oversized response is refused, and a long transcript is cut with the cut declared', async () => {
  const big = deps({ captions: () => new Response('x', { status: 200, headers: { 'content-length': String(9 * 1024 * 1024) } }) });
  const out1 = await runMediaTranscript({ url: 'https://www.youtube.com/watch?v=8S0FDjFBj8o' }, big);
  assert.match(out1, /^RETRIEVAL STATUS: ERROR\nREASON: caption fetch: response is 9437184 bytes, over the 8388608-byte cap/);

  const cues = Array.from({ length: 3000 }, (_, i) => `<p t="${i * 2000}" d="2000">cue number ${i} with some words in it</p>`).join('');
  const long = deps({ captions: () => new Response(`<timedtext format="3"><body>${cues}</body></timedtext>`, { status: 200 }) });
  const out2 = await runMediaTranscript({ url: 'https://www.youtube.com/watch?v=8S0FDjFBj8o' }, long);
  assert.match(out2, /^RETRIEVAL STATUS: OK/);
  assert.match(out2, /\[transcript truncated at 60,000 of [\d,]+ characters — the rest of the video was not read/);
});

test('the contract validates its arguments and returns an error string, never a throw', async () => {
  assert.strictEqual(mediaTranscriptContract.name, 'media_transcript');
  const missing = await executeContract(mediaTranscriptContract, {});
  assert.match(missing, /^Error: invalid arguments for media_transcript: url/);
  const long = await executeContract(mediaTranscriptContract, { url: 'https://www.youtube.com/watch?v=8S0FDjFBj8o', language: 'much-too-long-code' });
  assert.match(long, /^Error: invalid arguments for media_transcript: language/);
});
