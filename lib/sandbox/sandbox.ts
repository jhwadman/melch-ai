/**
 * lib/sandbox/sandbox.ts — run JavaScript the engine did not write, where
 * it can reach nothing but what it is handed (ADR 0137 Part A).
 *
 * WHY this exists:
 *   Two features need code to run on this host: the `run_code` tool, whose
 *   code a model writes (lib/tools/runCodeTool.ts), and a syndicate's
 *   `script:`, whose code an operator deploys (lib/script/). ADR 0033 refused
 *   local execution because ADK's executors ran code on the host or needed a
 *   Docker daemon. This is neither: QuickJS compiled to wasm, with no host
 *   reach of any kind, on a worker thread (lib/sandbox/worker.ts) so a run's
 *   compute never stalls the turns, streams and MCP calls of the process.
 *
 * WHAT A RUN GETS: a fresh runtime in a fresh Worker, a memory limit
 * (default 64 MB), a stack limit, and a CPU budget (default 5 s) measured
 * only while the code computes. Values cross as JSON both ways. The code is
 * a module whose default export is called with the input (`mode: 'input'`)
 * or with an API object (`mode: 'api'`): the caller's values, its host
 * functions as async functions, and `parallel`.
 *
 * THE STOPS: the interrupt handler inside the worker stops the code at its
 * CPU budget; a watchdog here terminates the worker when it computed past
 * the budget without answering; the caller's signal terminates it; and a
 * host function may throw SandboxHalt to end the run on purpose (a script
 * pausing for a person). Runs are capped by a small pool, so the memory
 * they hold is bounded: MELCHIZEDEK_CODE_SANDBOX_WORKERS, default 16.
 *
 * THE POSTURE: nothing runs unless the operator set
 * MELCHIZEDEK_CODE_SANDBOX=on (codeSandboxEnabled). The sandbox grants no
 * power the code's caller lacks, so the switch is a posture, not a
 * boundary: a deployment that never meant to run code does not start
 * because a YAML changed (ADR 0137 item 4, as ADR 0132 gates stdio MCP).
 */

import { Worker } from 'node:worker_threads';

/** The operator's switch for running code (ADR 0137 item 4). */
export const CODE_SANDBOX_ENV = 'MELCHIZEDEK_CODE_SANDBOX';

/** True when the operator turned the sandbox on: MELCHIZEDEK_CODE_SANDBOX=on (or true, 1). */
export function codeSandboxEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return /^(on|true|1)$/i.test((env[CODE_SANDBOX_ENV] ?? '').trim());
}

/** The message a refusal carries when the switch is off. */
export function codeSandboxOffMessage(what: string): string {
  return `${what} runs code in the engine's sandbox, which is off; the operator turns it on with ${CODE_SANDBOX_ENV}=on (ADR 0137)`;
}

/** A syndicate that needs the sandbox, refused while it is off: it names the variable that turns it on. */
export class CodeSandboxOffError extends Error {
  readonly code = 'CODE_SANDBOX_OFF';
  constructor(what: string) {
    super(codeSandboxOffMessage(what));
    this.name = 'CodeSandboxOffError';
  }
}

/** What in a syndicate runs code: its `script:`, and each agent that lists `run_code`. */
export function codeUsersOf(config: { syndicate_name?: string; script?: unknown; orchestrator?: { name?: string; tools?: string[] }; subagents?: Array<{ name?: string; tools?: string[] }> }): string[] {
  const out: string[] = [];
  if (config.script) out.push(`${config.syndicate_name || 'the syndicate'}'s script`);
  for (const agent of [config.orchestrator, ...(config.subagents ?? [])]) {
    if (agent?.tools?.includes('run_code')) out.push(`${agent.name ?? 'an agent'}'s run_code tool`);
  }
  return out;
}

/** Throws CodeSandboxOffError when `config` runs code and the operator has not turned the sandbox on. */
export function refuseWithoutSandbox(config: Parameters<typeof codeUsersOf>[0], env: NodeJS.ProcessEnv = process.env): void {
  if (codeSandboxEnabled(env)) return;
  const users = codeUsersOf(config);
  if (users.length) throw new CodeSandboxOffError(users.join(' and '));
}

export interface SandboxLimits {
  /** Heap the runtime may allocate. Default 64 MB. */
  memoryBytes: number;
  /** Stack the runtime may use. Default 1 MB. */
  stackBytes: number;
  /** Compute the code may spend, waits on the host not counted. Default 5,000 ms. */
  cpuMs: number;
  /** console output kept. Default 20,000 characters. */
  maxLogChars: number;
  /** The result's JSON text a run may return. Default 1,000,000 characters. */
  maxResultChars: number;
  /** The most calls `parallel` runs at once. Default 4 (32 at most). */
  maxParallel: number;
}

