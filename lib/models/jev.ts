/**
 * lib/models/jev.ts — TypeSafe's System One wire (Jev), and the typed
 * question API over it.
 *
 * WHY this file exists:
 *   Jev is not a chat model. One request carries a `state` (the text to
 *   decide about) and a map of typed `questions`; the answer is one typed
 *   decision per question with calibrated probabilities, never free text,
 *   never a tool call (https://docs.typesafe.ai/api). This module owns that
 *   wire and the two translations the engine needs on top of it:
 *
 *   - `questionsFromSchema`: an agent's `output.schema` (lowercase JSON
 *     Schema) becomes Jev questions, one per property: a boolean is a noul
 *     (yes/no) question, a string with an `enum` or a `oneOf` of described
 *     constants is a choice, an integer whose `oneOf` describes levels
 *     0..n-1 in order is a score. The property's `description` is the
 *     question's instruction. So the same classifier YAML runs on Jev or on
 *     any chat model with structured output: only `model:` changes.
 *   - `objectFromAnswers`: Jev's answers become the JSON object the schema
 *     describes (a boolean, the chosen string, the most probable level),
 *     with the raw answers, probabilities included, under a reserved `jev`
 *     key, so a caller can act on confidence.
 *
 *   `decide()` is the typed call for code: question builders infer the
 *   answer types (`noul`, `choice`, `score`), so `answers.department.choice`
 *   is typed to the criteria given. The adapter (lib/models/jevAdapter.ts)
 *   uses the same call.
 *
 * WHERE REQUESTS GO:
 *   direct     https://api.typesafe.ai/v1/systemone, TYPESAFE_API_KEY
 *              (TYPESAFE_BASE_URL for a proxy speaking the same wire)
 *   gateway    a gateway's System One endpoint when TYPESAFE_API_KEY is
 *              absent and MODEL_GATEWAY is set (lib/models/gateway.ts):
 *              Vercel AI Gateway at /typesafe/v1/systemone, OpenRouter at
 *              /api/v1/systemone, each with its own model ids.
 *
 * A LEAF beside gateway.ts: it imports the gateway table for the System
 * One routes, the credential source and the retry policy, nothing else.
 */

import { credentialValue } from './credentialSource.ts';
import { GATEWAY_KEY_ENV, gatewayConfig, gatewaySystemOneModel } from './gateway.ts';
import type { GatewayConfig } from './gateway.ts';
import { fetchWithRetry, isRetryableStatus } from './retry.ts';
import { trimTrailingSlashes } from './urls.ts';

export const TYPESAFE_KEY_ENV = 'TYPESAFE_API_KEY';
export const TYPESAFE_BASE_URL_ENV = 'TYPESAFE_BASE_URL';
/** TypeSafe's own API root; `/systemone` and `/models` hang off it. */
export const TYPESAFE_API_BASE = 'https://api.typesafe.ai/v1';
export const TYPESAFE_CONSOLE_URL = 'https://console.typesafe.ai/keys';

// ── Questions ────────────────────────────────────────────────────────────────

/** A yes/no question: the answer is the probability of yes. */
export interface JevNoul {
  type: 'noul';
  instructions: string;
  /** What each outcome means, when the words alone are ambiguous. */
  criteria?: { true: string; false: string };
}

/** Pick one of up to 255 named options, each described. */
export interface JevChoice<K extends string = string> {
  type: 'choice';
  instructions: string;
  criteria: Record<K, string>;
}

/** Rate on an ordered scale of 1 to 10 levels; position is the score, from 0. */
export interface JevScore {
  type: 'score';
  instructions: string;
  criteria: readonly string[];
}

export type JevQuestion = JevNoul | JevChoice | JevScore;
export type JevQuestions = Record<string, JevQuestion>;

export function noul(instructions: string, criteria?: { true: string; false: string }): JevNoul {
  return { type: 'noul', instructions, ...(criteria ? { criteria } : {}) };
}

export function choice<const C extends Record<string, string>>(instructions: string, criteria: C): JevChoice<keyof C & string> {
  return { type: 'choice', instructions, criteria };
}

