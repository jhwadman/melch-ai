/**
 * lib/observability/metadata.ts — labels a turn carries into the ledger as
 * `meta.<key>` root-span attributes (ADR 0141): static ones from the YAML
 * (`metadata:` on the syndicate, and on an agent as `meta.agent.<key>` on its
 * agent span), and per-request ones an A2A caller sends (the message's
 * `metadata` object and the `X-Melch-Meta-*` headers).
 *
 * The limits are one set wherever metadata comes from: a key is letters,
 * digits and `_ . : -` (at most 64, not starting with a punctuation mark), a
 * value is a string (at most 256 characters), a finite number or a boolean,
 * and a turn carries at most 32 keys. A value shaped like a credential
 * (REDACTION_PATTERNS.secret) is never kept: metadata is a label, and a key
 * pasted into one is dropped with a warning that names the key, never the
 * value. String values then pass through the telemetry redactor in force.
 */

import { REDACTION_PATTERNS, telemetryRedactor } from './redact.ts';
import type { Redactor } from './redact.ts';

export type MetadataValue = string | number | boolean;
export type Metadata = Record<string, MetadataValue>;

/** The attribute prefix: `meta.<key>` on the root span, `meta.agent.<key>` on an agent span. */
export const META_PREFIX = 'meta.';
export const META_AGENT_PREFIX = 'meta.agent.';
export const MAX_META_KEYS = 32;
export const MAX_META_KEY_CHARS = 64;
export const MAX_META_VALUE_CHARS = 256;
/** A metadata key: the same rule the desktop app's filters check before a key reaches SQL. */
export const META_KEY = /^[A-Za-z0-9_][A-Za-z0-9_.:-]{0,63}$/;
/** The request header family: `X-Melch-Meta-<key>: <value>` (Node lowercases header names, so the key arrives lowercase). */
export const META_HEADER_PREFIX = 'x-melch-meta-';

/** True when the value looks like a credential (the redactor's `secret` pattern). */
export function isSecretShaped(value: string): boolean {
  // A fresh, non-global copy: the shared pattern carries the `g` flag, whose lastIndex would make .test() stateful.
  return new RegExp(REDACTION_PATTERNS.secret.source).test(value);
}

/** Why one entry is not metadata, or undefined when it is. Never quotes the value. */
export function metadataEntryProblem(key: string, value: unknown): string | undefined {
  if (!META_KEY.test(key)) return `a metadata key is letters, digits and _ . : - (at most ${MAX_META_KEY_CHARS}, not starting with . : -)`;
  if (typeof value === 'string') {
    if (value.length > MAX_META_VALUE_CHARS) return `metadata.${key} is longer than ${MAX_META_VALUE_CHARS} characters`;
    return undefined;
  }
  if (typeof value === 'number') return Number.isFinite(value) ? undefined : `metadata.${key} is not a finite number`;
  if (typeof value === 'boolean') return undefined;
  return `metadata.${key} must be a string, a number or a boolean`;
}

/**
 * The entries whose value looks like a credential, dropped: the rest, and
 * one warning per dropped key (`where` names the place, e.g. a file and key path).
 */
export function dropSecretMetadata(meta: Metadata | undefined, where: string, warn: (message: string) => void): Metadata | undefined {
  if (!meta) return meta;
  let out: Metadata | undefined;
  for (const [key, value] of Object.entries(meta)) {
    if (typeof value === 'string' && isSecretShaped(value)) {
      out ??= { ...meta };
      delete out[key];
      warn(`⚠ ${where}.${key} looks like a key or token and is dropped: metadata is a label, never a credential.`);
    }
  }
  return out ?? meta;
}

/** Metadata as span attributes under `prefix`, string values through the telemetry redactor in force. */
export function metaAttributes(meta: Metadata | undefined, prefix = META_PREFIX, redactor: Redactor | undefined = telemetryRedactor()): Record<string, MetadataValue> {
  const out: Record<string, MetadataValue> = {};
  for (const [key, value] of Object.entries(meta ?? {})) {
    if (metadataEntryProblem(key, value) || (typeof value === 'string' && isSecretShaped(value))) continue;
    out[`${prefix}${key}`] = typeof value === 'string' && redactor ? redactor(value) : value;
  }
  return out;
}

