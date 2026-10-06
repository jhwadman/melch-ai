/**
 * lib/guards/augustin.ts — the fact-check vocabulary, computed instead of
 * written. Arithmetic over a researcher's record, never a second opinion
 * from a model.
 *
 * The Augustin syndicate (a fact-checking desk: an Arbiter writes from an X
 * researcher's and a web researcher's reports) rules claim by claim with a
 * fixed vocabulary — True, Missing context, Misleading, False, Unverified
 * for a FACT; Supported, Unsupported, Unverified for an ARGUMENT; Opinion
 * for what no record settles — and a headline computed over the bullets.
 * Asked to apply that vocabulary itself, a model drifts: it writes the
 * researcher's grade ("Confirmed"), invents a variant ("Not checkable"),
 * calls an argument with one event behind it Supported, writes two Opinion
 * bullets, puts the limit after the findings, and headlines a mixed record
 * True. Every one of those was a live failure before this guard existed, and
 * a prompt rule cannot hold at temperature 0 what a prompt rule produced.
 *
 * So the vocabulary is computed here. The web researcher ends its report
 * with a fenced JSON block of verdicts — one per claim id, with the kind,
 * the grade, and for an argument the counts of documented events for and
 * against — and the Arbiter tags each bullet with the claim id it rules on.
 * The guard maps each tag to its word, computes the headline from the words,
 * puts the limit sentence first when the primary source was not read, marks
 * any source domain the record never produced, merges stray Opinion bullets
 * into one, and strips the tags. The model chose the words it wanted; the
 * reader gets the words the record supports.
 *
 * Everything here is a pure function over strings so the checks can be
 * unit-tested and mirrored by the Discord bot that fronts the syndicate.
 * Nothing throws: malformed input ships the text unchanged with a note.
 */

// ── The record ───────────────────────────────────────────────────────────────

export type ClaimKind = 'FACT' | 'ARGUMENT' | 'OPINION';

/** One claim's verdict as the researcher recorded it. Every field but `id`
 *  and `kind` is optional on the wire and tolerated when absent. */
export interface Verdict {
  id: string;
  kind: ClaimKind;
  /** FACT: CONFIRMED | MISLEADING | CONTRADICTED | UNVERIFIED | UNCHECKED.
   *  ARGUMENT: WEIGHED. OPINION: SKIPPED. */
  grade?: string;
  /** On a CONFIRMED fact: the record holds something the claim leaves out. */
  context?: boolean;
  domains?: number;
  depth?: string;
  /** ARGUMENT: documented events supporting / cutting against it. */
  for?: number;
  against?: number;
  sources?: string[];
}

export interface VerdictsBlock {
  verdicts: Verdict[];
  /** Whether the primary source (the episode, the filing) was itself read.
   *  Only an explicit `false` triggers the limit line. */
  primary_read?: boolean;
  /** What the primary source is, in words, e.g. "the episode itself". */
  primary?: string;
  sources: string[];
}

export const VERDICT_WORDS = [
  'True',
  'Missing context',
  'Misleading',
  'False',
  'Unverified',
  'Supported',
  'Unsupported',
  'Opinion',
] as const;
export type VerdictWord = (typeof VERDICT_WORDS)[number];

const ARGUMENT_WORDS: ReadonlySet<VerdictWord> = new Set<VerdictWord>(['Supported', 'Unsupported', 'Unverified']);

/** Verdict-looking words the vocabulary forbids. A bullet opening with one of
 *  these is noted even when it carries no tag to rewrite from; a tagged bullet
 *  is rewritten from its tag whatever it opened with. */
