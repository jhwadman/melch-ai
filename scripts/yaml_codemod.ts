#!/usr/bin/env node
/**
 * scripts/yaml_codemod.ts — the `melchizedek-codemod` bin and `npm run yaml:codemod`.
 *
 * Rewrites an agent's v1 spellings into the v2 keys (ADR 0115):
 *
 *   npm run yaml:codemod -- config/agents/my_syndicate.yaml   # rewrite in place
 *   npm run yaml:codemod -- config/agents                     # every *.yaml below it
 *   npm run yaml:codemod -- --check config/agents             # exit 1 if any file would change
 *
 * Per agent (the orchestrator and every inline subagent):
 *
 *   outputSchema                                    → output.schema
 *   generateContentConfig.responseMimeType          → output.mime (application/json | text/plain)
 *   generateContentConfig.temperature               → sampling.temperature
 *   generateContentConfig.topP                      → sampling.top_p
 *   generateContentConfig.maxOutputTokens           → sampling.max_output_tokens
 *   generateContentConfig.stopSequences             → sampling.stop
 *   generateContentConfig.thinkingConfig / reasoningEffort → reasoning:, ONLY
 *     when the engine reads the same ReasoningSetting before and after for
 *     the agent's model (reasoningOf over the old config equals reasoningOf
 *     over what reasoningConfig makes of the new key).
 *   generateContentConfig.thinkingConfig.includeThoughts: false → dropped (the default; read by nothing)
 *
 * Anything else stays under generateContentConfig with a note naming its key
 * path (never its value); an emptied generateContentConfig is removed. An
 * agent that already has the v2 key for a concept is left alone for that
 * concept, with a note: the loader refuses an overlap.
 *
 * HOW: the file is parsed with the `yaml` package's Document API, which
 * locates every key and value in the source. The edit splices whole lines:
 * a moved key travels with its own lines (its leading and inline comments,
 * its indentation and quoting); the comments of a key that is converted or
 * dropped are kept as comment lines where the new key goes. Every line the
 * codemod does not move is left byte for byte. The result is parsed again and
 * must read back as the planned data, or the file is refused. Running it
 * twice changes nothing the second time.
 */

import { readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { isMap, isPair, isScalar, isSeq, parseDocument, type Document, type Pair, type YAMLMap } from 'yaml';

import type { ReasoningSetting } from '../lib/models/contract.ts';
import { reasoningOf } from '../lib/models/genaiMapping.ts';
import { reasoningConfig } from '../lib/models/reasoning.ts';

export interface MigrateResult {
  /** The migrated text; the input itself when nothing changed. */
  text: string;
  changed: boolean;
  /** One line per key left in a v1 spelling, naming its key path (never a value). */
  notes: string[];
}

type Json = Record<string, unknown>;

/** generateContentConfig keys with a `sampling:` form, and the check its value must pass. */
const SAMPLING: ReadonlyMap<string, { key: string; ok: (v: unknown) => boolean }> = new Map([
  ['temperature', { key: 'temperature', ok: (v: unknown) => typeof v === 'number' && Number.isFinite(v) }],
  ['topP', { key: 'top_p', ok: (v: unknown) => typeof v === 'number' && Number.isFinite(v) }],
  ['maxOutputTokens', { key: 'max_output_tokens', ok: (v: unknown) => typeof v === 'number' && Number.isInteger(v) && v > 0 }],
  ['stopSequences', { key: 'stop', ok: (v: unknown) => Array.isArray(v) && v.length > 0 && v.every((s) => typeof s === 'string') }],
]);

const OUTPUT_MIMES = new Set(['application/json', 'text/plain']);
const THINKING_LEVEL: ReadonlyMap<unknown, string> = new Map([['MINIMAL', 'none'], ['LOW', 'low'], ['MEDIUM', 'medium'], ['HIGH', 'high']]);
const EFFORT_WORD: ReadonlyMap<unknown, string> = new Map([['none', 'none'], ['minimal', 'none'], ['low', 'low'], ['medium', 'medium'], ['high', 'high']]);
const THINKING_KEYS = new Set(['thinkingLevel', 'thinkingBudget', 'includeThoughts']);

// ── The source, by line ──────────────────────────────────────────────────────

class Source {
  readonly text: string;
  readonly eol: string;
  readonly lines: string[];
  private readonly starts: number[];

  constructor(text: string) {
    this.text = text;
    this.eol = text.includes('\r\n') ? '\r\n' : '\n';
    const raw = text.split('\n');
    this.starts = [];
    let at = 0;
    for (const line of raw) {
      this.starts.push(at);
      at += line.length + 1;
    }
    this.lines = raw.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
  }

  lineOf(offset: number): number {
    let lo = 0;
    let hi = this.starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.starts[mid]! <= offset) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }

  col(offset: number): number {
    return offset - this.starts[this.lineOf(offset)]!;
  }

  /** The line of a node's last non-blank character (a trailing comment or blank line is not the node's). */
  endLineOf(range: [number, number, number] | null | undefined, fallback: number): number {
    if (!range || range[1] <= range[0]) return fallback;
    let i = range[1] - 1;
    while (i > range[0] && isSpace(this.text.charCodeAt(i))) i--;
    return Math.max(fallback, this.lineOf(i));
  }

  /** The `# ...` comment that follows `offset` on its line (after an optional `:`), if any. */
  commentAt(offset: number): string | undefined {
    const line = this.lineOf(offset);
    const text = this.lines[line]!;
    let i = offset - this.starts[line]!;
    const skip = () => {
      while (i < text.length && (text[i] === ' ' || text[i] === '\t')) i++;
    };
    skip();
    if (text[i] === ':') {
      i++;
      skip();
    }
    return text[i] === '#' ? text.slice(i).trimEnd() : undefined;
  }
}

function isSpace(code: number): boolean {
  return code === 32 || code === 9 || code === 10 || code === 13;
}

const keyName = (pair: Pair): string | undefined => (isScalar(pair.key) && typeof pair.key.value === 'string' ? pair.key.value : undefined);
const findPair = (map: YAMLMap, key: string): Pair | undefined => (map.items as Pair[]).find((p) => keyName(p) === key);
const keyRange = (pair: Pair) => (pair.key as { range: [number, number, number] }).range;
const valueRange = (pair: Pair) => (pair.value as { range?: [number, number, number] } | null)?.range;

/** The pair's own lines: its key line through its value's last line. */
function pairSpan(src: Source, pair: Pair): [number, number] {
  const keyLine = src.lineOf(keyRange(pair)[0]);
  return [keyLine, src.endLineOf(valueRange(pair), keyLine)];
}

/** Every comment in lines [from, to] of a subtree: full-line comments, and inline ones after keys and values. */
function commentsIn(src: Source, from: number, to: number, root: unknown): string[] {
  const byLine = new Map<number, string>();
  for (let l = from; l <= to; l++) {
    const t = src.lines[l]!.trim();
    if (t.startsWith('#')) byLine.set(l, t);
  }
  const inline = (offset: number | undefined) => {
    if (offset === undefined) return;
    const line = src.lineOf(offset);
    if (byLine.has(line)) return;
    const c = src.commentAt(offset);
    if (c) byLine.set(line, c);
  };
  const walk = (node: unknown): void => {
    if (isPair(node)) {
      inline((node.key as { range?: number[] } | null)?.range?.[1]);
      walk(node.value);
    } else if (isMap(node) || isSeq(node)) {
      if (node.flow) inline(node.range?.[1]);
      for (const item of node.items) walk(item);
    } else if (isScalar(node)) {
      inline(node.range?.[1]);
    }
  };
  walk(root);
  return [...byLine.entries()].sort((a, b) => a[0] - b[0]).map(([, c]) => c);
}

