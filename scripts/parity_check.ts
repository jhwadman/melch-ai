#!/usr/bin/env node
/**
 * scripts/parity_check.ts — does the engine's core work on every funded
 * provider? (`npm run parity`)
 *
 * One fixed syndicate (tests/fixtures/parity.yaml) runs through
 * runSyndicateTurn once per provider the environment funds, its model ids
 * bound to that provider's, on an in-memory session. Four turns on one
 * conversation, six checks:
 *
 *   delegation   the orchestrator calls a subagent with an argument (a code
 *                word) and the subagent's reply carries it back
 *   client tool  a client-side function tool runs on the argument it was
 *                asked for, and the answer uses the value it returned
 *   structured   a subagent with an outputSchema returns JSON that parses
 *                against the schema the YAML declares
 *   streaming    a streamed turn yields text deltas
 *   second turn  a later turn on the same session names the first turn's code word
 *   token usage  every completed turn reports input and output tokens
 *
 * Funded means what the doctor means (lib/doctor.ts): providerStatuses() says
 * a direct key, a cloud platform or the gateway serves the provider. Ollama
 * runs only when its endpoint answers. The report is a provider-by-check
 * table on stdout and a JSON file under outputs/ (gitignored); the exit code
 * is non-zero when any check fails or nothing ran. Only provider ids, model
 * ids, check outcomes and timings are printed — never a key, a header or a
 * request body. Provider error text goes to the JSON file only, scrubbed of
 * key-shaped strings.
 *
 * MELCHIZEDEK_RUNTIME (adk | native, default adk) picks the runtime every
 * turn runs on (the turn's runtime option, ADR 0073), and the report records
 * it.
 *
 * --scripted swaps every provider's models for scripted ones
 * (tests/helpers/scriptedLlm.ts) so the harness tests itself offline;
 * --fault <check> (scripted only) makes the scripted models break that
 * behaviour, which must fail exactly that check. tests/parityHarness.test.ts
 * runs both.
 *
 * Usage:
 *   npm run parity
 *   npm run parity -- --providers gemini,anthropic
 *   npm run parity -- --model anthropic=claude-haiku-4-5
 *   npm run parity -- --timeout 180          # per-turn deadline, seconds (default 120)
 *   npm run parity -- --out /tmp/parity      # report directory (default outputs/)
 *   npm run parity -- --scripted [--fault structured]
 *   MELCHIZEDEK_RUNTIME=native npm run parity
 *
 * Exit: 0 every check passed · 1 a check failed, or no provider ran · 2 a usage error.
 */

import { randomBytes } from 'node:crypto';
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { InMemorySessionService } from '@google/adk';
import type { BaseLlm, LlmRequest, LlmResponse } from '@google/adk';
import { z } from 'zod';

import {
  DEFAULT_CLAUDE_MODEL,
  DEFAULT_GEMINI_MODEL,
  DEFAULT_GPT_MODEL,
  DEFAULT_GROK_MODEL,
  DEFAULT_KIMI_MODEL,
  DEFAULT_OLLAMA_MODEL,
} from '../lib/config.ts';
import { loadEnv } from '../lib/loadEnv.ts';
import { loadSyndicate } from '../lib/loadSyndicate.ts';
import type { SyndicateYamlConfig } from '../lib/loadSyndicate.ts';
import { PROVIDERS, providerForModel, providerStatuses } from '../lib/models/registry.ts';
import type { ProviderId } from '../lib/models/registry.ts';
import { toLowercaseJsonSchema } from '../lib/models/schemaNormalize.ts';
import { patternRedactor } from '../lib/observability/redact.ts';
import { flushTracing } from '../lib/observability/tracer.ts';
import { setLogLevel } from '../lib/runtime/logging.ts';
import { runSyndicateTurn } from '../lib/runtime/syndicateTurn.ts';
import type { SyndicateTurnResult, TurnEvents } from '../lib/runtime/syndicateTurn.ts';
import { registerTool } from '../lib/toolRegistry.ts';
import { defineTool } from '../lib/tools/toolContract.ts';
import { ScriptedLlm, call, streamed, text } from '../tests/helpers/scriptedLlm.ts';
import type { Script } from '../tests/helpers/scriptedLlm.ts';

