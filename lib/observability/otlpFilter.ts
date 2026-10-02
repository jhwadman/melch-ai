/**
 * lib/observability/otlpFilter.ts — what leaves for an external trace backend.
 *
 * Spans carry the conversation: a turn's input and output, the model's
 * thinking, tool arguments and results, the full request and response. The
 * ledger scrubs those before it writes them (redact.ts, TELEMETRY_REDACT); an
 * OTLP backend is a third party, so the same rule applies on the way out,
 * and an adopter can choose to send no conversation at all.
 *
 *   OTEL_EXPORT_CONTENT=redacted   (default) the ledger's redactor runs on
 *                                  every text attribute and event
 *   OTEL_EXPORT_CONTENT=off        conversation attributes are dropped (the
 *                                  engine's and any library's, by name) and
 *                                  the user id is hashed; timings, models,
 *                                  token counts, routes, error codes and ids
 *                                  remain
 *   OTEL_EXPORT_CONTENT=raw        spans are sent as recorded
 */
import { createHash } from 'node:crypto';
import type { ReadableSpan, SpanExporter } from '@opentelemetry/sdk-trace-base';
import type { Redactor } from './redact.ts';

export type OtlpContentMode = 'redacted' | 'off' | 'raw';

/** Span attributes that carry what a conversation said. */
export const CONTENT_ATTRIBUTES = new Set([
  'syndicate.input',
  'syndicate.output',
  'syndicate.bindings',
  'syndicate.route.reason',
  'syndicate.error.message',
  'llm.thinking',
  'llm.error_message',
  'tool.args',
  'tool.data_gathered',
]);
const CONTENT_PREFIXES = ['llm.payload.'];
const PERSON_ATTRIBUTES = new Set(['user.id']);

/**
 * Libraries add their own content attributes (ADK puts the whole model request
 * on its call_llm span as `gcp.vertex.agent.llm_request`, and the response and
 * tool calls beside it), and a later version can add more. So `off` also drops
 * any text attribute whose name says it carries content, unless the name says
 * it is metadata (a model, a name, an id, a finish reason).
 */
const CONTENT_KEY = /(^|[._])(request|response|input|output|args|arguments|prompt|completion|messages?|content|thinking|payload|data_gathered|bindings|reason|error_message)([._]|$)/i;
const METADATA_KEY = /([._])(model|name|id|system|description|finish_reasons|type|kind|version|stage)$/i;

export function otlpContentMode(env: NodeJS.ProcessEnv = process.env): OtlpContentMode {
  const raw = (env.OTEL_EXPORT_CONTENT ?? 'redacted').trim().toLowerCase();
  if (raw === 'off' || raw === 'none' || raw === 'false') return 'off';
  if (raw === 'raw') return 'raw';
  return 'redacted';
}

const isText = (v: unknown) => typeof v === 'string' || (Array.isArray(v) && v.some((x) => typeof x === 'string'));
const isContent = (key: string, value: unknown) =>
  CONTENT_ATTRIBUTES.has(key) ||
  CONTENT_PREFIXES.some((p) => key.startsWith(p)) ||
  (isText(value) && CONTENT_KEY.test(key) && !METADATA_KEY.test(key));
const hashed = (v: unknown) => `sha256:${createHash('sha256').update(String(v)).digest('hex').slice(0, 16)}`;

/** One span's attributes as they may leave under `mode`. */
export function filterAttributes(
  attributes: Record<string, unknown>,
  mode: OtlpContentMode,
  redactor: Redactor | undefined,
): Record<string, unknown> {
  if (mode === 'raw') return attributes;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(attributes)) {
    if (mode === 'off') {
      if (isContent(key, value)) continue;
      out[key] = PERSON_ATTRIBUTES.has(key) ? hashed(value) : value;
      continue;
    }
    out[key] =
      redactor && typeof value === 'string'
        ? redactor(value)
        : redactor && Array.isArray(value)
          ? value.map((v) => (typeof v === 'string' ? redactor(v) : v))
          : value;
  }
  return out;
}

/** A span whose attributes and events are filtered; everything else reads through. */
function filtered(span: ReadableSpan, mode: OtlpContentMode, redactor: Redactor | undefined): ReadableSpan {
  const view = Object.create(span) as ReadableSpan;
  Object.defineProperty(view, 'attributes', { value: filterAttributes(span.attributes as Record<string, unknown>, mode, redactor) });
  Object.defineProperty(view, 'events', {
    value: span.events.map((e) => (e.attributes ? { ...e, attributes: filterAttributes(e.attributes as Record<string, unknown>, mode, redactor) } : e)),
  });
  return view;
}

/** Wraps the OTLP exporter so every span is filtered before it is sent. */
export class FilteringSpanExporter implements SpanExporter {
  private readonly inner: SpanExporter;
  private readonly mode: OtlpContentMode;
  private readonly redactor: Redactor | undefined;

  constructor(inner: SpanExporter, mode: OtlpContentMode, redactor: Redactor | undefined) {
    this.inner = inner;
    this.mode = mode;
    this.redactor = redactor;
  }

  export(spans: ReadableSpan[], resultCallback: Parameters<SpanExporter['export']>[1]): void {
    this.inner.export(this.mode === 'raw' ? spans : spans.map((s) => filtered(s, this.mode, this.redactor)), resultCallback);
  }

  shutdown(): Promise<void> {
    return this.inner.shutdown();
  }

  forceFlush(): Promise<void> {
    return this.inner.forceFlush?.() ?? Promise.resolve();
  }
}
