#!/usr/bin/env node
/**
 * scripts/gemini_engine_check.ts — the live run gate G3 asks for (ADR 0045,
 * ADR 0100): the engine's own GeminiAdapter (lib/models/geminiAdapter.ts)
 * against the real Gemini API on the native runtime, for what only a live
 * call can confirm.
 *
 * Four cases, each one syndicate with one Gemini orchestrator, run through
 * runSyndicateTurn on an in-process session:
 *
 *   grounding   web_search and url_context: an answer, with grounding
 *               metadata on a stored event
 *   code        code_execution: Gemini runs Python and answers with its result
 *   mixed       a function tool beside code_execution and web_search, with
 *               reasoning low: the server-side invocations come back beside
 *               the call, and the signed call and the carried parts are
 *               replayed on the next step
 *   session     two turns on one session, a tool call in each, reasoning
 *               low: the second turn's requests carry the first turn's history
 *               (earlier turns' signatures left out) and Gemini accepts them
 *
 * Each case runs on `native`, the only runtime (ADR 0107), with
 * GEMINI_ADAPTER=engine. `--runtimes` accepts `native` only.
 *
 * Only case names, runtimes, outcomes, counts and timings are printed — never
 * a key, a request body or the model's answer. An error message is printed
 * scrubbed of key-shaped strings and cut short.
 *
 * Usage:
 *   node --experimental-strip-types scripts/gemini_engine_check.ts
 *   node --experimental-strip-types scripts/gemini_engine_check.ts --model gemini-3.5-flash
 *   node --experimental-strip-types scripts/gemini_engine_check.ts --cases grounding,code
 *
 * Needs GOOGLE_GENAI_API_KEY (or GEMINI_API_KEY), or GEMINI_PLATFORM=vertex
 * with its project and location. Every case is a billed call.
 *
 * Exit: 0 every case passed · 1 a case failed · 2 a usage error or no Gemini route.
 */

import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import { z } from 'zod';

import type { SyndicateYamlConfig } from '../lib/loadSyndicate.ts';
import { loadEnv } from '../lib/loadEnv.ts';
import { providerForModel, providerStatuses } from '../lib/models/registry.ts';
import { patternRedactor } from '../lib/observability/redact.ts';
import { setLogLevel } from '../lib/runtime/logging.ts';
import { runSyndicateTurn } from '../lib/runtime/syndicateTurn.ts';
import type { SyndicateTurnResult, TurnEvents } from '../lib/runtime/syndicateTurn.ts';
import { RUNTIMES } from '../lib/runtime/runtimeFlag.ts';
import type { RuntimeName } from '../lib/runtime/runtimeFlag.ts';
import { InProcessSessionService } from '../lib/runtime/sessions.ts';
import { validateSyndicateConfig } from '../lib/syndicateSchema.ts';
import { registerTool } from '../lib/toolRegistry.ts';
import { defineTool } from '../lib/tools/toolContract.ts';

export const CASES = ['grounding', 'code', 'mixed', 'session'] as const;
export type CaseName = (typeof CASES)[number];
const DEFAULT_MODEL = 'gemini-3.8-flash';
const TURN_DEADLINE_MS = 180_000;
const ERROR_MAX = 240;

const TOOL = 'gemini_check_lookup';
const VALUES: Record<string, string> = { alpha: '14', beta: '28' };

const lookup = defineTool({
  name: TOOL,
  description: 'Returns the number stored under a key.',
  schema: z.object({ key: z.string().describe('The key, for example "alpha".') }),
  execute: async ({ key }) => VALUES[key.trim().toLowerCase()] ?? `No number is stored under "${key}".`,
});

const scrub = patternRedactor(['secret']);

interface CaseSpec {
  agent: Record<string, unknown>;
  turns: string[];
  /** Why the case failed, or undefined when it passed. */
  verdict: (runs: TurnRun[]) => string | undefined;
}

interface TurnRun {
  result?: SyndicateTurnResult;
  threw?: string;
  /** Function names the turn's events answered. */
  toolCalls: string[];
  grounded: boolean;
  codeParts: number;
}