// ── The checks ───────────────────────────────────────────────────────────────

export const CHECKS = ['delegation', 'tool', 'structured', 'streaming', 'session', 'usage'] as const;
export type CheckId = (typeof CHECKS)[number];

const CHECK_LABELS: Record<CheckId, string> = {
  delegation: 'delegation',
  tool: 'client tool',
  structured: 'structured output',
  streaming: 'streaming',
  session: 'second turn',
  usage: 'token usage',
};

export type Runtime = 'adk' | 'native';

export interface CheckResult {
  id: CheckId;
  pass: boolean;
  /** Harness-written: what passed, or why not. Never provider text. */
  detail: string;
}

export interface TurnRecord {
  name: TurnName;
  status: SyndicateTurnResult['status'] | 'threw';
  durationMs: number;
  llmCalls: number;
  inputTokens: number;
  outputTokens: number;
  thinkingTokens: number;
  /** Code as the provider or the turn runner gave it; message scrubbed and cut. */
  error?: { code: string; message: string };
}

export interface ProviderReport {
  provider: ProviderId;
  label: string;
  transport: 'direct' | 'gateway' | 'scripted';
  gateway?: string;
  models: { orchestrator: string; subagent: string };
  durationMs: number;
  turns: TurnRecord[];
  checks: CheckResult[];
  pass: boolean;
}

export interface ParityReport {
  harness: 'parity';
  version: 1;
  mode: 'live' | 'scripted';
  /** What MELCHIZEDEK_RUNTIME asked for, and what ran: always the same since the turn takes a runtime option. */
  runtime: { requested: Runtime; ran: Runtime };
  faults?: CheckId[];
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  providers: ProviderReport[];
  skipped: Array<{ provider: ProviderId; reason: string }>;
  pass: boolean;
}

export interface ParityOptions {
  /** Scripted models instead of providers: the offline self-test. */
  scripted?: boolean;
  /** Scripted only: behaviours the scripted models break. */
  faults?: CheckId[];
  /** Only these providers. Default: every provider. */
  providers?: ProviderId[];
  /** A model id per provider instead of its default. */
  models?: Partial<Record<ProviderId, string>>;
  runtime?: Runtime;
  /** Deadline for one turn, in ms. */
  turnTimeoutMs?: number;
  /** Progress lines. */
  log?: (line: string) => void;
}

export class UsageError extends Error {}

// ── Fixture, prompts, the harness's own tool ─────────────────────────────────

const FIXTURES_DIR = fileURLToPath(new URL('../tests/fixtures/', import.meta.url));
const FIXTURE = 'parity.yaml';
const APP_NAME = 'parity';
const USER_ID = 'parity-harness';
const DEFAULT_TURN_TIMEOUT_MS = 120_000;
const ERROR_MESSAGE_MAX = 500;
const CODE_RE = /PARITY-[0-9A-F]{6}/i;

/** The model a provider runs when --model names none: the framework's default for it. */
const DEFAULT_MODEL: Record<ProviderId, string> = {
  gemini: DEFAULT_GEMINI_MODEL,
  anthropic: DEFAULT_CLAUDE_MODEL,
  openai: DEFAULT_GPT_MODEL,
  xai: DEFAULT_GROK_MODEL,
  moonshot: DEFAULT_KIMI_MODEL,
  ollama: DEFAULT_OLLAMA_MODEL,
};

type TurnName = 'delegate' | 'tool' | 'structured' | 'followup';

const PROMPTS = {
  delegate: (code: string) => `Ask Echo to repeat the code word ${code}. Then tell me exactly what Echo replied.`,
  tool: () => 'Use the parity_lookup tool to look up the key "alpha", then reply with the value it returns.',
  structured: (code: string) => `Ask Recorder to file a record for the city Lisbon with the code word ${code} and the count 3. Then confirm it was filed.`,
  followup: () => 'What was the code word in my first message? Reply with the code word only.',
};

/** Per conversation: the value parity_lookup returns, and what it was asked. */
const lookups = new Map<string, { value: string; calls: number; hits: number }>();

