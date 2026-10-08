/**
 * tests/helpers/adkReference.ts — ADK's reference behaviour, recorded
 * (WS5-2a, ADR 0108).
 *
 * The parity suites prove the runtime does what ADK did: each case holds the
 * engine's side equal to ADK's, as WS5-2a recorded it against ADK 2.2 before
 * 1.0.0 removed ADK (ADR 0107):
 *
 *   const reference = adkReferences('nativeStep');
 *   const adk = await reference('plain-agent-two-turns');
 *
 * The value is read from tests/fixtures/adk-reference/<suite>/<case>.json.
 * The recordings are data: nothing re-records them, since there is no ADK to
 * run. A suite whose engine side changes on purpose updates the fixture in
 * the same change and says why.
 *
 * The canonical form the recordings were written in is JSON, made
 * deterministic: every UUID (in a value or a key) becomes a fixed one in
 * order of first appearance; the id of every stored event (an object with
 * string `id`, `invocationId` and `author`) becomes `ev000001`, …, wherever
 * that string appears, and its `timestamp` 2026-01-01 plus one second per
 * event in that order; any other time field (`timestamp`, `startTime`,
 * `endTime`) holding a stored event's original time takes that event's new
 * time. A suite passes its own side through `canonical` before comparing.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REFERENCE_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'adk-reference');

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

/** Reads one case's recorded ADK side (see the header). */
export async function adkReference<T>(suite: string, name: string): Promise<T> {
  const path = referencePath(suite, name);
  let body: string;
  try {
    body = readFileSync(path, 'utf8');
  } catch {
    throw new Error(`no ADK reference recorded for ${suite} / ${name} (${path})`);
  }
  return (JSON.parse(body) as ReferenceFile<T>).reference;
}

/** One suite's references: a case name to its recorded ADK side. */
export type AdkReference = <T>(name: string) => Promise<T>;

/** `adkReference` bound to one suite. */
export function adkReferences(suite: string): AdkReference {
  return (name) => adkReference(suite, name);
}