function reindent(lines: string[], delta: number): string[] {
  if (delta === 0) return lines;
  return lines.map((l) => {
    if (l.length === 0) return l;
    if (delta > 0) return ' '.repeat(delta) + l;
    let n = 0;
    while (n < -delta && l[n] === ' ') n++;
    return l.slice(n);
  });
}

// ── The plan for one agent ───────────────────────────────────────────────────

interface Chunk {
  pair: Pair;
  name: string;
  /** Lines [from, to]: the comments above the key, then the pair's own lines. */
  from: number;
  to: number;
}

interface AgentPlan {
  path: string;
  map: YAMLMap;
  gcc?: { pair: Pair; chunks: Chunk[]; keyLine: number; indent: number; childIndent: number };
  sampling: Chunk[];
  mime?: Chunk;
  schema?: Pair;
  reasoning?: { setting: ReasoningSetting; remove: Chunk[] };
  /** includeThoughts: false inside a block thinkingConfig that stays (or empties). */
  dropInclude?: { tc: Chunk; inc: Pair; empties: boolean };
}

function scalarString(map: YAMLMap, key: string): string | undefined {
  const p = findPair(map, key);
  return p && isScalar(p.value) && typeof p.value.value === 'string' ? p.value.value : undefined;
}

function planAgent(doc: Document, src: Source, map: YAMLMap, path: string, notes: string[]): AgentPlan | undefined {
  const gccPair = findPair(map, 'generateContentConfig');
  const osPair = findPair(map, 'outputSchema');
  if (!gccPair && !osPair) return undefined;
  const has = (k: string) => findPair(map, k) !== undefined;
  const plan: AgentPlan = { path, map, sampling: [] };
  const gccPath = `${path}.generateContentConfig`;

  if (has('yaml_reference') || has('a2a_agent_url')) {
    if (gccPair) notes.push(`${gccPath}: a yaml_reference or a2a_agent_url entry brings its own config; left in place`);
    if (osPair) notes.push(`${path}.outputSchema: a yaml_reference or a2a_agent_url entry brings its own config; left in place`);
    return undefined;
  }
  // A key at the head of a list item shares its line with `- `: rewriting
  // that line is not worth the risk, and no shipped file does it.
  for (const pair of [gccPair, osPair]) {
    if (!pair) continue;
    const start = keyRange(pair)[0];
    if (src.lines[src.lineOf(start)]!.slice(0, src.col(start)).trim() !== '') {
      notes.push(`${path}.${keyName(pair)}: the first key of its list item; move it by hand`);
      return undefined;
    }
  }

  if (osPair) {
    if (has('output')) notes.push(`${path}.outputSchema: ${path}.output is already set; left in place (the loader refuses both)`);
    else if (!isMap(osPair.value)) notes.push(`${path}.outputSchema: not a mapping, so no output.schema form; left in place`);
    else plan.schema = osPair;
  }

  if (gccPair) {
    const gcc = gccPair.value;
    if (!isMap(gcc) || gcc.flow || gcc.items.length === 0) {
      notes.push(`${gccPath}: not a block mapping; left in place, move it by hand`);
    } else {
      const keyLine = src.lineOf(keyRange(gccPair)[0]);
      const chunks: Chunk[] = [];
      let prev = keyLine;
      for (const item of gcc.items as Pair[]) {
        const [, to] = pairSpan(src, item);
        chunks.push({ pair: item, name: keyName(item) ?? '', from: prev + 1, to });
        prev = to;
      }
      plan.gcc = { pair: gccPair, chunks, keyLine, indent: src.col(keyRange(gccPair)[0]), childIndent: src.col(keyRange(chunks[0]!.pair)[0]) };
      const valueOf = (c: Chunk) => (c.pair.value as { toJS?: (d: Document) => unknown } | null)?.toJS?.(doc) ?? (c.pair.value as unknown);

      // Sampling.
      for (const c of chunks) {
        const spec = SAMPLING.get(c.name);
        if (!spec) continue;
        if (!spec.ok(valueOf(c))) notes.push(`${gccPath}.${c.name}: this value has no sampling.${spec.key} form; left in place`);
        else if (has('sampling')) notes.push(`${gccPath}.${c.name}: ${path}.sampling is already set; left in place (move it by hand)`);
        else plan.sampling.push(c);
      }

      // Output mime.
      const mime = chunks.find((c) => c.name === 'responseMimeType');
      if (mime) {
        if (!OUTPUT_MIMES.has(valueOf(mime) as string)) notes.push(`${gccPath}.responseMimeType: no output.mime form for this value; left in place`);
        else if (has('output')) notes.push(`${gccPath}.responseMimeType: ${path}.output is already set; left in place (move it by hand)`);
        else plan.mime = mime;
      }

      // Thinking.
      const tc = chunks.find((c) => c.name === 'thinkingConfig');
      const re = chunks.find((c) => c.name === 'reasoningEffort');
      if (tc || re) planThinking(plan, map, tc, re, valueOf, notes);

      // Leftovers: everything not moved, converted or dropped.
      const handled = new Set<Chunk>([...plan.sampling, ...(plan.mime ? [plan.mime] : []), ...(plan.reasoning?.remove ?? [])]);
      if (plan.dropInclude?.empties) handled.add(plan.dropInclude.tc);
      const noted = new Set(['thinkingConfig', 'reasoningEffort', 'responseMimeType', ...SAMPLING.keys()]);
      for (const c of chunks) {
        if (handled.has(c) || noted.has(c.name)) continue;
        notes.push(`${gccPath}.${c.name || '(non-string key)'}: no v2 form; left under generateContentConfig`);
      }
    }
  }

  const changes = plan.sampling.length > 0 || plan.mime || plan.schema || plan.reasoning || plan.dropInclude;
  return changes ? plan : undefined;
}