const has = (text: string | undefined, needle: string) => (text ?? '').replace(/[,\s]/g, '').includes(needle);

function incomplete(runs: TurnRun[]): string | undefined {
  for (const [i, run] of runs.entries()) {
    if (run.threw) return `turn ${i + 1} threw: ${run.threw}`;
    if (run.result?.status !== 'completed') {
      const error = run.result?.error ? ` (${run.result.error.code}: ${scrub(run.result.error.message).slice(0, ERROR_MAX)})` : '';
      return `turn ${i + 1} ${run.result?.status ?? 'did not run'}${error}`;
    }
  }
  return undefined;
}

function specs(model: string): Record<CaseName, CaseSpec> {
  const base = { name: 'Checker', model, instruction: 'Answer briefly and plainly.' };
  return {
    grounding: {
      agent: { ...base, tools: ['web_search', 'url_context'] },
      turns: ['Read https://www.iana.org/help/example-domains and search the web: which organisation reserves example.com? One sentence.'],
      verdict: (runs) =>
        incomplete(runs) ?? (!runs[0].result?.text ? 'no answer' : !runs[0].grounded ? 'no grounding metadata on any stored event' : undefined),
    },
    code: {
      agent: { ...base, code_execution: 'gemini' },
      turns: ['Write and run Python to compute the sum of the first 50 prime numbers. Answer with the number only.'],
      verdict: (runs) => incomplete(runs) ?? (!has(runs[0].result?.text, '5117') ? 'the answer is not 5117' : undefined),
    },
    mixed: {
      agent: { ...base, tools: [TOOL, 'web_search'], code_execution: 'gemini', reasoning: 'low' },
      turns: [`Call ${TOOL} with the key "alpha", then run Python to multiply that number by 3. Answer with the product only.`],
      verdict: (runs) =>
        incomplete(runs) ?? (!runs[0].toolCalls.includes(TOOL) ? `${TOOL} was not called` : !has(runs[0].result?.text, '42') ? 'the answer is not 42' : undefined),
    },
    session: {
      agent: { ...base, tools: [TOOL], reasoning: 'low' },
      turns: [
        `Call ${TOOL} with the key "alpha" and tell me the number.`,
        `Now call ${TOOL} with the key "beta" and add it to the number from before. Answer with the sum only.`,
      ],
      verdict: (runs) => {
        const stopped = incomplete(runs);
        if (stopped) return stopped;
        if (!runs.every((r) => r.toolCalls.includes(TOOL))) return `${TOOL} was not called on every turn`;
        return has(runs[1].result?.text, '42') ? undefined : 'the second turn does not answer 42';
      },
    },
  };
}

function syndicate(name: CaseName, agent: Record<string, unknown>): SyndicateYamlConfig {
  return validateSyndicateConfig(
    { syndicate_name: `gemini-check-${name}`, memory_system: 'internal-only', orchestrator: agent, subagents: [] },
    'gemini_engine_check',
  ) as SyndicateYamlConfig;
}

