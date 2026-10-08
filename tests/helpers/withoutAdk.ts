/**
 * tests/helpers/withoutAdk.ts — a child Node process in which @google/adk
 * cannot be resolved, as in a fresh install that never added the optional
 * peer (ADR 0102).
 *
 * The resolve hook answers every specifier naming @google/adk with the error
 * Node itself throws for a package that is not installed
 * (ERR_MODULE_NOT_FOUND, "Cannot find package '@google/adk'"), so the
 * package's own loader (lib/adkPeer.ts) sees exactly what a consumer's
 * process would. `failWith` replaces that with another error, to show that
 * a broken install is never mistaken for an absent one.
 *
 * Nothing the child runs leaves the process: a turn script stubs fetch so
 * that any provider call fails the run.
 */

import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

import { ROOT } from './importGraph.ts';

export interface ChildResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

/** The resolve hook's source: @google/adk is not installed (or, with `failWith`, fails to load with that message). */
function hookSource(failWith?: string): string {
  const error = failWith
    ? `const e = new Error(${JSON.stringify(failWith)}); e.code = 'ERR_INVALID_PACKAGE_CONFIG'; throw e;`
    : `const e = new Error("Cannot find package '@google/adk' imported from " + c.parentURL); e.code = 'ERR_MODULE_NOT_FOUND'; throw e;`;
  return `export async function resolve(s, c, n) { if (s === '@google/adk' || s.startsWith('@google/adk/')) { ${error} } return n(s, c); }`;
}

/** Runs `script` (an ES module body) in a child process where @google/adk cannot be resolved. */
export function runWithoutAdk(script: string, options: { env?: Record<string, string>; failWith?: string } = {}): ChildResult {
  const register = `import { register } from 'node:module'; register(${JSON.stringify('data:text/javascript,' + encodeURIComponent(hookSource(options.failWith)))});`;
  const result = spawnSync(
    process.execPath,
    ['--disable-warning=DEP0040', '--disable-warning=ExperimentalWarning', '--experimental-strip-types', '--import', 'data:text/javascript,' + encodeURIComponent(register), '--input-type=module', '-e', script],
    { cwd: ROOT, encoding: 'utf8', env: { ...process.env, MODEL_GATEWAY: '', GEMINI_ADAPTER: '', MELCHIZEDEK_RUNTIME: '', ...options.env }, timeout: 120_000 },
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
 * The child script that serves one turn of every shipped syndicate on the
 * default runtime, with every model a scripted one that answers "ok", and
 * then asks for the adk runtime. `base` is the repository (ext `.ts`) or a
 * build's output directory (ext `.js`); syndicates are read from the
 * repository's config/agents, which is what the package ships.
 *
 * It prints one JSON line: whether @google/adk was unresolvable, whether the
 * package says it is installed, each syndicate's status, and the adk error.
 */
export function everyExampleTurnScript(base: string, ext: '.ts' | '.js', files: readonly string[]): string {
  const m = (file: string) => JSON.stringify(moduleUrl(base, file, ext));
  return `
    globalThis.fetch = async (url) => { throw new Error('no network in this test: ' + String(url)); };
    const { runSyndicateTurn, adkInstalled, AdkNotInstalledError, DEFAULT_RUNTIME } = await import(${m('lib/runtime/syndicateTurn')});
    const { loadSyndicate } = await import(${m('lib/loadSyndicate')});
    const { InProcessSessionService } = await import(${m('lib/runtime/sessions')});
    const { asAdkSessionService } = await import(${m('lib/runtime/adkSessionBridge')});
    await import(${m('lib/index')});
    await import(${m('lib/a2a/app')});
    let blocked = false;
    try { await import('@google/adk'); } catch { blocked = true; }
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
          appName: 'without-adk',
          userId: 'u',
          sessionId: 's-' + file,
          sessionService: asAdkSessionService(new InProcessSessionService()),
          compile: { resolveModel: () => scripted },
          trace: false,
        });
        turns[file] = r.error ? r.status + ': ' + r.error.code + ' ' + r.error.message : r.status;
      } catch (err) {
        turns[file] = 'threw: ' + (err?.message ?? String(err)).split('\\n')[0];
      }
    }
    let adkError = '';
    try {
      await runSyndicateTurn({
        config: loadSyndicate(${JSON.stringify(files[0])}),
        parts: ['hello'],
        appName: 'without-adk',
        userId: 'u',
        sessionId: 's-adk',
        sessionService: asAdkSessionService(new InProcessSessionService()),
        compile: { resolveModel: () => scripted },
        trace: false,
        runtime: 'adk',
      });
    } catch (err) {
      adkError = (err instanceof AdkNotInstalledError ? 'AdkNotInstalledError: ' : 'other: ') + err.message;
    }
    console.log(JSON.stringify({ blocked, installed: adkInstalled(), defaultRuntime: DEFAULT_RUNTIME, calls: scripted.calls, turns, adkError }));
  `;
}