function planThinking(
  plan: AgentPlan,
  map: YAMLMap,
  tc: Chunk | undefined,
  re: Chunk | undefined,
  valueOf: (c: Chunk) => unknown,
  notes: string[],
): void {
  const gccPath = `${plan.path}.generateContentConfig`;
  const where = [tc, re].filter((c): c is Chunk => !!c).map((c) => `${gccPath}.${c.name}`).join(', ');
  const tcValue = tc ? valueOf(tc) : undefined;
  const tcObject = tcValue && typeof tcValue === 'object' && !Array.isArray(tcValue) ? (tcValue as Json) : undefined;
  const model = scalarString(map, 'model');

  // includeThoughts: false is the default and read by nothing: drop it from a
  // block thinkingConfig whatever else happens to the thinking keys.
  const incPair = tc && isMap(tc.pair.value) && !tc.pair.value.flow ? findPair(tc.pair.value, 'includeThoughts') : undefined;
  const incFalse = incPair && isScalar(incPair.value) && incPair.value.value === false;

  const leave = (why: string) => {
    notes.push(`${where}: ${why}; left in place`);
    if (tc && incFalse) {
      const tcMap = tc.pair.value as YAMLMap;
      plan.dropInclude = { tc, inc: incPair!, empties: tcMap.items.length === 1 };
    }
    if (tcObject?.includeThoughts === true) notes.push(`${gccPath}.thinkingConfig.includeThoughts: no v2 form; left in place`);
  };

  if (findPair(map, 'reasoning')) return leave(`${plan.path}.reasoning is already set (the loader refuses both)`);
  if (!model || model.includes('{{')) return leave('the agent names no model id, so no reasoning: form can be checked');
  if (tc && !tcObject) return leave('thinkingConfig is not a mapping');
  if (tcObject && Object.keys(tcObject).some((k) => !THINKING_KEYS.has(k))) return leave('thinkingConfig holds a key with no reasoning: form');
  if (tcObject && tcObject.includeThoughts !== undefined && tcObject.includeThoughts !== false) return leave('includeThoughts has no reasoning: form');

  const v1 = {} as Json;
  if (tc) v1.thinkingConfig = tcValue;
  if (re) v1.reasoningEffort = valueOf(re);
  let candidate: ReasoningSetting | undefined;
  const level = THINKING_LEVEL.get(tcObject?.thinkingLevel);
  const budget = tcObject?.thinkingBudget;
  if (level) candidate = level as ReasoningSetting;
  else if (typeof budget === 'number' && Number.isInteger(budget) && budget >= 0) candidate = { budget_tokens: budget };
  else if (EFFORT_WORD.has(v1.reasoningEffort)) candidate = EFFORT_WORD.get(v1.reasoningEffort) as ReasoningSetting;
  if (candidate === undefined) return leave('no reasoning: setting reads the same');
  const before = reasoningOf(v1 as never);
  const after = reasoningOf(reasoningConfig(model, candidate) as never);
  if (!isDeepStrictEqual(before, after)) return leave(`reasoning: would change what the engine reads for ${providerWord(model)}`);
  plan.reasoning = { setting: candidate, remove: [tc, re].filter((c): c is Chunk => !!c) };
}

