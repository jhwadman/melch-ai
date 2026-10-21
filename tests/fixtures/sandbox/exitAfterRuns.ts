/**
 * A process that runs a mix of sandbox runs (results, a throw, a host error,
 * a masked clock, a CPU limit, wrong shapes) and then has nothing left to do,
 * so it must exit on its own. tests/codeSandbox.test.ts starts several at
 * once and fails any that is still alive past its deadline: a sandbox worker
 * that cannot finish exiting keeps its process alive (ADR 0142).
 */
// The sandbox module to load: tests/codeSandbox.test.ts passes a compiled copy, since a worker
// that runs as .js (as the package does) is the one that hung; .ts workers seldom did.
const { runInSandbox } = (await import(process.argv[2])) as typeof import('../../../lib/sandbox/sandbox.ts');
const rounds = Number(process.argv[3] ?? 2);
const api = (source: string) =>
  runInSandbox({
    source,
    mode: 'api',
    value: { pair: { output: 'x' } },
    functions: { judge: async () => { throw new Error('shut'); } },
    limits: { maxLogChars: 8_000, maxResultChars: 64_000 },
    signal: AbortSignal.timeout(15_000),
  });

for (let r = 0; r < rounds; r++) {
  await Promise.all([
    api('export default (a) => { const o = JSON.parse(\'{"answer":"42"}\'); console.log("keys:", Object.keys(o), a.pair.output); return { pass: true } }'),
    api('export default () => { throw new Error("bad pair") }'),
    api('export default async () => { await fetch("https://example.com") }'),
    api('export default () => ({ pass: Date.now() > 0 })'),
    api('export default async (a) => { await a.judge("x") }'),
  ]);
  await runInSandbox({ source: 'export default () => { for (;;) {} }', limits: { cpuMs: 200 } });
  for (const ret of ['true', '{ pass: "yes" }', '[1]', 'undefined']) await api(`export default () => (${ret})`);
}
process.stdout.write('ran\n');