export const DEFAULT_SANDBOX_LIMITS: Readonly<SandboxLimits> = Object.freeze({
  memoryBytes: 64 * 1024 * 1024,
  stackBytes: 1024 * 1024,
  cpuMs: 5_000,
  maxLogChars: 20_000,
  maxResultChars: 1_000_000,
  maxParallel: 32,
});

/** What can end a run other than its own return. */
export type SandboxErrorCode =
  | 'CODE_ERROR'
  | 'CPU_LIMIT'
  | 'MEMORY_LIMIT'
  | 'STACK_LIMIT'
  | 'RESULT_TOO_LARGE'
  | 'CANCELED'
  | 'HALTED'
  | 'SANDBOX_CRASHED';

/** A host function in `mode: 'api'`: its arguments as the code passed them, already parsed from JSON. */
export type HostFunction = (args: unknown[]) => Promise<unknown> | unknown;

export interface SandboxRunOptions {
  /** A JavaScript module whose default export the run calls. */
  source: string;
  /** `input`: the export gets `value`. `api`: an object of `value`'s keys, the host functions and `parallel`. Default `input`. */
  mode?: 'input' | 'api';
  /** JSON-serializable. */
  value?: unknown;
  /** The host functions the code may call (`mode: 'api'`). */
  functions?: Record<string, HostFunction>;
  limits?: Partial<SandboxLimits>;
  /** Terminates the run when aborted. */
  signal?: AbortSignal;
}

export interface SandboxResult {
  ok: boolean;
  /** The export's return value, parsed from JSON (`undefined` came back as null). */
  result?: unknown;
  error?: { code: SandboxErrorCode; message: string };
  /** What a host function threw as SandboxHalt, when the run was halted. */
  halt?: SandboxHalt;
  /** console output, bounded by maxLogChars. */
  logs: string;
  logsTruncated: boolean;
  /** Compute the run spent inside the interpreter. */
  cpuMs: number;
}

/**
 * Thrown by a host function to end the run on purpose: the worker is
 * terminated, nothing more of the code runs, and the result carries this
 * error as `halt`. A script pausing for a person halts (lib/script/).
 */
export class SandboxHalt extends Error {
  readonly detail: unknown;
  constructor(message: string, detail?: unknown) {
    super(message);
    this.name = 'SandboxHalt';
    this.detail = detail;
  }
}

// ── The pool ─────────────────────────────────────────────────────────────────

const DEFAULT_POOL_SIZE = 16;

function poolSize(): number {
  const n = Number(process.env.MELCHIZEDEK_CODE_SANDBOX_WORKERS);
  return Number.isInteger(n) && n > 0 ? Math.min(n, 256) : DEFAULT_POOL_SIZE;
}

let running = 0;
const waiting: Array<() => void> = [];

async function acquire(signal?: AbortSignal): Promise<() => void> {
  if (running >= poolSize()) {
    await new Promise<void>((resolve, reject) => {
      const go = () => {
        signal?.removeEventListener('abort', cancel);
        resolve();
      };
      const cancel = () => {
        const at = waiting.indexOf(go);
        if (at !== -1) waiting.splice(at, 1);
        reject(new Error('canceled'));
      };
      waiting.push(go);
      signal?.addEventListener('abort', cancel, { once: true });
    });
  }
  running++;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    running--;
    waiting.shift()?.();
  };
}

// ── One run ──────────────────────────────────────────────────────────────────

/** The worker file beside this one: `.ts` when the engine runs from source, `.js` from the package. */
function workerUrl(): URL {
  return new URL(import.meta.url.endsWith('.ts') ? './worker.ts' : './worker.js', import.meta.url);
}

/** How long past its CPU budget a worker that stopped answering is given before it is terminated. */
const WATCHDOG_GRACE_MS = 1_000;

/**
 * Run `source` in a fresh sandbox. Never throws for anything the code does:
 * a thrown error, a limit, a cancel or a halt come back in the result.
 */