const STRAY_WORDS = new Set(
  [
    'Not checkable', 'Confirmed', 'Contradicted', 'Unchecked', 'Mixed', 'Reported', 'Weighed', 'Skipped',
    'Partly true', 'Partially true', 'Mostly true', 'Mostly false', 'Half true', 'True but missing context',
    'True, but missing context', 'Accurate', 'Inaccurate', 'Correct', 'Incorrect', 'Verified', 'Disputed',
    'Exaggerated', 'Unproven', 'Unsubstantiated', 'Needs context', 'Lacks context', 'Out of context',
    'Established', 'Not established', 'Not verified', 'Not supported', 'Partly supported', 'Weakly supported',
    'Debunked', 'Plausible', 'Unlikely', 'Likely', 'Fact', 'Claim', 'Rumor', 'Satire', 'Context', 'Uncertain',
  ].map((w) => w.toLowerCase()),
);

const FENCE_RE = /```[^\n]*\n([\s\S]*?)```/g;
const VERDICT_LINE_RE = /^\s*(?:\*\*)?\s*Fact check:\s*(.+?)\s*(?:\*\*)?\s*\.?\s*$/i;
const BULLET_RE = /^(\s*)([-•])\s+(.*)$/;
const ID_PART = '[A-Za-z]\\d{1,3}[a-z]?';
const TRAILING_TAG_RE = new RegExp(`\\s*\\[(${ID_PART}(?:\\s*,\\s*${ID_PART})*)\\]\\s*$`);
const ANY_TAG_RE = new RegExp(`\\s*\\[(?:${ID_PART})(?:\\s*,\\s*${ID_PART})*\\]`, 'g');
/* A verdict word opens the bullet, optionally bolded, and ends at the first
   colon: one to four words of letters, spaces and a comma. */
const WORD_RE = /^(?:\*\*)?([A-Za-z][A-Za-z]*(?:[ ,]+[A-Za-z]+){0,3})(?:\*\*)?:\s*(.*)$/s;
const DOMAIN_RE = /(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24}/gi;
const HANDLE_RE = /@[A-Za-z0-9_]{1,15}\b/g;

// ── Parsing the record ───────────────────────────────────────────────────────

function asInt(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return Math.trunc(v);
  if (typeof v === 'string' && /^\s*-?\d+\s*$/.test(v)) return parseInt(v, 10);
  return undefined;
}

function asStrings(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string' && s.trim() !== '').map((s) => s.trim()) : [];
}

function normalizeVerdict(raw: unknown): Verdict | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const id = typeof r.id === 'string' ? r.id.trim() : typeof r.id === 'number' ? `C${r.id}` : '';
  if (!id) return null;
  const grade = typeof r.grade === 'string' ? r.grade.trim().toUpperCase() : undefined;
  let kind = typeof r.kind === 'string' ? r.kind.trim().toUpperCase() : '';
  if (kind !== 'FACT' && kind !== 'ARGUMENT' && kind !== 'OPINION') {
    // The grade vocabularies do not overlap, so an absent kind is recoverable.
    kind = grade === 'WEIGHED' ? 'ARGUMENT' : grade === 'SKIPPED' ? 'OPINION' : 'FACT';
  }
  return {
    id,
    kind: kind as ClaimKind,
    grade,
    context: r.context === true,
    domains: asInt(r.domains),
    depth: typeof r.depth === 'string' ? r.depth : undefined,
    for: asInt(r.for),
    against: asInt(r.against),
    sources: asStrings(r.sources),
  };
}

/**
 * The LAST fenced JSON block carrying a `verdicts` array, across every
 * tool-result text of the turn in order. A fence that does not parse, or
 * parses to something else, is skipped; nothing throws.
 */
export function parseVerdicts(toolResultTexts: string[]): VerdictsBlock | null {
  let found: VerdictsBlock | null = null;
  for (const text of toolResultTexts) {
    if (typeof text !== 'string') continue;
    for (const m of text.matchAll(FENCE_RE)) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(m[1] ?? '');
      } catch {
        continue;
      }
      if (!parsed || typeof parsed !== 'object' || !Array.isArray((parsed as { verdicts?: unknown }).verdicts)) continue;
      const p = parsed as Record<string, unknown>;
      found = {
        verdicts: (p.verdicts as unknown[]).map(normalizeVerdict).filter((v): v is Verdict => v !== null),
        primary_read: typeof p.primary_read === 'boolean' ? p.primary_read : undefined,
        primary: typeof p.primary === 'string' && p.primary.trim() ? p.primary.trim() : undefined,
        sources: asStrings(p.sources),
      };
    }
  }
  return found;
}

