#!/usr/bin/env node
/**
 * examples/capstone/eval/run.ts — runs the evaluation pack (cases.json)
 * against the starter's backend, started in this process.
 *
 *   npm run capstone:eval                    # mock mode: the plumbing checks only
 *   CAPSTONE_MODE=a2a npm run capstone:eval  # every check, against the agent service
 *   npm run capstone:eval -- --case tool-failure
 *
 * Each case signs in as its test user in a fresh session (so a fresh
 * conversation), sends its question over HTTP like the page does, and
 * applies its checks. Code checks print PASS / FAIL / SKIP; judged checks
 * print JUDGE for a person to decide. The results are written as JSON to
 * eval/results/ (git-ignored): keep them for the portfolio.
 *
 * The backend listens on CAPSTONE_PORT (4100): the Event Assistant's
 * updates tool is configured at that address, so stop `npm run capstone`
 * first. Exit code 1 when any 'block' check fails.
 */
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { TEST_USERS, createStarter, loadDotEnv, optionsFromEnv } from '../server.ts';
import type { StarterOptions, Trace } from '../server.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));

export interface Check {
  kind: 'status' | 'answer_matches' | 'answer_not_matches' | 'tool_called' | 'no_false_outage_claim' | 'notice_present' | 'response_excludes_secrets' | 'forwarded_user_is_session_user' | 'judged';
  equals?: number;
  pattern?: string;
  status?: number;
  criterion?: string;
  judge?: string;
  model?: boolean;
  failure_outcome: 'block' | 'route to a person';
}

export interface Case {
  id: string;
  type: string;
  user: string;
  question: string;
  expected: string;
  tool_down?: boolean;
  spoof?: { header?: Record<string, string>; body?: Record<string, unknown> };
  checks: Check[];
}

export type Verdict = 'PASS' | 'FAIL' | 'SKIP' | 'JUDGE';

export interface CaseResult {
  id: string;
  type: string;
  question: string;
  expected: string;
  httpStatus: number;
  answer: string | null;
  error: { kind: string; message: string } | null;
  notice: string | null;
  trace: Trace | null;
  checks: Array<{ kind: string; detail: string; verdict: Verdict; failure_outcome: string }>;
}

export function loadCases(): Case[] {
  return (JSON.parse(readFileSync(path.join(HERE, 'cases.json'), 'utf8')) as { cases: Case[] }).cases;
}

function describe(check: Check): string {
  switch (check.kind) {
    case 'status': return `HTTP status is ${check.equals}`;
    case 'answer_matches': return `answer matches /${check.pattern}/i`;
    case 'answer_not_matches': return `answer does not match /${check.pattern}/i`;
    case 'tool_called': return `get_event_updates was called and answered ${check.status}`;
    case 'no_false_outage_claim': return 'claims the updates could not be checked only when a tool call failed';
    case 'notice_present': return 'the page shows the "updates could not be checked" notice';
    case 'response_excludes_secrets': return 'the response carries neither the bearer secret nor the model key';
    case 'forwarded_user_is_session_user': return 'X-User-Id forwarded is the session user\'s account id';
    case 'judged': return `${check.criterion} (judge: ${check.judge})`;
  }
}

/** The assistant saying it could not check the updates. */
const OUTAGE_CLAIM = /(could not|couldn't|cannot|can't|unable to|not able to) (check|reach|retrieve|get|access) (the )?(latest )?updates/i;

function judge(check: Check, mode: StarterOptions['mode'], r: Omit<CaseResult, 'checks'>, raw: string, sessionAccount: string, secrets: string[]): Verdict {
  if (check.kind === 'judged') return 'JUDGE';
  if (check.model && mode === 'mock') return 'SKIP';
  const answer = r.answer ?? '';
  const ok = (() => {
    switch (check.kind) {
      case 'status': return r.httpStatus === check.equals;
      case 'answer_matches': return new RegExp(check.pattern ?? '', 'i').test(answer);
      case 'answer_not_matches': return r.answer !== null && !new RegExp(check.pattern ?? '', 'i').test(answer);
      case 'tool_called': return (r.trace?.toolCalls ?? []).some((c) => c.status === check.status);
      case 'no_false_outage_claim': return (r.trace?.toolCalls ?? []).some((c) => c.status >= 400) || !OUTAGE_CLAIM.test(answer);
      case 'notice_present': return !!r.notice;
      case 'response_excludes_secrets': return secrets.filter(Boolean).every((s) => !raw.includes(s));
      case 'forwarded_user_is_session_user': return r.trace?.forwardedUserId === sessionAccount && r.trace?.identitySource === 'session';
    }
  })();
  return ok ? 'PASS' : 'FAIL';
}

