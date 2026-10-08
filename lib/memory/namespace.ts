/**
 * lib/memory/namespace.ts — memory always resolves to the ROOT syndicate's
 * namespace (ADR 0020 item 3).
 *
 * WHY: ADK runs each DELEGATE subagent (AgentTool) as its own Runner under
 * `appName = <the subagent's name>`, and its memory tools search with that
 * name. Facts are written under the root syndicate's namespace, so a
 * `load_memory` declared on a subagent searched `<SubAgent>/<user>`, found
 * nothing, and said so without error. Wrapping the service the runtime hands
 * to ADK pins every search and ingestion to one namespace, whatever app
 * name the caller carries.
 *
 * The pin covers both interfaces a service may implement: ADK's
 * (`searchMemory`, `addSessionToMemory`) and the engine's MemoryService
 * (`search`, `ingest`, lib/runtime/memoryService.ts, ADR 0059). Every other
 * member, erase and retention included, passes through unchanged: they name
 * their key or namespace themselves.
 */

import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import type { BaseMemoryService } from '@google/adk';
import type { MemoryService } from '../runtime/memoryService.ts';

/** The four methods whose first argument carries the app name the pin replaces. */
const PINNED = new Set<PropertyKey>(['searchMemory', 'addSessionToMemory', 'search', 'ingest']);

/** A memory service whose every read and write uses `namespace` as the app name. */
export function namespacedMemoryService<T extends BaseMemoryService | MemoryService>(base: T, namespace: string): T {
  if (!namespace) throw new Error('namespacedMemoryService: namespace is required');
  return new Proxy(base, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (PINNED.has(prop) && typeof value === 'function') {
        // A search request or a session: the same object with the namespace as its app name.
        return (first: object, ...rest: unknown[]) =>
          (value as (...args: unknown[]) => unknown).call(target, { ...first, appName: namespace }, ...rest);
      }
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

// ── Declaring a namespace (ADR 0020 items 1 and 2) ───────────────────────────


/** The server-wide name memory falls back to when a syndicate declares none. */
export const LEGACY_MEMORY_APP_NAME = 'melchizedek-a2a';

const NAMESPACE_RE = /^[A-Za-z0-9._-]{1,96}$/;
const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567';

/**
 * `<name>.<8 random base32 chars>`, e.g. `support_triage.k3f9q2a8`. The name
 * is readable; the identifier keeps two copies of one template apart in a
 * shared database. Written once and never recomputed, so a rename does not
 * move memory.
 */
export function newMemoryNamespace(name: string, random: (n: number) => Buffer = randomBytes): string {
  const slug =
    name
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, '_')
      .replace(/^[_.-]+|[_.-]+$/g, '')
      .slice(0, 80) || 'syndicate';
  const id = [...random(8)].map((b) => BASE32[b % 32]).join('');
  const ns = `${slug}.${id}`;
  if (!NAMESPACE_RE.test(ns)) throw new Error(`generated namespace "${ns}" is not valid`);
  return ns;
}

export type AssignResult =
  | { status: 'assigned'; namespace: string }
  | { status: 'unchanged'; namespace: string };

/**
 * Writes `memory_namespace:` into one syndicate file, right after its
 * top-level `memory_system:` line (or `syndicate_name:`), leaving every
 * other byte as it was. A file that already declares one is left alone.
 */
export function assignMemoryNamespace(filePath: string, random?: (n: number) => Buffer): AssignResult {
  const text = fs.readFileSync(filePath, 'utf-8');
  const existing = /^memory_namespace:\s*["']?([^"'\s#]+)/m.exec(text);
  if (existing) return { status: 'unchanged', namespace: existing[1] };

  const namespace = newMemoryNamespace(path.basename(filePath).replace(/\.ya?ml$/, ''), random);
  const line = `memory_namespace: "${namespace}"`;
  const anchor = /^memory_system:.*$/m.exec(text) ?? /^syndicate_name:.*$/m.exec(text);
  const next = anchor
    ? text.slice(0, anchor.index + anchor[0].length) + `\n${line}` + text.slice(anchor.index + anchor[0].length)
    : `${line}\n${text}`;
  fs.writeFileSync(filePath, next);
  return { status: 'assigned', namespace };
}