// ── Words ────────────────────────────────────────────────────────────────────

/** Case-insensitive lookup of a written word in the allowed vocabulary. */
export function canonicalWord(written: string | null | undefined): VerdictWord | null {
  if (!written) return null;
  const key = written.replace(/\s+/g, ' ').trim().toLowerCase();
  return VERDICT_WORDS.find((w) => w.toLowerCase() === key) ?? null;
}

export interface ComputedWord {
  word: VerdictWord;
  /** FACT graded UNCHECKED: the bullet gains "(not reached)". */
  notReached: boolean;
  /** Why the written word could not stand, when the arithmetic decided. */
  reason?: string;
}

/**
 * The word a bullet must open with, from the verdict it cites and the word
 * the model wrote. A FACT's word follows its grade. An ARGUMENT keeps the
 * model's weighing when it is one of Supported | Unsupported | Unverified and
 * the counts allow it: one documented event never Supports, and no events
 * either way is Unverified. An OPINION is Opinion. An id ending in `u` is
 * the utterance half of a claim ("X said it") and is ruled as a FACT whatever
 * its kind says.
 */
export function computeWord(verdict: Verdict, written?: string | null): ComputedWord {
  const w = canonicalWord(written);
  const kind: ClaimKind = /u$/i.test(verdict.id) ? 'FACT' : verdict.kind;
  if (kind === 'OPINION') return { word: 'Opinion', notReached: false };
  if (kind === 'ARGUMENT') {
    const f = verdict.for ?? 0;
    const a = verdict.against ?? 0;
    if (f === 0 && a === 0) {
      return { word: 'Unverified', notReached: false, reason: w === 'Unverified' ? undefined : `for=0, against=0` };
    }
    if (w && ARGUMENT_WORDS.has(w)) {
      if (w === 'Supported' && f <= 1) return { word: 'Unsupported', notReached: false, reason: `for=${f}` };
      return { word: w, notReached: false };
    }
    return {
      word: 'Unverified',
      notReached: false,
      reason: w ? 'a fact word on an argument' : 'no argument word',
    };
  }
  switch (verdict.grade) {
    case 'CONFIRMED':
      return { word: verdict.context ? 'Missing context' : 'True', notReached: false };
    case 'MISLEADING':
      return { word: 'Misleading', notReached: false };
    case 'CONTRADICTED':
      return { word: 'False', notReached: false };
    case 'UNVERIFIED':
      return { word: 'Unverified', notReached: false };
    case 'UNCHECKED':
      return { word: 'Unverified', notReached: true };
    default:
      return { word: 'Unverified', notReached: false, reason: `grade ${verdict.grade ?? 'missing'} unknown` };
  }
}

/**
 * The headline over the tagged bullets' computed words. One bullet: its word.
 * All Opinion: Opinion. An Opinion beside any ruling word: Mixed — a piece
 * whose weight is opinion is never True on the facts it cites along the way.
 * Otherwise the words must all sit in one FACT family — {True, Missing
 * context}, {Misleading}, {False}, {Unverified} — to carry the headline;
 * anything else, arguments included, is Mixed. Returns null when there is
 * nothing to compute over.
 */
export function computeHeadline(words: readonly VerdictWord[]): string | null {
  if (words.length === 0) return null;
  const asHeadline = (w: VerdictWord): string => (w === 'Missing context' ? 'True, but missing context' : w);
  if (words.length === 1) return asHeadline(words[0]!);
  const ruling = words.filter((w) => w !== 'Opinion');
  if (ruling.length === 0) return 'Opinion';
  if (ruling.length < words.length) return 'Mixed';
  const set = new Set(ruling);
  if ([...set].every((w) => w === 'True' || w === 'Missing context')) {
    return set.has('Missing context') ? 'True, but missing context' : 'True';
  }
  if (set.size === 1) {
    const only = ruling[0]!;
    if (only === 'Misleading' || only === 'False' || only === 'Unverified') return only;
  }
  return 'Mixed';
}