/** A model family word for a note: never the id's value beyond its prefix. */
function providerWord(model: string): string {
  return model.startsWith('gemini-') ? 'this Gemini model' : 'this model';
}

const reasoningText = (s: ReasoningSetting): string => (typeof s === 'string' ? s : `{ budget_tokens: ${s.budget_tokens} }`);

// ── Rendering ────────────────────────────────────────────────────────────────

interface Edit {
  from: number;
  to: number;
  lines: string[];
}

function chunkLines(src: Source, c: Chunk): string[] {
  return src.lines.slice(c.from, c.to + 1);
}

/** A chunk with its key token renamed (same line, same column). */
function renamed(src: Source, c: Chunk, key: string): string[] {
  const lines = chunkLines(src, c);
  const [start, end] = keyRange(c.pair);
  const at = src.lineOf(start) - c.from;
  const line = lines[at]!;
  lines[at] = line.slice(0, src.col(start)) + key + line.slice(src.col(end));
  return lines;
}

function renderGcc(src: Source, plan: AgentPlan): Edit | undefined {
  const g = plan.gcc;
  if (!g) return undefined;
  if (!(plan.sampling.length || plan.mime || plan.reasoning || plan.dropInclude)) return undefined;
  const pad = ' '.repeat(g.indent);
  const removed = new Set<Chunk>([...plan.sampling, ...(plan.mime ? [plan.mime] : []), ...(plan.reasoning?.remove ?? [])]);
  if (plan.dropInclude?.empties) removed.add(plan.dropInclude.tc);
  const leftovers = g.chunks.filter((c) => !removed.has(c));
  const out: string[] = [];

  if (leftovers.length === 0) {
    const c = src.commentAt(keyRange(g.pair)[1]);
    if (c) out.push(pad + c);
  }
  if (plan.sampling.length) {
    out.push(`${pad}sampling:`);
    for (const c of plan.sampling) out.push(...renamed(src, c, SAMPLING.get(c.name)!.key));
  }
  if (plan.reasoning) {
    for (const c of plan.reasoning.remove) for (const comment of commentsIn(src, c.from, c.to, c.pair)) out.push(pad + comment);
    out.push(`${pad}reasoning: ${reasoningText(plan.reasoning.setting)}`);
  }
  if (plan.mime && !plan.schema) {
    out.push(`${pad}output:`);
    out.push(...renamed(src, plan.mime, 'mime'));
  }
  const orphans = plan.dropInclude?.empties ? commentsIn(src, plan.dropInclude.tc.from, plan.dropInclude.tc.to, plan.dropInclude.tc.pair) : [];
  if (leftovers.length) {
    out.push(src.lines[g.keyLine]!);
    for (const c of leftovers) {
      if (plan.dropInclude && c === plan.dropInclude.tc) out.push(...withoutPair(src, c, plan.dropInclude.inc));
      else out.push(...chunkLines(src, c));
    }
    for (const comment of orphans) out.push(' '.repeat(g.childIndent) + comment);
  } else {
    for (const comment of orphans) out.push(pad + comment);
  }
  return { from: g.keyLine, to: g.chunks[g.chunks.length - 1]!.to, lines: out };
}