const parityLookup = defineTool({
  name: 'parity_lookup',
  description: 'Looks up the value stored under a key for this conversation and returns it.',
  schema: z.object({ key: z.string().describe('The key to look up, for example "alpha".') }),
  execute: async ({ key }, context) => {
    const entry = context?.sessionId ? lookups.get(context.sessionId) : undefined;
    if (!entry) return 'Error: no values are stored for this conversation.';
    entry.calls += 1;
    if (key.trim().replace(/^["']|["']$/g, '').toLowerCase() !== 'alpha') return `No value is stored under "${key}".`;
    entry.hits += 1;
    return entry.value;
  },
});

let lookupRegistered = false;

/** The harness's tool is registered in its own process only, never on a server. */
function registerLookup(): void {
  if (lookupRegistered) return;
  registerTool(parityLookup.name, parityLookup, { override: true });
  lookupRegistered = true;
}

const hex = (bytes: number) => randomBytes(bytes).toString('hex').toUpperCase();
const scrub = patternRedactor(['secret']);

// ── Which providers run ──────────────────────────────────────────────────────

interface Target {
  provider: ProviderId;
  transport: ProviderReport['transport'];
  gateway?: string;
  model: string;
  resolveModel?: (id: string | undefined) => BaseLlm;
}

/** Ollama is funded by being there: its OpenAI-compatible endpoint must answer. */
async function ollamaAnswers(): Promise<boolean> {
  const baseUrl = process.env.OLLAMA_BASE_URL || 'http://localhost:11434/v1';
  try {
    const res = await fetch(`${baseUrl}/models`, { signal: AbortSignal.timeout(1500) });
    return res.ok;
  } catch {
    return false;
  }
}

async function liveTargets(opts: ParityOptions): Promise<{ targets: Target[]; skipped: ParityReport['skipped'] }> {
  const targets: Target[] = [];
  const skipped: ParityReport['skipped'] = [];
  for (const s of providerStatuses()) {
    if (opts.providers && !opts.providers.includes(s.provider)) continue;
    const model = opts.models?.[s.provider] ?? DEFAULT_MODEL[s.provider];
    if (!s.available) {
      skipped.push({ provider: s.provider, reason: s.reason ?? 'not funded' });
    } else if (s.provider === 'ollama' && !(await ollamaAnswers())) {
      skipped.push({ provider: s.provider, reason: 'endpoint did not answer' });
    } else {
      targets.push({ provider: s.provider, transport: s.transport ?? 'direct', ...(s.gateway ? { gateway: s.gateway } : {}), model });
    }
  }
  return { targets, skipped };
}

function scriptedTargets(opts: ParityOptions): Target[] {
  const faults = new Set(opts.faults ?? []);
  return (Object.keys(PROVIDERS) as ProviderId[])
    .filter((p) => !opts.providers || opts.providers.includes(p))
    .map((provider) => ({
      provider,
      transport: 'scripted' as const,
      model: opts.models?.[provider] ?? DEFAULT_MODEL[provider],
      resolveModel: (id: string | undefined) => new ScriptedLlm(id ?? 'scripted', scriptedBrain(faults)),
    }));
}

// ── One provider ─────────────────────────────────────────────────────────────

/** What one turn left behind for the checks. */
interface TurnRun {
  record: TurnRecord;
  result?: SyndicateTurnResult;
  /** Function responses in the answering agent's events, by tool name. */
  responses: Array<{ name: string; response: unknown }>;
  /** Text deltas after the last reset. */
  deltas: number;
}

async function runProvider(target: Target, opts: ParityOptions): Promise<ProviderReport> {
  const config = loadSyndicate(FIXTURE, {
    agentsDir: FIXTURES_DIR,
    bindings: { orchestrator_model: target.model, subagent_model: target.model },
  });
  const sessionService = new InMemorySessionService();
  const sessionId = `parity-${target.provider}-${hex(4).toLowerCase()}`;
  const firstCode = `PARITY-${hex(3)}`;
  const recordCode = `PARITY-${hex(3)}`;
  const lookup = { value: `VALUE-${hex(4)}`, calls: 0, hits: 0 };
  lookups.set(sessionId, lookup);
  const started = Date.now();

  const turn = async (name: TurnName, message: string, streaming = false): Promise<TurnRun> => {
    const run: TurnRun = {
      record: { name, status: 'threw', durationMs: 0, llmCalls: 0, inputTokens: 0, outputTokens: 0, thinkingTokens: 0 },
      responses: [],
      deltas: 0,
    };
    const events: TurnEvents = {
      onEvent: (event) => {
        for (const part of (event as any).content?.parts ?? []) {
          const fr = part?.functionResponse;
          if (fr?.name) run.responses.push({ name: String(fr.name), response: fr.response });
        }
      },
      onTextDelta: () => {
        run.deltas += 1;
      },
      onTextReset: () => {
        run.deltas = 0;
      },
    };
    const t0 = Date.now();
    try {
      const r = await runSyndicateTurn({
        config,
        parts: [{ text: message }],
        appName: APP_NAME,
        userId: USER_ID,
        sessionId,
        sessionService,
        ...(target.resolveModel ? { compile: { resolveModel: target.resolveModel } } : {}),
        deadlineMs: opts.turnTimeoutMs ?? DEFAULT_TURN_TIMEOUT_MS,
        runtime: opts.runtime ?? 'adk',
        streaming,
        trace: { syndicateName: 'parity', attributes: { 'surface.name': target.transport === 'scripted' ? 'parity-scripted' : 'parity' } },
        events,
      });
      run.result = r;
      run.record = {
        name,
        status: r.status,
        durationMs: Date.now() - t0,
        llmCalls: r.usage.llmCalls,
        inputTokens: r.usage.inputTokens,
        outputTokens: r.usage.outputTokens,
        thinkingTokens: r.usage.thinkingTokens,
        ...(r.error ? { error: { code: r.error.code, message: scrub(r.error.message).slice(0, ERROR_MESSAGE_MAX) } } : {}),
      };
    } catch (err) {
      // runSyndicateTurn throws only for programming errors; the run goes on.
      const message = err instanceof Error ? err.message : String(err);
      run.record = { ...run.record, durationMs: Date.now() - t0, error: { code: 'THREW', message: scrub(message).slice(0, ERROR_MESSAGE_MAX) } };
    }
    return run;
  };

  try {
    const delegate = await turn('delegate', PROMPTS.delegate(firstCode));
    const tool = await turn('tool', PROMPTS.tool());
    const structured = await turn('structured', PROMPTS.structured(recordCode));
    const followup = await turn('followup', PROMPTS.followup(), true);
    const turns = [delegate, tool, structured, followup];

    const checks: CheckResult[] = [
      checkDelegation(delegate, firstCode),
      checkTool(tool, lookup),
      checkStructured(structured, config),
      checkStreaming(followup),
      checkSession(followup, firstCode),
      checkUsage(turns),
    ];
    return {
      provider: target.provider,
      label: PROVIDERS[target.provider].label,
      transport: target.transport,
      ...(target.gateway ? { gateway: target.gateway } : {}),
      models: { orchestrator: target.model, subagent: target.model },
      durationMs: Date.now() - started,
      turns: turns.map((t) => t.record),
      checks,
      pass: checks.every((c) => c.pass),
    };
  } finally {
    lookups.delete(sessionId);
  }
}

// ── Check predicates ─────────────────────────────────────────────────────────

const has = (haystack: string, needle: string) => haystack.toUpperCase().includes(needle.toUpperCase());

/** A tool response as text: ADK wraps a string result as { result }. */
function responseText(response: unknown): string {
  const r = response as { result?: unknown } | undefined;
  if (typeof r?.result === 'string') return r.result;
  return typeof response === 'string' ? response : JSON.stringify(response ?? '');
}

/** The turn did not complete: the reason every check on it fails. */
function incomplete(run: TurnRun): string | undefined {
  if (run.record.status === 'completed') return undefined;
  const code = run.record.error?.code;
  return `turn '${run.record.name}' ${run.record.status === 'threw' ? 'threw' : `ended ${run.record.status}`}${code ? ` [${code}]` : ''}`;
}

function result(id: CheckId, failure: string | undefined, passDetail: string): CheckResult {
  return failure ? { id, pass: false, detail: failure } : { id, pass: true, detail: passDetail };
}

function checkDelegation(run: TurnRun, code: string): CheckResult {
  const calls = (run.result?.answer?.toolCalls ?? []).filter((c) => c.name === 'Echo');
  const replies = run.responses.filter((r) => r.name === 'Echo').map((r) => responseText(r.response));
  const failure =
    incomplete(run) ??
    (calls.length === 0
      ? 'the orchestrator never called Echo'
      : !calls.some((c) => has(JSON.stringify(c.args ?? {}), code))
        ? 'Echo was called without the code word'
        : !replies.some((r) => has(r, code))
          ? "Echo's reply does not carry the code word"
          : undefined);
  return result('delegation', failure, 'Echo received the code word and returned it');
}

function checkTool(run: TurnRun, lookup: { value: string; calls: number; hits: number }): CheckResult {
  const failure =
    incomplete(run) ??
    (lookup.calls === 0
      ? 'parity_lookup never ran'
      : lookup.hits === 0
        ? 'parity_lookup ran, but never for the key "alpha"'
        : !has(run.result?.text ?? '', lookup.value)
          ? "the answer does not use parity_lookup's value"
          : undefined);
  return result('tool', failure, `parity_lookup ran ${lookup.calls}× and its value is in the answer`);
}

/** The Recorder's declared outputSchema, as a validator. */
function recorderSchema(config: SyndicateYamlConfig): z.ZodType {
  const declared = config.subagents.find((s) => s.name === 'Recorder')?.outputSchema;
  if (!declared) throw new Error(`${FIXTURE}: the Recorder declares no outputSchema`);
  return z.fromJSONSchema(toLowercaseJsonSchema(declared) as Parameters<typeof z.fromJSONSchema>[0]);
}

/** ADK hands a schema'd subagent's output over as an object; a string is parsed. */
function recordFrom(response: unknown): unknown {
  const r = response as Record<string, unknown> | undefined;
  const wrapped = r && typeof r === 'object' && Object.keys(r).length === 1 && typeof r.result === 'string' ? r.result : undefined;
  const raw = wrapped ?? (typeof response === 'string' ? response : undefined);
  if (raw === undefined) return response;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function checkStructured(run: TurnRun, config: SyndicateYamlConfig): CheckResult {
  const schema = recorderSchema(config);
  const records = run.responses.filter((r) => r.name === 'Recorder').map((r) => schema.safeParse(recordFrom(r.response)));
  const ok = records.find((p) => p.success);
  const firstIssue = records.find((p) => !p.success)?.error?.issues[0];
  const failure =
    incomplete(run) ??
    (records.length === 0
      ? 'the orchestrator never called Recorder'
      : !ok
        ? `Recorder's output does not match its schema${firstIssue ? ` (${firstIssue.path.join('.') || 'root'}: ${firstIssue.message})` : ''}`
        : undefined);
  return result('structured', failure, "Recorder's output parsed against its outputSchema");
}

function checkStreaming(run: TurnRun): CheckResult {
  const failure = incomplete(run) ?? (run.deltas === 0 ? 'the streamed turn yielded no text deltas' : undefined);
  return result('streaming', failure, `${run.deltas} text delta${run.deltas === 1 ? '' : 's'}`);
}

function checkSession(run: TurnRun, firstCode: string): CheckResult {
  const failure =
    incomplete(run) ??
    (!run.result?.resumedSession
      ? 'the turn did not resume the session'
      : !has(run.result.text, firstCode)
        ? "the reply does not name the first turn's code word"
        : undefined);
  return result('session', failure, "the last turn named the first turn's code word");
}

function checkUsage(runs: TurnRun[]): CheckResult {
  const completed = runs.filter((r) => r.record.status === 'completed').map((r) => r.record);
  const silent = completed.find((t) => t.llmCalls === 0 || t.inputTokens <= 0 || t.outputTokens <= 0);
  const failure =
    completed.length === 0
      ? 'no turn completed'
      : silent
        ? `turn '${silent.name}' recorded ${silent.llmCalls} calls, ${silent.inputTokens} input and ${silent.outputTokens} output tokens`
        : undefined;
  const sum = (k: 'inputTokens' | 'outputTokens' | 'llmCalls') => completed.reduce((n, t) => n + t[k], 0);
  return result('usage', failure, `${sum('inputTokens')} in / ${sum('outputTokens')} out over ${sum('llmCalls')} calls`);
}

// ── The scripted models (--scripted) ─────────────────────────────────────────

const textsOf = (content: any): string[] => (content?.parts ?? []).map((p: any) => p?.text).filter((t: unknown): t is string => typeof t === 'string');

/**
 * One deterministic stand-in for every agent of the fixture, playing the role
 * the request shows: the orchestrator is offered Echo as a tool, the Recorder
 * is asked for a response schema (ADK's request carries it as responseSchema;
 * the native runtime's, read back as an LlmRequest, as responseJsonSchema),
 * anything else is Echo. A fault breaks the
 * one behaviour its check measures, so that check — and only it — must fail.
 */
function scriptedBrain(faults: ReadonlySet<CheckId>): Script {
  return (req: LlmRequest) => {
    const tools = Object.keys((req as any).toolsDict ?? {});
    const out = tools.includes('Echo') ? scriptedLead(req, faults) : req.config?.responseSchema || req.config?.responseJsonSchema ? scriptedRecorder(req, faults) : scriptedEcho(req);
    return faults.has('usage') ? out : withUsage(out, req);
  };
}

function scriptedLead(req: LlmRequest, faults: ReadonlySet<CheckId>): LlmResponse | LlmResponse[] {
  const contents = req.contents ?? [];
  const last = contents[contents.length - 1];
  const fr = (last?.parts ?? []).find((p: any) => p?.functionResponse)?.functionResponse as { name?: string; response?: unknown } | undefined;
  if (fr) {
    const got = responseText(fr.response);
    if (fr.name === 'Echo') return text(`Echo replied: ${got}`);
    if (fr.name === 'parity_lookup') return text(faults.has('tool') ? 'The value is VALUE-UNKNOWN.' : `The value is ${got}.`);
    return text(`${fr.name} filed the record.`);
  }
  const ask = textsOf(last).join('\n');
  const code = ask.match(CODE_RE)?.[0] ?? '';
  if (/\bEcho\b/.test(ask)) return call('Echo', { request: faults.has('delegation') ? 'Repeat the code word.' : `Repeat the code word ${code}.` });
  if (/parity_lookup/.test(ask)) return call('parity_lookup', { key: 'alpha' });
  if (/\bRecorder\b/.test(ask)) return call('Recorder', { request: `City Lisbon, code word ${code}, count 3.` });
  // The follow-up: the code word of the first message, read from the history.
  const earlier = contents.slice(0, -1).filter((c) => c.role === 'user').flatMap(textsOf).join('\n').match(CODE_RE)?.[0];
  const reply = faults.has('session') || !earlier ? 'I do not know the code word.' : `The code word was ${earlier}.`;
  return faults.has('streaming') ? text(reply) : streamed(...reply.split(/(?<= )/));
}

function scriptedEcho(req: LlmRequest): LlmResponse {
  const ask = (req.contents ?? []).flatMap(textsOf).join('\n');
  return text(ask.match(CODE_RE)?.[0] ?? 'There is no code word in the request.');
}

function scriptedRecorder(req: LlmRequest, faults: ReadonlySet<CheckId>): LlmResponse {
  const code = (req.contents ?? []).flatMap(textsOf).join('\n').match(CODE_RE)?.[0] ?? '';
  return text(JSON.stringify({ city: 'Lisbon', code, count: faults.has('structured') ? 'three' : 3 }));
}

/** Scripted usage on the reply's final response, as a provider reports it. */
function withUsage(out: LlmResponse | LlmResponse[], req: LlmRequest): LlmResponse | LlmResponse[] {
  const list = Array.isArray(out) ? out : [out];
  const final = list[list.length - 1]!;
  const usage = { promptTokenCount: 1 + Math.ceil(JSON.stringify(req.contents ?? []).length / 4), candidatesTokenCount: 1 + Math.ceil(JSON.stringify(final.content ?? {}).length / 4) };
  list[list.length - 1] = { ...final, usageMetadata: usage } as LlmResponse;
  return Array.isArray(out) ? list : list[0]!;
}

// ── The run ──────────────────────────────────────────────────────────────────

export async function runParity(opts: ParityOptions = {}): Promise<ParityReport> {
  if (opts.faults?.length && !opts.scripted) throw new UsageError('--fault applies to --scripted runs only');
  registerLookup();
  const startedAt = new Date();
  const { targets, skipped } = opts.scripted ? { targets: scriptedTargets(opts), skipped: [] } : await liveTargets(opts);
  const providers: ProviderReport[] = [];
  for (const target of targets) {
    opts.log?.(`… ${target.provider} · ${target.model}${target.transport === 'gateway' ? ` (gateway:${target.gateway})` : ''}`);
    providers.push(await runProvider(target, opts));
  }
  const finishedAt = new Date();
  return {
    harness: 'parity',
    version: 1,
    mode: opts.scripted ? 'scripted' : 'live',
    runtime: { requested: opts.runtime ?? 'adk', ran: opts.runtime ?? 'adk' },
    ...(opts.faults?.length ? { faults: [...opts.faults] } : {}),
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationMs: finishedAt.getTime() - startedAt.getTime(),
    providers,
    skipped,
    pass: providers.length > 0 && providers.every((p) => p.pass),
  };
}

export function exitCodeFor(report: ParityReport): number {
  return report.pass ? 0 : 1;
}

/** MELCHIZEDEK_RUNTIME, validated: adk (the default) or native. */
export function requestedRuntime(env: NodeJS.ProcessEnv = process.env): Runtime {
  const raw = (env.MELCHIZEDEK_RUNTIME ?? '').trim().toLowerCase();
  if (!raw) return 'adk';
  if (raw === 'adk' || raw === 'native') return raw;
  throw new UsageError(`MELCHIZEDEK_RUNTIME must be adk or native (got '${raw.slice(0, 20)}')`);
}

// ── Rendering ────────────────────────────────────────────────────────────────

const seconds = (ms: number) => `${(ms / 1000).toFixed(1)}s`;

/** The provider-by-check table, then failures, skips and the verdict. */
export function renderReport(report: ParityReport, reportPath?: string): string {
  const lines: string[] = [];
  lines.push(`parity · ${report.mode} · runtime ${report.runtime.ran} · ${report.startedAt}`);
  if (report.faults?.length) lines.push(`faults injected: ${report.faults.join(', ')}`);
  lines.push('');

  const header = ['provider', 'model', ...CHECKS.map((c) => CHECK_LABELS[c]), 'time'];
  const rows = report.providers.map((p) => [
    p.provider,
    p.transport === 'gateway' ? `${p.models.orchestrator} (gateway:${p.gateway})` : p.models.orchestrator,
    ...CHECKS.map((id) => (p.checks.find((c) => c.id === id)?.pass ? '✓' : '✗')),
    seconds(p.durationMs),
  ]);
  if (rows.length) {
    const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i]!.length)));
    const line = (cells: string[]) => cells.map((c, i) => c.padEnd(widths[i]!)).join('  ').trimEnd();
    lines.push(line(header));
    for (const r of rows) lines.push(line(r));
  } else {
    lines.push('no provider ran');
  }

  const failures = report.providers.flatMap((p) => p.checks.filter((c) => !c.pass).map((c) => `  ✗ ${p.provider} · ${CHECK_LABELS[c.id]} — ${c.detail}`));
  if (failures.length) lines.push('', 'failures', ...failures);
  if (report.skipped.length) lines.push('', 'skipped', ...report.skipped.map((s) => `  ${s.provider} — ${s.reason}`));

  const total = report.providers.length * CHECKS.length;
  const failed = failures.length;
  lines.push('');
  if (reportPath) lines.push(`report  ${reportPath}`);
  lines.push(
    report.pass
      ? `PASS  ${total} checks on ${report.providers.length} provider${report.providers.length === 1 ? '' : 's'} in ${seconds(report.durationMs)}`
      : report.providers.length === 0
        ? 'FAIL  no provider ran'
        : `FAIL  ${failed} of ${total} checks failed`,
  );
  return lines.join('\n');
}