// ── The text ─────────────────────────────────────────────────────────────────

interface Bullet {
  line: number;
  indent: string;
  marker: string;
  /** The verdict word as written, null for a plain bullet. */
  written: string | null;
  /** The bullet after the word and before the source parenthesis. */
  body: string;
  /** Contents of the trailing source parenthesis, or null. */
  sources: string | null;
  /** Sentence punctuation after the parenthesis. */
  tail: string;
  tags: string[];
  /** The claim the bullet is ruled from: first non-`u` id, else the first. */
  claimId: string | null;
  verdict: Verdict | null;
  word: VerdictWord | null;
  notReached: boolean;
  unsourced: string[];
  dropped: boolean;
}

function normalizeDomain(token: string): string {
  let t = token.trim().toLowerCase();
  t = t.replace(/^https?:\/\//, '').replace(/^www\./, '');
  t = t.replace(/[/?#].*$/, '').replace(/[.,;:)]+$/, '');
  return t;
}

/** Domain-like tokens and @handles in a string, normalized. */
function sourceTokens(s: string): string[] {
  const out: string[] = [];
  for (const m of s.matchAll(DOMAIN_RE)) out.push(normalizeDomain(m[0]));
  for (const m of s.matchAll(HANDLE_RE)) out.push(m[0].toLowerCase());
  return out;
}

function parseBullet(line: number, raw: string): Bullet | null {
  const m = raw.match(BULLET_RE);
  if (!m) return null;
  let content = m[3]!;
  const tags: string[] = [];
  for (;;) {
    const t = content.match(TRAILING_TAG_RE);
    if (!t) break;
    tags.unshift(...t[1]!.split(',').map((s) => s.trim()).filter(Boolean));
    content = content.slice(0, content.length - t[0].length);
  }
  content = content.trimEnd();

  let written: string | null = null;
  let rest = content;
  const wm = content.match(WORD_RE);
  if (wm) {
    const candidate = wm[1]!.replace(/\s+/g, ' ').trim();
    const known = canonicalWord(candidate) !== null || STRAY_WORDS.has(candidate.toLowerCase());
    // A tagged bullet opening "Word:" or "Two words:" is taken to be ruling,
    // whatever the word; an untagged one must open with a known word, so
    // prose like "The ruling said: …" is never mistaken for a verdict.
    const shortEnough = /^[A-Za-z]+(?: [A-Za-z]+)?$/.test(candidate);
    if (known || (tags.length > 0 && shortEnough)) {
      written = candidate;
      rest = wm[2]!;
    }
  }

  let body = rest;
  let sources: string | null = null;
  let tail = '';
  const pm = rest.match(/^(.*?)\s*\(([^()]*)\)\s*([.!?]*)\s*$/s);
  if (pm && sourceTokens(pm[2]!).length > 0) {
    body = pm[1]!;
    sources = pm[2]!;
    tail = pm[3]!;
  }

  const claimId = tags.find((t) => !/u$/i.test(t)) ?? tags[0] ?? null;
  return {
    line, indent: m[1]!, marker: m[2]!, written, body, sources, tail, tags, claimId,
    verdict: null, word: null, notReached: false, unsourced: [], dropped: false,
  };
}

function renderBullet(b: Bullet): string {
  const word = b.word ?? b.written;
  let s = `${b.indent}${b.marker} `;
  if (word) s += `${word}: `;
  let body = b.body;
  if (b.notReached && !/\(not reached\)/i.test(body)) body = `${body.replace(/\s+$/, '')} (not reached)`;
  s += body;
  if (b.sources !== null) {
    s += `${body.endsWith(' ') || body === '' ? '' : ' '}(${b.sources})`;
    for (const d of b.unsourced) s += ` [unsourced: ${d}]`;
    s += b.tail;
  } else {
    for (const d of b.unsourced) s += ` [unsourced: ${d}]`;
  }
  return s;
}

function stripTags(text: string): string {
  return text.replace(ANY_TAG_RE, '');
}

function limitSentence(primary: string | undefined): string {
  const what = (primary ?? 'primary source').trim().replace(/^the\s+/i, '').replace(/[.;]+$/, '') || 'primary source';
  return `The ${what} was not read; this rests on what could be found about it.`;
}

function hasLimit(line: string): boolean {
  return /\bnot read\b/i.test(line);
}

function enforce(text: string, toolResultTexts: string[]): { text: string; notes: string[] } {
  const notes: string[] = [];
  const block = parseVerdicts(toolResultTexts);
  if (!block) {
    return { text: stripTags(text), notes: ['no verdicts block; vocabulary not enforced'] };
  }
  const byId = new Map<string, Verdict>();
  for (const v of block.verdicts) byId.set(v.id.toLowerCase(), v);

  const lines = text.split('\n');
  const firstIdx = lines.findIndex((l) => l.trim() !== '');
  const headMatch = firstIdx >= 0 ? lines[firstIdx]!.match(VERDICT_LINE_RE) : null;
  let verdictLine = headMatch ? firstIdx : -1;

  const bullets: Bullet[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (i === verdictLine) continue;
    const b = parseBullet(i, lines[i]!);
    if (b) bullets.push(b);
  }
  const tagged = bullets.filter((b) => b.tags.length > 0);
  const isFactCheck = verdictLine >= 0 || tagged.length > 0;

  if (!isFactCheck) {
    // OVERVIEW (bullets, no ruling) gets the limit line first; CONVERSATIONAL
    // (no bullets) is left alone. Stray tags come off either way.
    if (block.primary_read === false && bullets.length > 0) {
      const first = lines[firstIdx]!;
      if (!(firstIdx >= 0 && !BULLET_RE.test(first) && hasLimit(first))) {
        lines.splice(Math.max(firstIdx, 0), 0, limitSentence(block.primary));
        notes.push('limit line inserted');
      }
    }
    return { text: stripTags(lines.join('\n')), notes };
  }

  // 1. Words are computed from the record.
  for (const b of bullets) {
    if (b.tags.length === 0) {
      if (b.written && canonicalWord(b.written) === null) {
        notes.push(`"${b.written}" is not a verdict word (untagged bullet, line ${b.line + 1}); left as written`);
      }
      continue;
    }
    const v = b.claimId ? byId.get(b.claimId.toLowerCase()) : undefined;
    if (!v) {
      notes.push(`${b.claimId ?? b.tags.join(',')} is not in the record; word left as written`);
      if (b.written && canonicalWord(b.written) === null) notes.push(`"${b.written}" is not a verdict word (${b.claimId})`);
      continue;
    }
    b.verdict = v;
    const c = computeWord(v, b.written);
    b.word = c.word;
    b.notReached = c.notReached;
    const before = b.written ?? null;
    if (before === null) {
      notes.push(`${v.id} no verdict word→${c.word}${c.reason ? ` (${c.reason})` : ''}`);
    } else if (canonicalWord(before) !== c.word) {
      notes.push(`${v.id} ${before}→${c.word}${c.reason ? ` (${c.reason})` : ''}`);
    } else if (c.reason) {
      notes.push(`${v.id} ${c.word} (${c.reason})`);
    }
  }

  // 2. One Opinion bullet: later ones fold into the first.
  const opinions = bullets.filter((b) => (b.word ?? canonicalWord(b.written)) === 'Opinion');
  if (opinions.length > 1) {
    const head = opinions[0]!;
    const seen = new Set((head.sources ?? '').split(/[,;]\s*/).map((s) => s.trim().toLowerCase()).filter(Boolean));
    const union = head.sources ? [head.sources] : [];
    for (const extra of opinions.slice(1)) {
      head.body = `${head.body.replace(/[.\s]+$/, '')}; ${extra.body.replace(/[.\s]+$/, '')}`;
      for (const s of (extra.sources ?? '').split(/[,;]\s*/).map((x) => x.trim()).filter(Boolean)) {
        if (!seen.has(s.toLowerCase())) { seen.add(s.toLowerCase()); union.push(s); }
      }
      head.tags.push(...extra.tags);
      extra.dropped = true;
    }
    if (union.length) { head.sources = union.join(', '); head.tail = head.tail || '.'; }
    if (!head.word) head.word = 'Opinion';
    notes.push(`opinion bullets merged (${opinions.length})`);
  }

  // 3. The headline is arithmetic over the tagged bullets' words.
  const words = bullets.filter((b) => !b.dropped && b.word !== null).map((b) => b.word!);
  const headline = computeHeadline(words);
  if (headline) {
    if (verdictLine >= 0) {
      const current = headMatch![1]!.trim().replace(/\.$/, '');
      if (current.toLowerCase() !== headline.toLowerCase()) {
        notes.push(`headline ${current}→${headline}`);
      }
      lines[verdictLine] = `**Fact check: ${headline}**`;
    } else {
      lines.splice(Math.max(firstIdx, 0), 0, `**Fact check: ${headline}**`);
      verdictLine = Math.max(firstIdx, 0);
      for (const b of bullets) b.line += 1;
      notes.push(`headline inserted (${headline})`);
    }
  }

  // 4. The limit line sits directly under the verdict line.
  if (block.primary_read === false && verdictLine >= 0) {
    let next = verdictLine + 1;
    while (next < lines.length && lines[next]!.trim() === '') next++;
    const sentence = limitSentence(block.primary);
    if (next < lines.length && !BULLET_RE.test(lines[next]!)) {
      if (!hasLimit(lines[next]!)) {
        lines[next] = `${sentence} ${lines[next]!.trimStart()}`;
        notes.push('limit line inserted');
      }
    } else {
      lines.splice(verdictLine + 1, 0, sentence);
      for (const b of bullets) if (b.line > verdictLine) b.line += 1;
      notes.push('limit line inserted');
    }
  }

  // 5. Every cited domain must be in the record.
  const allowed = new Set<string>();
  for (const s of block.sources) { allowed.add(s.toLowerCase()); allowed.add(normalizeDomain(s)); }
  for (const v of block.verdicts) for (const s of v.sources ?? []) { allowed.add(s.toLowerCase()); allowed.add(normalizeDomain(s)); }
  for (const t of toolResultTexts) if (typeof t === 'string') for (const tok of sourceTokens(t)) allowed.add(tok);
  for (const b of bullets) {
    if (b.dropped || b.sources === null) continue;
    for (const tok of sourceTokens(b.sources)) {
      if (allowed.has(tok) || b.unsourced.includes(tok)) continue;
      b.unsourced.push(tok);
      notes.push(`unsourced domain ${tok} in ${b.claimId ?? `bullet at line ${b.line + 1}`}`);
    }
  }

  // 6. Render and strip the tags.
  const out: string[] = [];
  const byLine = new Map(bullets.map((b) => [b.line, b]));
  for (let i = 0; i < lines.length; i++) {
    const b = byLine.get(i);
    if (!b) { out.push(lines[i]!); continue; }
    if (b.dropped) continue;
    out.push(renderBullet(b));
  }
  return { text: stripTags(out.join('\n')), notes };
}

/**
 * Apply the Augustin rules to an answer. Pure, synchronous, never throws:
 * an internal failure ships the text as it was, with a note saying so.
 */
export function applyGuard(text: string, toolResultTexts: string[]): { text: string; notes: string[] } {
  try {
    return enforce(text, Array.isArray(toolResultTexts) ? toolResultTexts : []);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { text, notes: [`did not run (${msg}); vocabulary not enforced`] };
  }
}