/** A chunk with one nested pair's own lines removed, its inline comments kept as comment lines. */
function withoutPair(src: Source, c: Chunk, inner: Pair): string[] {
  const [from, to] = pairSpan(src, inner);
  const indent = ' '.repeat(src.col(keyRange(inner)[0]));
  const comments = commentsIn(src, from, to, inner).map((t) => indent + t);
  return [...src.lines.slice(c.from, from), ...comments, ...src.lines.slice(to + 1, c.to + 1)];
}

function renderSchema(src: Source, plan: AgentPlan): Edit | undefined {
  const os = plan.schema;
  if (!os) return undefined;
  const [keyStart, keyEnd] = keyRange(os);
  const indent = src.col(keyStart);
  const [from, to] = pairSpan(src, os);
  const value = os.value as YAMLMap;
  const first = value.items[0] as Pair | undefined;
  const step =
    !value.flow && first && src.lineOf(keyRange(first)[0]) > from
      ? src.col(keyRange(first)[0]) - indent
      : plan.gcc
        ? plan.gcc.childIndent - plan.gcc.indent
        : 2;
  const out = [`${' '.repeat(indent)}output:`, ' '.repeat(indent + step) + 'schema' + src.lines[from]!.slice(src.col(keyEnd))];
  out.push(...reindent(src.lines.slice(from + 1, to + 1), step));
  if (plan.mime) {
    const g = plan.gcc!;
    out.push(...reindent(renamed(src, plan.mime, 'mime'), indent + step - g.childIndent));
  }
  return { from, to, lines: out };
}

/** What the plan should read back as, applied to the agent's data. */
function expectAgent(agent: Json, plan: AgentPlan): void {
  const gcc = agent.generateContentConfig as Json | undefined;
  if (plan.schema) {
    agent.output = { schema: agent.outputSchema };
    delete agent.outputSchema;
  }
  if (!gcc) return;
  if (plan.sampling.length) {
    const sampling: Json = {};
    for (const c of plan.sampling) {
      sampling[SAMPLING.get(c.name)!.key] = gcc[c.name];
      delete gcc[c.name];
    }
    agent.sampling = sampling;
  }
  if (plan.mime) {
    agent.output = { ...((agent.output as Json) ?? {}), mime: gcc.responseMimeType };
    delete gcc.responseMimeType;
  }
  if (plan.reasoning) {
    for (const c of plan.reasoning.remove) delete gcc[c.name];
    agent.reasoning = plan.reasoning.setting;
  }
  if (plan.dropInclude) {
    const tc = gcc.thinkingConfig as Json;
    delete tc.includeThoughts;
    if (Object.keys(tc).length === 0) delete gcc.thinkingConfig;
  }
  if (Object.keys(gcc).length === 0) delete agent.generateContentConfig;
}

/** The agents of a syndicate document: the orchestrator and each subagent, with their key paths. */
function agentsOf(root: YAMLMap): Array<{ map: YAMLMap; path: string; locate: (js: Json) => Json | undefined }> {
  const out: Array<{ map: YAMLMap; path: string; locate: (js: Json) => Json | undefined }> = [];
  const orchestrator = findPair(root, 'orchestrator')?.value;
  if (isMap(orchestrator)) out.push({ map: orchestrator, path: 'orchestrator', locate: (js) => js.orchestrator as Json });
  const subagents = findPair(root, 'subagents')?.value;
  if (isSeq(subagents)) {
    subagents.items.forEach((item, i) => {
      if (isMap(item)) out.push({ map: item, path: `subagents[${i}]`, locate: (js) => (js.subagents as Json[])[i] });
    });
  }
  return out;
}