export function score(instructions: string, criteria: readonly string[]): JevScore {
  return { type: 'score', instructions, criteria };
}

// ── Answers ──────────────────────────────────────────────────────────────────

export interface JevNoulAnswer {
  type: 'noul';
  /** The probability of yes, 0 to 1. */
  noul: number;
}

export interface JevChoiceAnswer<K extends string = string> {
  type: 'choice';
  /** The most probable option. */
  choice: K;
  confidence: number;
  /** Each option's probability; they sum to about 1. */
  probabilities: Record<K, number>;
}

export interface JevScoreAnswer {
  type: 'score';
  /** The probability-weighted mean level; may fall between levels. */
  score: number;
  confidence: number;
  /** Level → its criterion. */
  legend: Record<string, string>;
  /** Level → its probability. */
  probabilities: Record<string, number>;
}

export type JevAnswer = JevNoulAnswer | JevChoiceAnswer | JevScoreAnswer;

export type JevAnswerFor<Q extends JevQuestion> = Q extends JevNoul
  ? JevNoulAnswer
  : Q extends JevChoice<infer K>
    ? JevChoiceAnswer<K>
    : Q extends JevScore
      ? JevScoreAnswer
      : never;

export type JevAnswers<Q extends JevQuestions> = { [K in keyof Q]: JevAnswerFor<Q[K]> };

/** The text Jev decides about: a string, a JSON object, or several texts. */
export type JevState = string | Record<string, unknown> | unknown[];

export interface JevRequest<Q extends JevQuestions = JevQuestions> {
  /** A model id as the YAML names it (`jev-latest`); the endpoint maps it to its wire name. */
  model: string;
  state: JevState;
  questions: Q;
}

export interface JevUsage {
  input_tokens: number;
  /** Billed at zero today, still counted. */
  output_tokens: number;
}

export interface JevResponse<Q extends JevQuestions = JevQuestions> {
  model: string;
  answers: JevAnswers<Q>;
  usage: JevUsage;
}

// ── The endpoint ─────────────────────────────────────────────────────────────

export type JevErrorCode =
  | 'TYPESAFE_MISSING_KEY'
  | 'TYPESAFE_SCHEMA_REQUIRED'
  | 'TYPESAFE_SCHEMA_UNSUPPORTED'
  | 'TYPESAFE_HTTP_ERROR'
  | 'TYPESAFE_UNREACHABLE'
  | 'TYPESAFE_BAD_ANSWER';

/** A System One failure, in the words the adapter's error final carries. Never holds a key. */
export class JevError extends Error {
  readonly code: JevErrorCode;
  readonly retryable: boolean;
  readonly status?: number;
  constructor(code: JevErrorCode, message: string, opts: { retryable?: boolean; status?: number; cause?: unknown } = {}) {
    super(message, opts.cause !== undefined ? { cause: opts.cause } : undefined);
    this.name = 'JevError';
    this.code = code;
    this.retryable = opts.retryable ?? false;
    if (opts.status !== undefined) this.status = opts.status;
  }
}

export interface JevEndpoint {
  /** The System One URL requests post to. */
  url: string;
  /** The bearer, or undefined when nothing funds this path. */
  apiKey: string | undefined;
  /** The id this endpoint knows the YAML model by. */
  wireModel: (model: string) => string;
  /** `direct`, or `gateway:<id>`. */
  transport: string;
  /** For error messages: "TypeSafe", "Vercel AI Gateway". */
  label: string;
  /** Which variable would fund the path, for the missing-key message. */
  keyEnv: string;
}

export interface JevEndpointOptions {
  /** A caller's own TypeSafe key (BYOK); wins over the environment's. */
  apiKey?: string;
  /** A proxy speaking TypeSafe's wire; default TYPESAFE_BASE_URL, else TypeSafe's API. */
  baseUrl?: string;
  /** The gateway this path runs through, when the direct key is absent. */
  gateway?: GatewayConfig | null;
}