/** One case on one runtime, with GEMINI_ADAPTER=engine for its duration. */
async function runCase(name: CaseName, spec: CaseSpec, runtime: RuntimeName): Promise<{ failure?: string; runs: TurnRun[]; ms: number }> {
  const config = syndicate(name, spec.agent);
  const sessionService = new InProcessSessionService();
  const sessionId = `gemini-check-${name}-${runtime}-${Date.now()}`;
  const saved = process.env.GEMINI_ADAPTER;
  process.env.GEMINI_ADAPTER = 'engine';
  const runs: TurnRun[] = [];
  const t0 = Date.now();
  try {
    for (const message of spec.turns) {
      const run: TurnRun = { toolCalls: [], grounded: false, codeParts: 0 };
      const events: TurnEvents = {
        onEvent: (event) => {
          const e = event as any;
          if (e.groundingMetadata) run.grounded = true;
          for (const part of e.content?.parts ?? []) {
            if (part?.functionResponse?.name) run.toolCalls.push(String(part.functionResponse.name));
            if (part?.executableCode || part?.codeExecutionResult) run.codeParts += 1;
          }
        },
      };
      try {
        run.result = await runSyndicateTurn({
          config,
          parts: [{ text: message }],
          appName: 'gemini-check',
          userId: 'gemini-check',
          sessionId,
          sessionService,
          deadlineMs: TURN_DEADLINE_MS,
          runtime,
          trace: false,
          events,
        });
      } catch (err) {
        run.threw = scrub(err instanceof Error ? err.message : String(err)).slice(0, ERROR_MAX);
      }
      runs.push(run);
      if (run.threw || run.result?.status !== 'completed') break;
    }
  } finally {
    if (saved === undefined) delete process.env.GEMINI_ADAPTER;
    else process.env.GEMINI_ADAPTER = saved;
  }
  return { failure: spec.verdict(runs), runs, ms: Date.now() - t0 };
}

function parseArgs(argv: string[]): { model: string; cases: CaseName[]; runtimes: RuntimeName[] } | string {
  let model = DEFAULT_MODEL;
  let cases: CaseName[] = [...CASES];
  let runtimes: RuntimeName[] = [...RUNTIMES];
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag === '--model' && value) model = value;
    else if (flag === '--cases' && value) cases = value.split(',').map((c) => c.trim()) as CaseName[];
    else if (flag === '--runtimes' && value) runtimes = value.split(',').map((r) => r.trim()) as RuntimeName[];
    else return `unknown or incomplete argument: ${flag}`;
    i++;
  }
  if (providerForModel(model) !== 'gemini') return `--model must be a Gemini id, not ${model}`;
  const badCase = cases.find((c) => !CASES.includes(c));
  if (badCase) return `unknown case: ${badCase} (one of ${CASES.join(', ')})`;
  const badRuntime = runtimes.find((r) => !RUNTIMES.includes(r));
  if (badRuntime) return `unknown runtime: ${badRuntime} (native is the only runtime)`;
  return { model, cases, runtimes };
}

/** `readEnvFile: false` leaves .env unread (the offline test sets its own fixture env). */
export async function main(argv = process.argv.slice(2), options: { readEnvFile?: boolean } = {}): Promise<number> {
  const args = parseArgs(argv);
  if (typeof args === 'string') {
    console.error(args);
    return 2;
  }
  if (options.readEnvFile !== false) loadEnv(import.meta.url);
  setLogLevel('error');
  const gemini = providerStatuses().find((p) => p.provider === 'gemini');
  if (!gemini || gemini.transport !== 'direct') {
    console.error('No direct Gemini route: set GOOGLE_GENAI_API_KEY (or GEMINI_API_KEY), or GEMINI_PLATFORM=vertex.');
    return 2;
  }
  registerTool(TOOL, lookup, { override: true });
  console.log(`Gemini ${args.model} · adapter GeminiAdapter (engine)`);
  const all = specs(args.model);
  let failed = 0;
  for (const name of args.cases) {
    for (const runtime of args.runtimes) {
      const { failure, runs, ms } = await runCase(name, all[name], runtime);
      if (failure) failed++;
      const calls = runs.reduce((n, r) => n + (r.result?.usage.llmCalls ?? 0), 0);
      const code = runs.reduce((n, r) => n + r.codeParts, 0);
      const grounded = runs.some((r) => r.grounded);
      const facts = `${calls} model calls, ${(ms / 1000).toFixed(1)}s${grounded ? ', grounded' : ''}${code ? `, ${code} code parts stored` : ''}`;
      console.log(`${failure ? 'FAIL' : 'pass'}  ${name.padEnd(10)} ${runtime.padEnd(7)} ${facts}${failure ? ` — ${failure}` : ''}`);
    }
  }
  return failed ? 1 : 0;
}

function isMain(): boolean {
  try {
    return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
  } catch {
    return false;
  }
}

if (isMain()) process.exitCode = await main();