/**
 * Rewrites one YAML text's v1 agent keys into v2 (see the header). Throws on
 * text that is not one YAML document, and on an edit that would not read
 * back as planned (a bug, never a silent change).
 */
export function migrateYaml(text: string): MigrateResult {
  const doc = parseDocument(text);
  if (doc.errors.length) throw new Error(`not valid YAML (${doc.errors[0]!.code} at line ${doc.errors[0]!.linePos?.[0]?.line ?? '?'})`);
  const notes: string[] = [];
  if (!isMap(doc.contents)) return { text, changed: false, notes };
  const src = new Source(text);
  const plans: Array<{ plan: AgentPlan; locate: (js: Json) => Json | undefined }> = [];
  for (const agent of agentsOf(doc.contents)) {
    const plan = planAgent(doc, src, agent.map, agent.path, notes);
    if (plan) plans.push({ plan, locate: agent.locate });
  }
  if (plans.length === 0) return { text, changed: false, notes };

  const edits = plans.flatMap(({ plan }) => [renderGcc(src, plan), renderSchema(src, plan)].filter((e): e is Edit => !!e));
  edits.sort((a, b) => b.from - a.from);
  const lines = [...src.lines];
  for (const e of edits) lines.splice(e.from, e.to - e.from + 1, ...e.lines);
  const out = lines.join(src.eol);

  const expected = doc.toJS() as Json;
  for (const { plan, locate } of plans) expectAgent(locate(expected)!, plan);
  const back = parseDocument(out);
  if (back.errors.length || !isDeepStrictEqual(back.toJS(), expected)) {
    throw new Error('the rewrite does not read back as planned; file left unchanged (please report this)');
  }
  return { text: out, changed: out !== text, notes };
}

// ── CLI ──────────────────────────────────────────────────────────────────────

function yamlFiles(path: string): string[] {
  if (!statSync(path).isDirectory()) return [path];
  const out: string[] = [];
  for (const entry of readdirSync(path, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
    const p = join(path, entry.name);
    if (entry.isDirectory()) out.push(...yamlFiles(p));
    else if (entry.isFile() && entry.name.endsWith('.yaml')) out.push(p);
  }
  return out;
}

const USAGE = `usage: yaml_codemod [--check] <file|dir>...
  Rewrites agent v1 spellings (generateContentConfig, outputSchema) into the
  v2 keys (sampling, output, reasoning), in place. A directory means every
  *.yaml below it. --check writes nothing and exits 1 if any file would change.`;

export function main(argv: string[]): number {
  const check = argv.includes('--check');
  const targets = argv.filter((a) => a !== '--check');
  if (targets.length === 0 || targets.some((a) => a === '--help' || a === '-h')) {
    console.log(USAGE);
    return targets.length === 0 ? 2 : 0;
  }
  let changed = 0;
  let failed = 0;
  for (const file of targets.flatMap(yamlFiles)) {
    let result: MigrateResult;
    try {
      result = migrateYaml(readFileSync(file, 'utf8'));
    } catch (err: unknown) {
      console.error(`✗ ${file}: ${err instanceof Error ? err.message : String(err)}`);
      failed++;
      continue;
    }
    if (result.changed) {
      changed++;
      if (!check) writeFileSync(file, result.text);
      console.log(`${check ? 'would change' : 'migrated'}: ${file}`);
    }
    for (const note of result.notes) console.log(`  note: ${file}: ${note}`);
  }
  if (check && changed) console.log(`${changed} file(s) still use v1 spellings; run without --check to rewrite them.`);
  return failed ? 1 : check && changed ? 1 : 0;
}

const invokedAsMain = (() => {
  if (!process.argv[1]) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
  } catch {
    return false;
  }
})();
if (invokedAsMain) process.exitCode = main(process.argv.slice(2));
