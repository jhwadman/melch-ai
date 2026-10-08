/**
 * tests/helpers/adkReference.ts — ADK's reference behaviour, frozen (WS5-2a).
 *
 * The parity suites prove the native runtime does what ADK did: each case runs
 * ADK's side (the adk runtime, ADK's Runner, its scripted models) and holds the
 * native side equal to it. 1.0.0 removes ADK (ADR 0045), so every such
 * comparison reads ADK's side from a recorded fixture instead:
 *
 *   const reference = adkReferences('nativeStep');
 *   const adk = await reference('plain-agent-two-turns', () => runOnAdk(...));
 *
 * `live` is the ADK side exactly as the test ran it before, returning what the
 * test compares (already normalised as the test normalises it). What happens
 * depends on ADK_REFERENCE:
 *
 *   unset (or `fixture`) — `live` never runs; the value is read from
 *     tests/fixtures/adk-reference/<suite>/<case>.json. ADK need not be
 *     installed.
 *   `live`   — `live` runs against the installed ADK and its value is
 *     returned, passed through the same canonical form a fixture stores, so a
 *     green live run proves the fixtures' shape is enough.
 *   `record` — as `live`, and the value is written to the fixture (under
 *     ADK_REFERENCE_DIR when set: the drift check records into a scratch
 *     directory and compares). scripts/ci/record_adk_references.ts drives it.
 *
 * The canonical form is JSON, made deterministic: every UUID (in a value or a
 * key) becomes a fixed one in order of first appearance; the id of every
 * stored event (an object with string `id`, `invocationId` and `author`)
 * becomes `ev000001`, …, wherever that string appears, and its `timestamp`
 * 2026-01-01 plus one second per event in that order; any other time field
 * (`timestamp`, `startTime`, `endTime`) holding a stored event's original
 * time takes that event's new time. Nothing else is rewritten: a value that still differs between two
 * recordings is the suite's to normalise, and the drift check says which.
 *
 * WS5-2b deletes `live`, `record`, the recorder and every `live` callback with
 * ADK; the fixture branch is what stays.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export type ReferenceMode = 'fixture' | 'live' | 'record';

export const REFERENCE_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'adk-reference');

/** How the ADK side is obtained in this process (ADK_REFERENCE). */
export function referenceMode(): ReferenceMode {
  const mode = process.env.ADK_REFERENCE ?? 'fixture';
  if (mode === '' || mode === 'fixture') return 'fixture';
  if (mode === 'live' || mode === 'record') return mode;
  throw new Error(`ADK_REFERENCE must be unset, 'fixture', 'live' or 'record'; got '${mode}'`);
}

/** True when the ADK side runs (live or record): a suite gates its ADK-only setup on it. */
export const runsAdk = (): boolean => referenceMode() !== 'fixture';

const outputDir = (): string => process.env.ADK_REFERENCE_DIR || REFERENCE_DIR;

/** A case name as a file name: lower case, runs of anything but [a-z0-9] as one dash, no leading or trailing dash. */
export function caseSlug(name: string): string {
  let out = '';
  let dash = false;
  for (const ch of name.toLowerCase()) {
    if ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9')) {
      if (dash && out) out += '-';
      out += ch;
      dash = false;
    } else dash = true;
  }
  if (!out) throw new Error(`a reference case needs a name with a letter or digit: '${name}'`);
  return out;
}

export function referencePath(suite: string, name: string, dir = REFERENCE_DIR): string {
  return join(dir, caseSlug(suite), `${caseSlug(name)}.json`);
}

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const TIME_KEYS = new Set(['timestamp', 'startTime', 'endTime']);
const BASE_TIME = Date.UTC(2026, 0, 1);

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

const isEvent = (v: Record<string, unknown>): boolean => typeof v.id === 'string' && typeof v.invocationId === 'string' && typeof v.author === 'string';

