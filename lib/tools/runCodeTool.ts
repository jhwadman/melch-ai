/**
 * lib/tools/runCodeTool.ts — `run_code`: an agent runs JavaScript in the
 * engine's sandbox and rests its answer on what the code returned
 * (ADR 0137 items 2 to 4).
 *
 * WHY a registry tool: any agent on any provider can list it
 * (`tools: [run_code]`), since the model only writes text, and it gets what
 * every registry tool gets: `require_approval`, MCP exposure (ADR 0125), the
 * result bound and `retries.tool_errors`. `code_execution: gemini` stays,
 * for Python in Gemini's own sandbox on Gemini models (ADR 0033).
 *
 * THE CONTRACT: `{ code, input? }`. The code is a JavaScript module whose
 * default export is called with `input`; the tool returns
 * `{ result, logs, error }`: the export's JSON-serializable return, the
 * `console.log` output, and what stopped it, if anything. Each is bounded at
 * MAX_RESULT_CHARS. The code reaches nothing but `input` and `console`: no
 * network, no host, no keys, no clock, no randomness (lib/sandbox/).
 *
 * THE SWITCH: nothing runs unless the operator set MELCHIZEDEK_CODE_SANDBOX=on;
 * a syndicate listing run_code without it is refused at load (refuseOnNative),
 * and a call that reaches here anyway answers with the reason.
 *
 * ATTACH: an agent's `run_code: { attach: true }` puts each run's code and
 * result on the reply as a `code_run` data part (lib/runtime/syndicateTurn.ts
 * collects them, the A2A executor publishes them). Off by default.
 */

import { z } from 'zod';

import { codeSandboxEnabled, codeSandboxOffMessage, runInSandbox } from '../sandbox/sandbox.ts';
import { MAX_RESULT_CHARS } from './tool.ts';
import { defineTool } from './toolContract.ts';

/** The registry name. */
export const RUN_CODE = 'run_code';

/** The largest program a call may send. */
export const MAX_CODE_CHARS = 64_000;

/** What a call returns. */
export interface RunCodeOutput {
  result: unknown;
  logs: string;
  error: string | null;
}

export const runCodeTool = defineTool({
  name: RUN_CODE,
  description:
    'Run JavaScript and get back what it returns, so an answer can rest on a computation instead of mental arithmetic: totals, conversions, statistics, dates from given timestamps, parsing, sorting, checking a formula. '
    + '`code` is an ES module whose default export is called with `input` and returns a JSON-serializable value, e.g. `export default ({ xs }) => xs.reduce((a, b) => a + b, 0)`. '
    + 'console.log output comes back in `logs`. The code has no network, no files, no clock and no randomness (Date.now, new Date() and Math.random throw); pass any data it needs in `input`. '
    + 'It returns { result, logs, error }; when error is set, fix the code and run it again.',
  schema: z.object({
    code: z.string().min(1).max(MAX_CODE_CHARS).describe('An ES module: `export default (input) => value`. May be async.'),
    input: z.unknown().optional().describe('JSON the default export is called with.'),
  }),
  async execute({ code, input }, ctx): Promise<RunCodeOutput> {
    if (!codeSandboxEnabled()) return { result: null, logs: '', error: codeSandboxOffMessage(RUN_CODE) };
    const run = await runInSandbox({
      source: code,
      value: input ?? null,
      ...(ctx.signal ? { signal: ctx.signal } : {}),
      limits: { maxLogChars: MAX_RESULT_CHARS, maxResultChars: MAX_RESULT_CHARS },
    });
    const logs = run.logsTruncated ? `${run.logs}\n[logs truncated at ${MAX_RESULT_CHARS.toLocaleString('en-US')} characters]` : run.logs;
    if (!run.ok) return { result: null, logs, error: `${run.error?.code ?? 'CODE_ERROR'}: ${run.error?.message ?? 'the code did not finish'}` };
    return { result: run.result ?? null, logs, error: null };
  },
});

/** One run an agent made, as a `code_run` data part carries it. */
export interface CodeRun {
  type: 'code_run';
  /** The agent that ran it. */
  agent: string;
  code: string;
  result: unknown;
  error?: string;
}
