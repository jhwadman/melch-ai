/**
 * scripts/ci/consumer_turn.mjs — CI's consumer of the packed tarball
 * (.github/workflows/ci.yml, ADR 0107). Run from an empty project that
 * installed the tarball alone, with config/agents/tutor.yaml copied beside
 * it.
 *
 * It imports the package as a user would, runs one turn of a shipped
 * example through runSyndicateTurn, serves one message through the A2A
 * server (createA2AApp), and checks that MELCHIZEDEK_RUNTIME=adk is refused
 * by name. The model is a scripted ModelAdapter, and fetch refuses every
 * call: nothing leaves the machine, and no key is read.
 */

import { request } from 'node:http';

import { loadSyndicate, runSyndicateTurn, createA2AApp, registerTool, InProcessSessionService, describeRuntime, RuntimeRemovedError } from 'melchizedek-agents';

globalThis.fetch = async (url) => {
  throw new Error(`no network in CI: ${url}`);
};

for (const [name, fn] of Object.entries({ runSyndicateTurn, createA2AApp, registerTool })) {
  if (typeof fn !== 'function') throw new Error(`${name} is not exported`);
}

const config = loadSyndicate('tutor.yaml');
if (!config.orchestrator?.name) throw new Error('loadSyndicate returned no orchestrator');

const scripted = {
  provider: 'scripted',
  model: 'scripted',
  async *generate() {
    yield { partial: false, parts: [{ type: 'text', text: 'scripted answer' }], finishReason: 'stop' };
  },
};

// ── One turn through the turn runner ─────────────────────────────────────────
const result = await runSyndicateTurn({
  config,
  parts: ['hello'],
  appName: 'ci',
  userId: 'ci',
  sessionId: 'ci',
  sessionService: new InProcessSessionService(),
  compile: { resolveModel: () => scripted },
  trace: false,
});
if (result.status !== 'completed' || result.text !== 'scripted answer') {
  throw new Error(`the turn did not complete: ${JSON.stringify(result.error ?? result.status)}`);
}

// ── One message through the A2A server ───────────────────────────────────────
const SECRET = 'ci-consumer-secret-0123456789abcdef0123456789';
const built = await createA2AApp({
  defaultSyndicate: 'tutor.yaml',
  serverSecret: SECRET,
  keyMode: 'byok',
  resolveModel: () => scripted,
  log: () => {},
  warn: () => {},
});
const server = await new Promise((resolve) => {
  const s = built.app.listen(0, '127.0.0.1', () => resolve(s));
});
try {
  const { port } = server.address();
  const body = JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'message/send',
    params: { message: { kind: 'message', messageId: 'm1', role: 'user', parts: [{ kind: 'text', text: 'hello' }] } },
  });
  const reply = await new Promise((resolve, reject) => {
    const req = request(
      { host: '127.0.0.1', port, path: '/a2a/jsonrpc', method: 'POST', headers: { authorization: `Bearer ${SECRET}`, 'content-type': 'application/json', 'x-api-key': 'ci-caller', 'content-length': Buffer.byteLength(body) } },
      (res) => {
        let text = '';
        res.on('data', (chunk) => (text += chunk));
        res.on('end', () => resolve({ status: res.statusCode, text }));
      },
    );
    req.on('error', reject);
    req.end(body);
  });
  if (reply.status !== 200 || !reply.text.includes('scripted answer')) {
    throw new Error(`the A2A server did not answer: ${reply.status} ${reply.text.slice(0, 300)}`);
  }
} finally {
  await new Promise((resolve) => server.close(resolve));
}

// ── The removed runtime is refused by name ───────────────────────────────────
let refused;
try {
  describeRuntime(undefined, { MELCHIZEDEK_RUNTIME: 'adk' });
} catch (err) {
  refused = err;
}
if (!(refused instanceof RuntimeRemovedError) || !refused.message.includes('1.0.0')) {
  throw new Error(`MELCHIZEDEK_RUNTIME=adk was not refused by name: ${refused?.message ?? 'no error'}`);
}

const { runtime, source } = describeRuntime();
console.log(`package OK: ${config.syndicate_name} on ${runtime} (${source}); the A2A server answered; adk is refused`);