/** Where a Jev request goes: TypeSafe's API with its key, or a gateway's System One route with the gateway's. */
export function jevEndpoint(opts: JevEndpointOptions = {}): JevEndpoint {
  if (opts.gateway) {
    const { gateway } = opts.gateway;
    return {
      url: gateway.systemOne.url,
      apiKey: credentialValue(GATEWAY_KEY_ENV) || undefined,
      wireModel: (model) => gatewaySystemOneModel(model, gateway),
      transport: `gateway:${gateway.id}`,
      label: gateway.label,
      keyEnv: GATEWAY_KEY_ENV,
    };
  }
  const base = trimTrailingSlashes(opts.baseUrl || credentialValue(TYPESAFE_BASE_URL_ENV) || TYPESAFE_API_BASE);
  return {
    url: `${base}/systemone`,
    apiKey: opts.apiKey || credentialValue(TYPESAFE_KEY_ENV) || undefined,
    wireModel: (model) => model,
    transport: 'direct',
    label: 'TypeSafe',
    keyEnv: TYPESAFE_KEY_ENV,
  };
}

/** The direct endpoint, or the configured gateway's when TYPESAFE_API_KEY is absent (the transport rule). */
export function jevEndpointFromEnv(opts: Pick<JevEndpointOptions, 'apiKey' | 'baseUrl'> = {}): JevEndpoint {
  const direct = jevEndpoint(opts);
  if (direct.apiKey) return direct;
  const gateway = gatewayConfig();
  return gateway?.keyPresent ? jevEndpoint({ gateway }) : direct;
}

export interface DecideOptions {
  endpoint?: JevEndpoint;
  signal?: AbortSignal;
  /** How many transient retries ran, for the span. */
  onRetry?: (retries: number) => void;
}

/**
 * One System One call, typed on its questions. Throws JevError: a missing
 * key, a non-2xx status (retryable when lib/models/retry.ts says so), an
 * unreachable endpoint, or an answer that does not match the questions.
 */
export async function decide<Q extends JevQuestions>(request: JevRequest<Q>, opts: DecideOptions = {}): Promise<JevResponse<Q>> {
  const endpoint = opts.endpoint ?? jevEndpointFromEnv();
  if (!endpoint.apiKey) {
    throw new JevError('TYPESAFE_MISSING_KEY', `${endpoint.keyEnv} is not set, so ${request.model} has no route (a key from ${TYPESAFE_CONSOLE_URL}, or a MODEL_GATEWAY).`);
  }
  const body = { model: endpoint.wireModel(request.model), state: request.state, questions: request.questions };
  let res: Response;
  try {
    const out = await fetchWithRetry(
      endpoint.url,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${endpoint.apiKey}` },
        body: JSON.stringify(body),
        ...(opts.signal ? { signal: opts.signal } : {}),
      },
      { ...(opts.signal ? { signal: opts.signal } : {}), onRetry: ({ retries }) => opts.onRetry?.(retries) },
    );
    res = out.response;
  } catch (err) {
    const aborted = !!opts.signal?.aborted;
    throw new JevError('TYPESAFE_UNREACHABLE', `Could not reach ${endpoint.label} at ${safeUrl(endpoint.url)} (${plainMessage(err)}).`, { retryable: !aborted, cause: err });
  }
  if (!res.ok) {
    const detail = (await res.text().catch(() => '')).slice(0, 4000);
    const hint = res.status === 404 || res.status === 422 ? ` If the model id is the problem, map it with MODEL_GATEWAY_MODEL_MAP=${request.model}=<the gateway's id>, or check GET ${safeUrl(endpoint.url).replace(/\/systemone$/, '/models')}.` : '';
    throw new JevError('TYPESAFE_HTTP_ERROR', `${endpoint.label} returned ${res.status} for ${body.model}: ${detail}.${endpoint.transport === 'direct' ? '' : hint}`, {
      retryable: isRetryableStatus(res.status) && !opts.signal?.aborted,
      status: res.status,
    });
  }
  let data: unknown;
  try {
    data = await res.json();
  } catch (err) {
    throw new JevError('TYPESAFE_BAD_ANSWER', `${endpoint.label} answered with something other than JSON (${plainMessage(err)}).`, { cause: err });
  }
  return readResponse(data, request, endpoint.label);
}

/** Validates the wire answer against the questions asked. */
function readResponse<Q extends JevQuestions>(data: unknown, request: JevRequest<Q>, label: string): JevResponse<Q> {
  const d = data as { model?: unknown; answers?: unknown; usage?: unknown };
  if (!d || typeof d !== 'object' || !d.answers || typeof d.answers !== 'object') {
    throw new JevError('TYPESAFE_BAD_ANSWER', `${label} answered without an answers map.`);
  }
  const answers = d.answers as Record<string, unknown>;
  for (const [name, q] of Object.entries(request.questions)) {
    const a = answers[name] as Record<string, unknown> | undefined;
    if (!a || typeof a !== 'object' || a.type !== q.type) {
      throw new JevError('TYPESAFE_BAD_ANSWER', `${label} answered without a ${q.type} decision for "${name}".`);
    }
    const value = a[q.type];
    const ok = q.type === 'choice' ? typeof value === 'string' : typeof value === 'number';
    if (!ok) throw new JevError('TYPESAFE_BAD_ANSWER', `${label}'s ${q.type} decision for "${name}" carries no ${q.type} value.`);
  }
  const u = (d.usage ?? {}) as Partial<JevUsage>;
  return {
    model: typeof d.model === 'string' ? d.model : request.model,
    answers: answers as JevAnswers<Q>,
    usage: { input_tokens: count(u.input_tokens), output_tokens: count(u.output_tokens) },
  };
}

const count = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0);

function plainMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** A URL with no query string or userinfo, for messages. */
function safeUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname}`;
  } catch {
    return '(invalid URL)';
  }
}

// ── An output schema as questions ────────────────────────────────────────────

/** The key the decisions object keeps Jev's raw answers under. */
export const JEV_ANSWERS_KEY = 'jev';

type SchemaNode = Record<string, unknown>;

/** A `oneOf` of described constants: `[{ const, description }, …]`, or undefined when the node has none. */
function describedConstants(node: SchemaNode): Array<{ value: unknown; description: string }> | undefined {
  const options = (node.oneOf ?? node.anyOf) as unknown;
  if (!Array.isArray(options) || options.length === 0) return undefined;
  const out: Array<{ value: unknown; description: string }> = [];
  for (const o of options) {
    if (!o || typeof o !== 'object' || !('const' in o)) return undefined;
    const description = typeof (o as SchemaNode).description === 'string' ? ((o as SchemaNode).description as string) : String((o as SchemaNode).const);
    out.push({ value: (o as SchemaNode).const, description });
  }
  return out;
}

const typeOf = (node: SchemaNode): string | undefined => {
  const t = node.type;
  if (typeof t === 'string') return t;
  if (Array.isArray(t)) return t.find((x) => x !== 'null') as string | undefined;
  return undefined;
};

/** The instruction for a property: its description, else its name in words. */
const instructionOf = (name: string, node: SchemaNode): string =>
  typeof node.description === 'string' && node.description.trim() ? node.description.trim() : name.replace(/[_-]+/g, ' ');

/**
 * The questions an `output.schema` asks, one per property. Throws JevError
 * (`TYPESAFE_SCHEMA_UNSUPPORTED`) naming the first property Jev cannot
 * answer, and what it takes instead: a boolean; a string with `enum` or a
 * `oneOf` of described constants; an integer whose `oneOf` describes the
 * levels 0..n-1 in order (at most 10). Nested objects, arrays, free strings
 * and numbers are not decisions. A property named `jev` is refused: the
 * answer object keeps the raw answers there.
 */
export function questionsFromSchema(schema: unknown): JevQuestions {
  const root = (schema ?? {}) as SchemaNode;
  const properties = root.properties as Record<string, SchemaNode> | undefined;
  if (!properties || typeof properties !== 'object' || Object.keys(properties).length === 0) {
    throw new JevError('TYPESAFE_SCHEMA_REQUIRED', 'Jev answers typed questions: give the agent an output.schema with at least one boolean, enum or levelled-integer property.');
  }
  const questions: JevQuestions = {};
  for (const [name, node] of Object.entries(properties)) {
    if (name === JEV_ANSWERS_KEY) {
      throw new JevError('TYPESAFE_SCHEMA_UNSUPPORTED', `output.schema property "${name}" is reserved: the answer keeps Jev's raw decisions and probabilities under it.`);
    }
    questions[name] = questionFor(name, node ?? {});
  }
  return questions;
}