/**
 * The `X-Melch-Meta-*` headers as metadata, or why the request is refused.
 * A header is an explicit act of this API, so a malformed one is refused
 * rather than dropped (as X-Surface is): a key outside the rule, a value
 * over the limit, more than 32 of them. A credential-shaped value is
 * dropped, its key listed in `dropped`, for the caller to warn about once
 * the request is authenticated (an anonymous request must not write logs).
 */
export function headerMetadata(headers: Record<string, string | string[] | undefined>): { meta?: Metadata; dropped?: string[]; error?: string } {
  const meta: Metadata = {};
  const dropped: string[] = [];
  let count = 0;
  for (const [name, raw] of Object.entries(headers)) {
    if (!name.toLowerCase().startsWith(META_HEADER_PREFIX) || raw === undefined) continue;
    const key = name.slice(META_HEADER_PREFIX.length).toLowerCase();
    const value = Array.isArray(raw) ? raw.join(', ') : raw;
    const problem = metadataEntryProblem(key, value);
    if (problem) return { error: `Invalid X-Melch-Meta-* header: ${problem.replace(/^metadata\.[^ ]+/, 'its value')}` };
    if (key.startsWith('agent.')) return { error: 'Invalid X-Melch-Meta-* header: keys starting "agent." are reserved for agent spans' };
    if (++count > MAX_META_KEYS) return { error: `Too many X-Melch-Meta-* headers: at most ${MAX_META_KEYS}` };
    if (isSecretShaped(value)) {
      dropped.push(key);
      continue;
    }
    meta[key] = value;
  }
  return count ? { meta, ...(dropped.length ? { dropped } : {}) } : {};
}

/** The warning for a header `headerMetadata` dropped: the key, never the value. */
export const droppedHeaderWarning = (key: string) => `⚠ X-Melch-Meta-${key} looks like a key or token and is dropped: metadata is a label, never a credential.`;

/**
 * A request's metadata from its sources, in precedence order (the first to
 * name a key wins): only scalar entries that pass the rules, never a key in
 * `reserved` (the YAML's own: a caller cannot relabel an operator's
 * metadata), never one starting `agent.`, at most `room` keys. A2A's
 * `Message.metadata` is shared by protocol extensions, so an entry that is
 * not metadata (a nested object, a long value, a key outside the rule) is
 * skipped, not refused; the warning counts what was skipped and names valid
 * keys only.
 */
export function requestMetadata(
  sources: ReadonlyArray<unknown>,
  options: { reserved?: ReadonlySet<string>; room?: number; warn?: (message: string) => void } = {},
): Metadata {
  const room = Math.max(0, Math.min(MAX_META_KEYS, options.room ?? MAX_META_KEYS));
  const out: Metadata = {};
  let kept = 0;
  let skipped = 0;
  let overflow = 0;
  for (const source of sources) {
    if (!source || typeof source !== 'object' || Array.isArray(source)) continue;
    for (const [key, value] of Object.entries(source as Record<string, unknown>)) {
      if (Object.prototype.hasOwnProperty.call(out, key)) continue;
      if (options.reserved?.has(key)) continue;
      if (metadataEntryProblem(key, value) || key.startsWith('agent.')) {
        skipped++;
        continue;
      }
      if (typeof value === 'string' && isSecretShaped(value)) {
        options.warn?.(`⚠ Request metadata ${key} looks like a key or token and is dropped: metadata is a label, never a credential.`);
        continue;
      }
      if (kept >= room) {
        overflow++;
        continue;
      }
      out[key] = value as MetadataValue;
      kept++;
    }
  }
  if (skipped) options.warn?.(`Request metadata: ${skipped} entr${skipped === 1 ? 'y is' : 'ies are'} not metadata (a key outside [A-Za-z0-9_.:-]{1,64}, a value that is not a short string, number or boolean) and skipped.`);
  if (overflow) options.warn?.(`Request metadata: ${overflow} key(s) over the limit of ${MAX_META_KEYS} per turn skipped.`);
  return out;
}