/** The canonical form of a value (see the header): JSON, with ids and event times stable. */
export function canonical<T>(value: T): T {
  if (value === undefined) return value;
  const json = JSON.parse(JSON.stringify(value)) as Json;

  // First pass: every stored event, in order of first appearance. Its id becomes
  // `ev000001`, …, and its time BASE_TIME plus one second per event, so the
  // times keep the events' order whatever the clock's resolution did; any other
  // time field holding an event's original time takes that event's new time
  // (the first event with it, when two shared one millisecond).
  const eventIds = new Map<string, string>();
  const eventTimes = new Map<string, number>();
  const timeOf = new Map<number, number>();
  const scan = (v: Json): void => {
    if (Array.isArray(v)) v.forEach(scan);
    else if (v && typeof v === 'object') {
      if (isEvent(v) && !eventIds.has(v.id as string)) {
        const seq = eventIds.size;
        eventIds.set(v.id as string, `ev${String(seq + 1).padStart(6, '0')}`);
        eventTimes.set(v.id as string, BASE_TIME + seq * 1000);
        if (typeof v.timestamp === 'number' && !timeOf.has(v.timestamp)) timeOf.set(v.timestamp, BASE_TIME + seq * 1000);
      }
      Object.values(v).forEach(scan);
    }
  };
  scan(json);

  const uuids = new Map<string, string>();
  const uuid = (m: string): string => {
    const k = m.toLowerCase();
    if (!uuids.has(k)) uuids.set(k, `00000000-0000-4000-8000-${String(uuids.size + 1).padStart(12, '0')}`);
    return uuids.get(k)!;
  };
  const walk = (v: Json, key?: string): Json => {
    if (typeof v === 'string') return eventIds.get(v) ?? v.replace(UUID, uuid);
    if (typeof v === 'number' && key !== undefined && TIME_KEYS.has(key)) return timeOf.get(v) ?? v;
    if (Array.isArray(v)) return v.map((x) => walk(x));
    if (v && typeof v === 'object') {
      const out = Object.fromEntries(Object.entries(v).map(([k, x]) => [k.replace(UUID, uuid), walk(x, k)]));
      if (isEvent(v) && typeof v.timestamp === 'number') out.timestamp = eventTimes.get(v.id as string)!;
      return out;
    }
    return v;
  };
  return walk(json) as T;
}

/** One recorded reference, as the file holds it. */
export interface ReferenceFile<T = unknown> {
  suite: string;
  case: string;
  recordedBy: string;
  adkVersion: string;
  reference: T;
}

const written = new Set<string>();

async function adkVersion(): Promise<string> {
  const { createRequire } = await import('node:module');
  return (createRequire(import.meta.url)('@google/adk/package.json') as { version: string }).version;
}

/** Reads, runs or records one case's ADK side (see the header). */
export async function adkReference<T>(suite: string, name: string, live: () => T | Promise<T>): Promise<T> {
  const mode = referenceMode();
  if (mode === 'fixture') {
    const path = referencePath(suite, name);
    let body: string;
    try {
      body = readFileSync(path, 'utf8');
    } catch {
      throw new Error(`no ADK reference recorded for ${suite} / ${name} (${path}); record it with ADK installed: npm run fixtures:adk:record`);
    }
    return (JSON.parse(body) as ReferenceFile<T>).reference;
  }
  const value = canonical(await live());
  if (mode === 'record') {
    const path = referencePath(suite, name, outputDir());
    if (written.has(path)) throw new Error(`two reference cases write ${path}: give them distinct names`);
    written.add(path);
    const file: ReferenceFile<T> = { suite, case: name, recordedBy: 'scripts/ci/record_adk_references.ts', adkVersion: await adkVersion(), reference: value };
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(file, null, 2)}\n`);
  }
  return value;
}

/** One suite's references: a case name and its live ADK side. */
export type AdkReference = <T>(name: string, live: () => T | Promise<T>) => Promise<T>;

/** `adkReference` bound to one suite. */
export function adkReferences(suite: string): AdkReference {
  return (name, live) => adkReference(suite, name, live);
}
