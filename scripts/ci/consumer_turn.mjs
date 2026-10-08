/**
 * scripts/ci/consumer_turn.mjs — CI's consumer of the packed tarball
 * (.github/workflows/ci.yml, ADR 0102). Run from an empty project that
 * installed the tarball, with config/agents/tutor.yaml copied beside it.
 *
 * It imports the package as a user would, runs one turn of a shipped
 * example on whatever runtime MELCHIZEDEK_RUNTIME selects (native when
 * unset), and checks the runtime and whether @google/adk is installed
 * against EXPECT_RUNTIME and EXPECT_ADK. The model is a scripted adapter
 * behind the ADK shim, and fetch refuses every call: nothing leaves the
 * machine, and no key is read.
 */

import { loadSyndicate, runSyndicateTurn, createA2AApp, registerTool, InProcessSessionService, asAdkSessionService, adkInstalled, describeRuntime } from 'melchizedek-agents';
import { adkShim } from 'melchizedek-agents/models/adkShim';

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

const result = await runSyndicateTurn({
  config,
  parts: ['hello'],
  appName: 'ci',
  userId: 'ci',
  sessionId: 'ci',
  sessionService: asAdkSessionService(new InProcessSessionService()),
  compile: { resolveModel: () => adkShim(scripted) },
  trace: false,
});

const { runtime, source } = describeRuntime();
if (process.env.EXPECT_RUNTIME && runtime !== process.env.EXPECT_RUNTIME) throw new Error(`ran on ${runtime}, expected ${process.env.EXPECT_RUNTIME}`);
if (process.env.EXPECT_ADK && adkInstalled() !== (process.env.EXPECT_ADK === 'yes')) throw new Error(`adkInstalled() is ${adkInstalled()}`);
if (result.status !== 'completed' || result.text !== 'scripted answer') {
  throw new Error(`the turn did not complete: ${JSON.stringify(result.error ?? result.status)}`);
}
console.log(`package OK: ${config.syndicate_name} on ${runtime} (${source}), @google/adk installed: ${adkInstalled()}`);
