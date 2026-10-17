/**
 * lib/sandbox/worker.ts — one sandbox run, on its own worker thread
 * (ADR 0137 item 1). lib/sandbox/sandbox.ts starts it, one Worker per run,
 * and talks to it in messages; nothing else imports this file.
 *
 * WHAT RUNS HERE: QuickJS compiled to wasm (the release sync build), in a
 * fresh runtime with a memory limit, a stack limit and an interrupt
 * handler that stops the code after its CPU budget. The budget counts only
 * the time this thread spends inside the interpreter, so a run awaiting the
 * host (an agent, a tool) is not charged for the wait.
 *
 * WHAT THE CODE CAN REACH: the argument its default export is called with,
 * `console.log` (captured, bounded), and nothing else. There is no fetch,
 * no timer, no file system, no `process`, no environment; `Date.now`, the
 * current-time `Date` constructor and `Math.random` throw, naming the
 * function to use instead when the host passes one. The host functions the
 * caller names arrive as async functions on the argument; their arguments
 * and results cross as JSON, both ways.
 *
 * THE PROTOCOL (parent ↔ worker):
 *   run   → { type: 'run', source, mode, value, functions, limits }
 *   call  ← { type: 'call', id, name, args }     a host function was called
 *   reply → { type: 'reply', id, ok, value | error }
 *   done  ← { type: 'done', ok, result | error, logs, logsTruncated, cpuMs }
 * The parent terminates the worker after `done`, on the turn's signal, and
 * when it ran past its budget without answering, a harder stop than the
 * interrupt handler, which QuickJS consults only between bytecodes.
 */

import { parentPort } from 'node:worker_threads';

import { newQuickJSWASMModuleFromVariant } from 'quickjs-emscripten-core';
import type { QuickJSContext, QuickJSDeferredPromise, QuickJSHandle } from 'quickjs-emscripten-core';
import variant from '@jitl/quickjs-wasmfile-release-sync';

interface RunMessage {
  type: 'run';
  source: string;
  /** `input`: the export is called with `value`. `api`: with `value`'s keys plus the host functions and `parallel`. */
  mode: 'input' | 'api';
  /** JSON text. */
  value: string;
  functions: string[];
  limits: { memoryBytes: number; stackBytes: number; cpuMs: number; maxLogChars: number; maxParallel: number };
}

interface ReplyMessage {
  type: 'reply';
  id: number;
  ok: boolean;
  /** JSON text, or undefined for `undefined`. */
  value?: string;
  error?: { name: string; message: string };
}

const port = parentPort;
if (!port) throw new Error('lib/sandbox/worker.ts runs as a worker thread (lib/sandbox/sandbox.ts starts it)');

/**
 * Runs before the code: captures the host bridge and removes it from the
 * global object, masks the clock and randomness, and installs `console`.
 * It returns the function the host calls the default export through.
 */
const PRELUDE = String.raw`(() => {
  const host = globalThis.__host;
  const writeLog = globalThis.__log;
  const config = JSON.parse(globalThis.__config);
  delete globalThis.__host;
  delete globalThis.__log;
  delete globalThis.__config;
  const has = (name) => config.functions.includes(name);
  const blocked = (what, instead) => function () {
    throw new Error(what + ' is not available in the sandbox' + (instead && has(instead) ? '; use ' + instead + '()' : ''));
  };
  Math.random = blocked('Math.random', 'random');
  const RealDate = Date;
  class SandboxDate extends RealDate {
    constructor(...args) {
      if (args.length === 0) throw new Error('new Date() with no arguments reads the clock, which is not available in the sandbox' + (has('now') ? '; use now()' : ''));
      super(...args);
    }
  }
  SandboxDate.now = blocked('Date.now', 'now');
  globalThis.Date = SandboxDate;
  const show = (v) => {
    if (typeof v === 'string') return v;
    try { const s = JSON.stringify(v); return s === undefined ? String(v) : s; } catch { return String(v); }
  };
  const print = (...args) => writeLog(args.map(show).join(' '));
  globalThis.console = Object.freeze({ log: print, info: print, warn: print, error: print, debug: print });
  const call = (name) => (...args) => host(name, JSON.stringify(args)).then((r) => (r === undefined ? undefined : JSON.parse(r)));
  const parallel = async (thunks, opts) => {
    if (!Array.isArray(thunks)) throw new TypeError('parallel takes an array of functions');
    const asked = opts && typeof opts.max === 'number' ? Math.floor(opts.max) : 4;
    const max = Math.max(1, Math.min(asked, config.maxParallel));
    const results = new Array(thunks.length);
    let next = 0;
    const lane = async () => {
      while (next < thunks.length) {
        const i = next++;
        if (typeof thunks[i] !== 'function') throw new TypeError('parallel: item ' + i + ' is not a function');
        results[i] = await thunks[i]();
      }
    };
    await Promise.all(Array.from({ length: Math.min(max, thunks.length) }, lane));
    return results;
  };
  return (fn, valueJson) => {
    const value = JSON.parse(valueJson);
    let arg = value;
    if (config.mode === 'api') {
      arg = { ...(value && typeof value === 'object' ? value : {}) };
      for (const name of config.functions) arg[name] = call(name);
      arg.parallel = parallel;
      Object.freeze(arg);
    }
    return Promise.resolve()
      .then(() => fn(arg))
      .then((r) => {
        const json = JSON.stringify(r);
        return json === undefined ? 'null' : json;
      });
  };
})()`;