function questionFor(name: string, node: SchemaNode): JevQuestion {
  const type = typeOf(node);
  const constants = describedConstants(node);
  const instructions = instructionOf(name, node);
  if (type === 'boolean') {
    const pair = constants?.length === 2 && constants.every((c) => typeof c.value === 'boolean') ? constants : undefined;
    const t = pair?.find((c) => c.value === true)?.description;
    const f = pair?.find((c) => c.value === false)?.description;
    return noul(instructions, t && f ? { true: t, false: f } : undefined);
  }
  if (type === 'string' || (!type && (constants || Array.isArray(node.enum)))) {
    const criteria: Record<string, string> = {};
    if (constants) {
      for (const c of constants) {
        if (typeof c.value !== 'string') return unsupported(name, 'a string oneOf whose every const is a string');
        criteria[c.value] = c.description;
      }
    } else if (Array.isArray(node.enum)) {
      for (const v of node.enum) {
        if (typeof v !== 'string') return unsupported(name, 'a string enum of strings');
        criteria[v] = v;
      }
    } else {
      return unsupported(name, 'a string with an enum, or a oneOf of described constants');
    }
    const n = Object.keys(criteria).length;
    if (n < 1 || n > 255) return unsupported(name, 'between 1 and 255 options');
    return { type: 'choice', instructions, criteria };
  }
  if (type === 'integer' || type === 'number') {
    if (!constants) return unsupported(name, 'an integer whose oneOf describes the levels 0..n-1 in order (at most 10)');
    const levels: string[] = [];
    for (const [i, c] of constants.entries()) {
      if (c.value !== i) return unsupported(name, `an integer whose oneOf lists the levels 0..${constants.length - 1} in order (level ${i} is ${JSON.stringify(c.value)})`);
      levels.push(c.description);
    }
    if (levels.length < 1 || levels.length > 10) return unsupported(name, 'between 1 and 10 levels');
    return { type: 'score', instructions, criteria: levels };
  }
  return unsupported(name, 'a boolean, a string with an enum or a oneOf of described constants, or an integer whose oneOf describes its levels');
}

function unsupported(name: string, takes: string): never {
  throw new JevError('TYPESAFE_SCHEMA_UNSUPPORTED', `output.schema property "${name}" is not a decision Jev can make; it takes ${takes}.`);
}

/**
 * The JSON object the schema describes, from Jev's answers: a boolean for a
 * noul (yes at 0.5 and above), the chosen string for a choice, the most
 * probable level for a score (the weighted mean is in the raw answer). The
 * raw answers, probabilities and confidence included, sit under `jev`.
 */
export function objectFromAnswers(questions: JevQuestions, answers: Record<string, JevAnswer>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [name, q] of Object.entries(questions)) {
    const a = answers[name];
    if (q.type === 'noul' && a.type === 'noul') out[name] = a.noul >= 0.5;
    else if (q.type === 'choice' && a.type === 'choice') out[name] = a.choice;
    else if (q.type === 'score' && a.type === 'score') out[name] = mostProbableLevel(a);
  }
  out[JEV_ANSWERS_KEY] = answers;
  return out;
}

/** The level with the highest probability; the rounded mean when no probabilities came. */
function mostProbableLevel(a: JevScoreAnswer): number {
  const entries = Object.entries(a.probabilities ?? {}).map(([k, p]) => [Number(k), p] as const).filter(([k, p]) => Number.isInteger(k) && typeof p === 'number');
  if (!entries.length) return Math.round(a.score);
  let best = entries[0]!;
  for (const e of entries) if (e[1] > best[1] || (e[1] === best[1] && e[0] < best[0])) best = e;
  return best[0];
}