export async function runInSandbox(opts: SandboxRunOptions): Promise<SandboxResult> {
  const limits: SandboxLimits = { ...DEFAULT_SANDBOX_LIMITS, ...opts.limits };
  const empty = { logs: '', logsTruncated: false, cpuMs: 0 };
  if (opts.signal?.aborted) return { ok: false, error: { code: 'CANCELED', message: 'The run was canceled.' }, ...empty };
  let valueJson: string;
  try {
    valueJson = JSON.stringify(opts.value ?? null) ?? 'null';
  } catch (err) {
    return { ok: false, error: { code: 'CODE_ERROR', message: `The input is not JSON-serializable: ${(err as Error).message}` }, ...empty };
  }
  let release: () => void;
  try {
    release = await acquire(opts.signal);
  } catch {
    return { ok: false, error: { code: 'CANCELED', message: 'The run was canceled.' }, ...empty };
  }

  const functions = opts.functions ?? {};
  const worker = new Worker(workerUrl(), {
    // Source runs need type stripping in the worker; the package runs compiled JS.
    execArgv: import.meta.url.endsWith('.ts') ? ['--experimental-strip-types', '--disable-warning=ExperimentalWarning'] : [],
    // No resourceLimits: the code's heap is the wasm memory setMemoryLimit holds, outside the V8
    // heap. Capping the V8 heap made GCs frequent enough that one a background compile job asked
    // for while the worker was exiting deadlocked Node's task drain, so the worker never exited
    // and its process never could (ADR 0142).
    stdout: true,
    stderr: true,
  });

  return new Promise<SandboxResult>((resolve) => {
    let settled = false;
    let outstanding = 0;
    let idleSince = performance.now();
    let idleTotal = 0;
    const finish = (result: SandboxResult) => {
      if (settled) return;
      settled = true;
      clearInterval(watchdog);
      opts.signal?.removeEventListener('abort', onAbort);
      void worker.terminate();
      release();
      resolve(result);
    };
    const onAbort = () => finish({ ok: false, error: { code: 'CANCELED', message: 'The run was canceled.' }, ...empty });
    opts.signal?.addEventListener('abort', onAbort, { once: true });

    // The watchdog: compute is what the worker does while no host call is outstanding.
    const watchdog = setInterval(() => {
      const computing = outstanding === 0 ? idleTotal + (performance.now() - idleSince) : idleTotal;
      if (computing > limits.cpuMs + WATCHDOG_GRACE_MS) {
        finish({ ok: false, error: { code: 'CPU_LIMIT', message: `The code ran past its ${limits.cpuMs} ms CPU budget and was stopped.` }, ...empty });
      }
    }, 250);
    watchdog.unref?.();

    const startCall = () => {
      if (outstanding === 0) idleTotal += performance.now() - idleSince;
      outstanding++;
    };
    const endCall = () => {
      outstanding--;
      if (outstanding === 0) idleSince = performance.now();
    };

    worker.on('message', (message: any) => {
      if (settled) return;
      if (message?.type === 'call') {
        const fn = Object.prototype.hasOwnProperty.call(functions, message.name) ? functions[message.name] : undefined;
        startCall();
        void (async () => {
          try {
            if (!fn) throw new Error(`${message.name} is not a function the host passed in`);
            const args = JSON.parse(message.args);
            const value = await fn(Array.isArray(args) ? args : []);
            const json = value === undefined ? undefined : JSON.stringify(value);
            if (!settled) worker.postMessage({ type: 'reply', id: message.id, ok: true, value: json });
          } catch (err) {
            if (err instanceof SandboxHalt) {
              finish({ ok: false, halt: err, error: { code: 'HALTED', message: err.message }, ...empty });
              return;
            }
            const e = err instanceof Error ? err : new Error(String(err));
            if (!settled) worker.postMessage({ type: 'reply', id: message.id, ok: false, error: { name: e.name || 'Error', message: e.message } });
          } finally {
            endCall();
          }
        })();
        return;
      }
      if (message?.type === 'done') {
        const base = { logs: String(message.logs ?? ''), logsTruncated: !!message.logsTruncated, cpuMs: Number(message.cpuMs ?? 0) };
        if (!message.ok) {
          finish({ ok: false, error: message.error, ...base });
          return;
        }
        const text = String(message.result ?? 'null');
        if (text.length > limits.maxResultChars) {
          finish({ ok: false, error: { code: 'RESULT_TOO_LARGE', message: `The result is ${text.length.toLocaleString('en-US')} characters of JSON; the limit is ${limits.maxResultChars.toLocaleString('en-US')}.` }, ...base });
          return;
        }
        let result: unknown;
        try {
          result = JSON.parse(text);
        } catch {
          result = null;
        }
        finish({ ok: true, result, ...base });
      }
    });
    worker.on('error', (err: Error) => {
      const oom = (err as { code?: string }).code === 'ERR_WORKER_OUT_OF_MEMORY';
      finish({ ok: false, error: { code: oom ? 'MEMORY_LIMIT' : 'SANDBOX_CRASHED', message: oom ? 'The code ran out of memory.' : `The sandbox failed: ${err.message}` }, ...empty });
    });
    worker.on('exit', (code) => {
      finish({ ok: false, error: { code: 'SANDBOX_CRASHED', message: `The sandbox exited (${code}) before the code finished.` }, ...empty });
    });

    worker.postMessage({
      type: 'run',
      source: opts.source,
      mode: opts.mode ?? 'input',
      value: valueJson,
      functions: Object.keys(functions),
      limits: {
        memoryBytes: limits.memoryBytes,
        stackBytes: limits.stackBytes,
        cpuMs: limits.cpuMs,
        maxLogChars: limits.maxLogChars,
        maxParallel: Math.max(1, Math.min(limits.maxParallel, 32)),
      },
    });
  });
}