/** Runs the cases against a starter at `base`. `setToolDown` toggles its updates tool. */
export async function runCases(
  base: string,
  cases: Case[],
  mode: StarterOptions['mode'],
  setToolDown: (down: boolean) => void,
  secrets: string[],
  print: (line: string) => void = () => {},
): Promise<CaseResult[]> {
  const results: CaseResult[] = [];
  for (const c of cases) {
    const user = TEST_USERS.find((u) => u.username === c.user);
    if (!user) throw new Error(`case ${c.id}: no test user '${c.user}'`);
    setToolDown(!!c.tool_down);
    const login = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: c.user }) });
    const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0];
    print(`\n▶ ${c.id} (${c.type})${c.tool_down ? ' [updates tool down]' : ''}\n  Q: ${c.question}`);
    const res = await fetch(`${base}/api/ask`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie, ...(c.spoof?.header ?? {}) },
      body: JSON.stringify({ question: c.question, ...(c.spoof?.body ?? {}) }),
    });
    const raw = await res.text();
    let data: { answer?: string; error?: { kind: string; message: string }; notice?: string; trace?: Trace } = {};
    try { data = JSON.parse(raw); } catch { /* reported by the status check */ }
    const partial = {
      id: c.id, type: c.type, question: c.question, expected: c.expected,
      httpStatus: res.status, answer: data.answer ?? null, error: data.error ?? null, notice: data.notice ?? null, trace: data.trace ?? null,
    };
    const checks = c.checks.map((check) => ({
      kind: check.kind,
      detail: describe(check),
      verdict: judge(check, mode, partial, raw, user.accountId, secrets),
      failure_outcome: check.failure_outcome,
    }));
    results.push({ ...partial, checks });
    print(partial.answer !== null ? `  A: ${partial.answer.replace(/\n+/g, ' ')}` : `  ERROR (${partial.error?.kind}): ${partial.error?.message}`);
    if (partial.notice) print(`  NOTICE: ${partial.notice}`);
    if (partial.trace) print(`  trace: X-User-Id=${partial.trace.forwardedUserId} (from ${partial.trace.identitySource}), tool calls=${JSON.stringify(partial.trace.toolCalls.map((t) => t.status))}, ${partial.trace.durationMs} ms`);
    for (const ch of checks) print(`  ${ch.verdict.padEnd(5)} ${ch.detail}`);
  }
  setToolDown(false);
  return results;
}

export function summarize(results: CaseResult[]): { pass: number; fail: number; skip: number; judge: number; blocked: boolean } {
  const all = results.flatMap((r) => r.checks);
  const count = (v: Verdict) => all.filter((c) => c.verdict === v).length;
  return {
    pass: count('PASS'), fail: count('FAIL'), skip: count('SKIP'), judge: count('JUDGE'),
    blocked: all.some((c) => c.verdict === 'FAIL' && c.failure_outcome === 'block'),
  };
}

const invokedAsMain = (() => {
  try {
    return !!process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
  } catch {
    return false;
  }
})();

if (invokedAsMain) {
  loadDotEnv(path.join(process.cwd(), '.env'));
  const opts = optionsFromEnv();
  const only = process.argv.includes('--case') ? process.argv[process.argv.indexOf('--case') + 1] : undefined;
  const cases = loadCases().filter((c) => !only || c.id === only);
  if (cases.length === 0) {
    console.error(`No case '${only}'.`);
    process.exit(1);
  }
  const starter = createStarter({ ...opts, log: () => {} });
  let port: number;
  try {
    port = await starter.listen(opts.port, opts.host);
  } catch (err: unknown) {
    console.error((err as NodeJS.ErrnoException).code === 'EADDRINUSE'
      ? `Port ${opts.port} is in use. Stop \`npm run capstone\` first: the evaluation starts its own backend there, where the updates tool is configured.`
      : String(err));
    process.exit(1);
  }
  const started = new Date();
  console.log(`Evaluation pack: ${cases.length} case(s), mode ${opts.mode}${opts.mode === 'a2a' ? `, agent service ${opts.agent.url}` : ' (model checks skipped)'}`);
  const results = await runCases(`http://${opts.host}:${port}`, cases, opts.mode, (d) => starter.setToolDown(d), [opts.agent.secret, opts.agent.apiKey], (l) => console.log(l));
  await starter.close();
  const s = summarize(results);
  console.log(`\n${s.pass} pass · ${s.fail} fail · ${s.skip} skipped (mock) · ${s.judge} for a person to judge`);
  const dir = path.join(HERE, 'results');
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${started.toISOString().replace(/[:.]/g, '-')}-${opts.mode}.json`);
  writeFileSync(file, `${JSON.stringify({ ranAt: started.toISOString(), mode: opts.mode, agentUrl: opts.mode === 'a2a' ? opts.agent.url : null, summary: s, results }, null, 2)}\n`);
  console.log(`Results: ${path.relative(process.cwd(), file)}`);
  process.exit(s.blocked ? 1 : 0);
}