/** outputs/parity[-scripted]-<UTC date and time>.json */
export function writeReport(report: ParityReport, outDir: string): string {
  mkdirSync(outDir, { recursive: true });
  const stamp = report.startedAt.replace(/[:]/g, '').replace(/\.\d+Z$/, 'Z');
  const file = path.join(outDir, `parity-${report.mode === 'scripted' ? 'scripted-' : ''}${stamp}.json`);
  writeFileSync(file, `${JSON.stringify(report, null, 2)}\n`);
  return file;
}

// ── CLI ──────────────────────────────────────────────────────────────────────

const USAGE = `npm run parity -- [--providers <ids>] [--model <provider>=<id>]… [--timeout <seconds>] [--out <dir>] [--scripted [--fault <checks>]]

  checks:    ${CHECKS.join(', ')}
  providers: ${Object.keys(PROVIDERS).join(', ')}`;

interface CliArgs extends ParityOptions {
  outDir: string;
  help?: boolean;
}

function providerList(raw: string | undefined, flag: string): ProviderId[] {
  const ids = (raw ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  if (ids.length === 0) throw new UsageError(`${flag} needs a value`);
  for (const id of ids) if (!(id in PROVIDERS)) throw new UsageError(`${flag}: unknown provider '${id}'`);
  return ids as ProviderId[];
}

export function parseArgs(argv: string[]): CliArgs {
  const out: CliArgs = { outDir: path.join(process.cwd(), 'outputs') };
  const value = (i: number, flag: string) => {
    const v = argv[i + 1];
    if (v === undefined || v.startsWith('--')) throw new UsageError(`${flag} needs a value`);
    return v;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    switch (a) {
      case '--':
        break;
      case '--help':
      case '-h':
        out.help = true;
        break;
      case '--scripted':
        out.scripted = true;
        break;
      case '--fault': {
        const ids = value(i++, a).split(',').map((s) => s.trim()).filter(Boolean);
        for (const id of ids) if (!(CHECKS as readonly string[]).includes(id)) throw new UsageError(`--fault: unknown check '${id}' (use ${CHECKS.join(', ')})`);
        out.faults = [...(out.faults ?? []), ...(ids as CheckId[])];
        break;
      }
      case '--providers':
        out.providers = providerList(value(i++, a), a);
        break;
      case '--model': {
        const [provider, id] = value(i++, a).split('=', 2);
        if (!provider || !id || !(provider in PROVIDERS)) throw new UsageError('--model takes <provider>=<model id>');
        if (providerForModel(id) !== provider) throw new UsageError(`--model: '${id}' routes to ${providerForModel(id)}, not ${provider}`);
        out.models = { ...out.models, [provider]: id };
        break;
      }
      case '--timeout': {
        const s = Number(value(i++, a));
        if (!Number.isFinite(s) || s <= 0) throw new UsageError('--timeout takes a number of seconds');
        out.turnTimeoutMs = Math.round(s * 1000);
        break;
      }
      case '--out':
        out.outDir = path.resolve(value(i++, a));
        break;
      default:
        throw new UsageError(`unknown argument '${a}'`);
    }
  }
  if (out.faults?.length && !out.scripted) throw new UsageError('--fault applies to --scripted runs only');
  return out;
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  let args: CliArgs;
  let runtime: Runtime;
  try {
    args = parseArgs(argv);
    runtime = requestedRuntime();
  } catch (err) {
    if (!(err instanceof UsageError)) throw err;
    console.error(`${err.message}\n\n${USAGE}`);
    return 2;
  }
  if (args.help) {
    console.log(USAGE);
    return 0;
  }
  // A scripted run needs no key and reads none; a live run reads .env the
  // way every entrypoint does.
  if (!args.scripted) loadEnv(import.meta.url);
  // Console spans can carry a failed request's payload: never on this stdout.
  process.env.OTEL_CONSOLE_SPANS = 'false';
  setLogLevel('error');

  const report = await runParity({ ...args, runtime, log: (l) => console.log(l) });
  await flushTracing().catch(() => {}); // the ledger keeps the run's spend
  const file = writeReport(report, args.outDir);
  const rel = path.relative(process.cwd(), file);
  console.log(`\n${renderReport(report, rel && !rel.startsWith('..') ? rel : file)}`);
  return exitCodeFor(report);
}

function isMain(): boolean {
  if (!process.argv[1]) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
  } catch {
    return import.meta.url === `file://${process.argv[1]}`;
  }
}

if (isMain()) process.exitCode = await main();
