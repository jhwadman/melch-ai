/**
 * tests/helpers/childProcess.ts — a child Node process running one ES module
 * body, for the suites that load the package as a consumer would: from
 * source (`.ts`) or from a build (`.js`), with fetch stubbed so nothing
 * leaves the process.
 */

import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

import { ROOT } from './importGraph.ts';

export interface ChildResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

/** Runs `script` (an ES module body) in a child process, from the repository root. */
export function runChild(script: string, options: { env?: Record<string, string> } = {}): ChildResult {
  const result = spawnSync(
    process.execPath,
    ['--disable-warning=DEP0040', '--disable-warning=ExperimentalWarning', '--experimental-strip-types', '--input-type=module', '-e', script],
    {
      cwd: ROOT,
      encoding: 'utf8',
      env: { ...process.env, MODEL_GATEWAY: '', GEMINI_ADAPTER: '', MELCHIZEDEK_RUNTIME: '', ...options.env },
      timeout: 120_000,
    },
  );
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

/** The last line of a child's stdout, parsed as JSON. */
export function lastJson<T>(stdout: string): T {
  const line = stdout.trim().split('\n').at(-1) ?? '';
  return JSON.parse(line) as T;
}

/** A module path inside `base` as an import specifier: `<base>/<path><ext>`. */
export function moduleUrl(base: string, file: string, ext: '.ts' | '.js'): string {
  return pathToFileURL(`${base}/${file}${ext}`).href;
}

/**
 * The child script that serves one turn of every shipped syndicate, with
 * every model a scripted one that answers "ok", then asks for the removed
 * adk runtime. `base` is the repository (ext `.ts`) or a build's output
 * directory (ext `.js`); syndicates are read from the repository's
 * config/agents, which is what the package ships.
 *
 * It prints one JSON line: the default runtime, the scripted calls, each
 * syndicate's status, and the error the adk runtime raised.
 */
export function everyExampleTurnScript(base: string, ext: '.ts' | '.js', files: readonly string[]): string {
  const m = (file: string) => JSON.stringify(moduleUrl(base, file, ext));
  return `
    globalThis.fetch = async (url) => { throw new Error('no network in this test: ' + String(url)); };
    const { runSyndicateTurn, RuntimeRemovedError, DEFAULT_RUNTIME } = await import(${m('lib/runtime/syndicateTurn')});
    const { loadSyndicate } = await import(${m('lib/loadSyndicate')});
    const { InProcessSessionService } = await import(${m('lib/runtime/sessions')});
    await import(${m('lib/index')});
    await import(${m('lib/a2a/app')});
    const scripted = {
      provider: 'scripted',
      model: 'scripted',
      calls: 0,
      async *generate(request) {
        this.calls += 1;
        // An agent with an output schema (a dispatch classifier included) answers JSON.
        const json = request.outputSchema || request.responseSchema || request.config?.responseSchema;
        yield { partial: false, parts: [{ type: 'text', text: json ? '{}' : 'ok' }], finishReason: 'stop' };
      },
    };
    const turns = {};
    for (const file of ${JSON.stringify(files)}) {
      const config = loadSyndicate(file);
      try {
        const r = await runSyndicateTurn({
          config,
          parts: ['hello'],
          appName: 'shipped',
          userId: 'u',
          sessionId: 's-' + file,
          sessionService: new InProcessSessionService(),
          compile: { resolveModel: () => scripted },
          trace: false,
        });
        turns[file] = r.error ? r.status + ': ' + r.error.code + ' ' + r.error.message : r.status;
      } catch (err) {
        turns[file] = 'threw: ' + (err?.message ?? String(err)).split('\\n')[0];
      }
    }
    let adkError = '';
    const before = scripted.calls;
    try {
      await runSyndicateTurn({
        config: loadSyndicate(${JSON.stringify(files[0])}),
        parts: ['hello'],
        appName: 'shipped',
        userId: 'u',
        sessionId: 's-adk',
        sessionService: new InProcessSessionService(),
        compile: { resolveModel: () => scripted },
        trace: false,
        runtime: 'adk',
      });
    } catch (err) {
      adkError = (err instanceof RuntimeRemovedError ? 'RuntimeRemovedError: ' : 'other: ') + err.message;
    }
    console.log(JSON.stringify({ defaultRuntime: DEFAULT_RUNTIME, calls: before, adkCalls: scripted.calls - before, turns, adkError }));
  `;
}