function post(message: Record<string, unknown>): void {
  port!.postMessage(message);
}

port.once('message', (message: RunMessage) => {
  run(message).catch((err: unknown) => {
    post({ type: 'done', ok: false, error: { code: 'SANDBOX_CRASHED', message: err instanceof Error ? err.message : String(err) }, logs: '', logsTruncated: false, cpuMs: 0 });
  });
});

async function run(message: RunMessage): Promise<void> {
  const { limits } = message;
  // The package's typings describe its CommonJS shape; under ESM the default import is the variant itself.
  const mod = await newQuickJSWASMModuleFromVariant(variant as unknown as Parameters<typeof newQuickJSWASMModuleFromVariant>[0]);
  const runtime = mod.newRuntime();
  runtime.setMemoryLimit(limits.memoryBytes);
  runtime.setMaxStackSize(limits.stackBytes);

  // CPU: time inside the interpreter only.
  let used = 0;
  let segmentStart = 0;
  let cpuExceeded = false;
  runtime.setInterruptHandler(() => {
    if (segmentStart && used + (performance.now() - segmentStart) > limits.cpuMs) {
      cpuExceeded = true;
      return true;
    }
    return false;
  });
  const compute = <T>(fn: () => T): T => {
    segmentStart = performance.now();
    try {
      return fn();
    } finally {
      used += performance.now() - segmentStart;
      segmentStart = 0;
    }
  };

  let logs = '';
  let logsTruncated = false;
  let finished = false;
  const finish = (outcome: { ok: true; result: string } | { ok: false; error: { code: string; message: string } }) => {
    if (finished) return;
    finished = true;
    post({ type: 'done', ...outcome, logs, logsTruncated, cpuMs: Math.round(used) });
  };

  const vm: QuickJSContext = runtime.newContext();
  const pending = new Map<number, QuickJSDeferredPromise>();
  let nextId = 1;

  const hostFn = vm.newFunction('__host', (nameHandle: QuickJSHandle, argsHandle: QuickJSHandle) => {
    const name = vm.getString(nameHandle);
    const args = vm.getString(argsHandle);
    const deferred = vm.newPromise();
    const id = nextId++;
    pending.set(id, deferred);
    post({ type: 'call', id, name, args });
    return deferred.handle;
  });
  vm.setProp(vm.global, '__host', hostFn);
  hostFn.dispose();
  const logFn = vm.newFunction('__log', (lineHandle: QuickJSHandle) => {
    if (logsTruncated) return;
    const line = vm.getString(lineHandle);
    const room = limits.maxLogChars - logs.length;
    if (line.length + 1 > room) {
      logs += line.slice(0, Math.max(0, room));
      logsTruncated = true;
    } else {
      logs += (logs ? '\n' : '') + line;
    }
  });
  vm.setProp(vm.global, '__log', logFn);
  logFn.dispose();
  const configHandle = vm.newString(JSON.stringify({ functions: message.functions, mode: message.mode, maxParallel: limits.maxParallel }));
  vm.setProp(vm.global, '__config', configHandle);
  configHandle.dispose();

  /** An error the VM threw or rejected with, as the parent reports it. */
  const describe = (handle: QuickJSHandle): { code: string; message: string } => {
    const dumped = vm.dump(handle) as { name?: unknown; message?: unknown } | unknown;
    if (cpuExceeded) return { code: 'CPU_LIMIT', message: `The code ran past its ${limits.cpuMs} ms CPU budget.` };
    // Out of memory, QuickJS can have no room left for an error object and throws null instead.
    if (dumped === null || dumped === undefined) {
      return { code: 'CODE_ERROR', message: `The code threw ${String(dumped)}; code that builds large values throws null when it reaches the ${Math.round(limits.memoryBytes / 1048576)} MB memory limit.` };
    }
    const err = dumped && typeof dumped === 'object' ? (dumped as { name?: unknown; message?: unknown }) : { message: String(dumped) };
    const name = typeof err.name === 'string' ? err.name : 'Error';
    const text = typeof err.message === 'string' ? err.message : String(dumped);
    if (/out of memory/i.test(text)) return { code: 'MEMORY_LIMIT', message: `The code ran past its ${Math.round(limits.memoryBytes / 1048576)} MB memory limit.` };
    if (/stack overflow/i.test(text)) return { code: 'STACK_LIMIT', message: 'The code overflowed its stack.' };
    return { code: 'CODE_ERROR', message: `${name}: ${text}` };
  };
  const pump = (): boolean => {
    const jobs = compute(() => runtime.executePendingJobs());
    if (jobs.error) {
      const error = describe(jobs.error);
      jobs.error.dispose();
      finish({ ok: false, error });
      return false;
    }
    if (cpuExceeded) {
      finish({ ok: false, error: { code: 'CPU_LIMIT', message: `The code ran past its ${limits.cpuMs} ms CPU budget.` } });
      return false;
    }
    return true;
  };

  port!.on('message', (reply: ReplyMessage) => {
    if (finished || reply.type !== 'reply') return;
    const deferred = pending.get(reply.id);
    if (!deferred) return;
    pending.delete(reply.id);
    if (reply.ok) {
      if (reply.value === undefined) deferred.resolve();
      else {
        const value = vm.newString(reply.value);
        deferred.resolve(value);
        value.dispose();
      }
    } else {
      const error = vm.newError({ name: reply.error?.name ?? 'Error', message: reply.error?.message ?? 'the host call failed' });
      deferred.reject(error);
      error.dispose();
    }
    deferred.dispose();
    pump();
  });

  const prelude = compute(() => vm.evalCode(PRELUDE, 'prelude.js'));
  if (prelude.error) {
    finish({ ok: false, error: { code: 'SANDBOX_CRASHED', message: `prelude: ${JSON.stringify(vm.dump(prelude.error))}` } });
    return;
  }
  const invoke = prelude.value;

  const evaluated = compute(() => vm.evalCode(message.source, 'code.js', { type: 'module' }));
  if (evaluated.error) {
    finish({ ok: false, error: describe(evaluated.error) });
    return;
  }
  // A module evaluates to a promise of its namespace (top-level await may hold it open);
  // resolvePromise attaches its handlers in the VM, which run as pending jobs.
  const loading = vm.resolvePromise(evaluated.value);
  if (!pump()) return;
  const loaded = await loading;
  if (finished) return;
  if (loaded.error) {
    finish({ ok: false, error: describe(loaded.error) });
    return;
  }
  const exported = vm.getProp(loaded.value, 'default');
  if (vm.typeof(exported) !== 'function') {
    finish({ ok: false, error: { code: 'CODE_ERROR', message: 'The code must `export default` a function; it is called with the input.' } });
    return;
  }
  const valueHandle = vm.newString(message.value);
  const called = compute(() => vm.callFunction(invoke, vm.undefined, exported, valueHandle));
  valueHandle.dispose();
  if (called.error) {
    finish({ ok: false, error: describe(called.error) });
    return;
  }
  const settling = vm.resolvePromise(called.value);
  if (!pump()) return;
  const settled = await settling;
  if (finished) return;
  if (settled.error) {
    finish({ ok: false, error: describe(settled.error) });
    return;
  }
  finish({ ok: true, result: vm.getString(settled.value) });
}
