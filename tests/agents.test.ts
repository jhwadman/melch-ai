/**
 * Public test suite — validates every shipped syndicate.
 *
 * Two tiers:
 *   1. Compilation (always runs, no network, no keys): every YAML in
 *      config/agents/ must load, validate, and resolve its tool names.
 *   2. Live inference (opt-in): set GOOGLE_GENAI_API_KEY (in .env or the
 *      environment) and RUN_LIVE_TESTS=true to run one real turn per
 *      syndicate. Skipped otherwise, so `npm test` is free and offline.
 *
 * The syndicate list is enumerated from disk on purpose — the suite can
 * never drift from the shipped set.
 */
import { test } from 'node:test';
import assert from 'node:assert';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { setLogLevel } from '../lib/runtime/logging.ts';
import { loadSyndicate, validateRegistryConfig } from '../lib/loadSyndicate.ts';
import { resolveTools } from '../lib/toolRegistry.ts';

setLogLevel('warn');

function loadEnv(): void {
  const envPath = join(process.cwd(), '.env');
  if (!existsSync(envPath)) return;
  const raw = readFileSync(envPath, 'utf-8');
  for (const line of raw.split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && m[1] && process.env[m[1]] === undefined) {
      process.env[m[1]] = m[2];
    }
  }
}
loadEnv();

const AGENT_DIR = join(process.cwd(), 'config', 'agents');
const agentFiles = readdirSync(AGENT_DIR).filter((f) => f.endsWith('.yaml'));
// The compile tier walks the subdirectories too: the starter pack lives in
// examples/ and the production templates in templates/, and a shipped file
// the suite never loads is a file nobody checked.
const shippedFiles = readdirSync(AGENT_DIR, { recursive: true })
  .map(String)
  .filter((f) => f.endsWith('.yaml'))
  .sort();

test('Syndicate compilation — every shipped YAML loads and validates', async (t) => {
  assert.ok(shippedFiles.length > 0, 'no syndicate YAML files found');
  await Promise.all(
    shippedFiles.map((filename) =>
      t.test(`${filename} loads, validates, and resolves tools`, () => {
        const config = loadSyndicate(filename);
        assert.ok(config, `Failed to load ${filename}`);
        assert.ok(config.syndicate_name, `Syndicate name missing in ${filename}`);

        validateRegistryConfig(config.orchestrator);
        const unknown: string[] = [];
        resolveTools(config.orchestrator.tools, (n) => unknown.push(n));

        for (const sub of config.subagents ?? []) {
          validateRegistryConfig(sub);
          resolveTools(sub.tools, (n) => unknown.push(n));
        }
        assert.deepStrictEqual(
          unknown,
          [],
          `${filename} references unregistered tools: ${unknown.join(', ')}`,
        );
      }),
    ),
  );
});

const liveEnabled =
  process.env.RUN_LIVE_TESTS === 'true' &&
  (process.env.GOOGLE_GENAI_API_KEY || process.env.GEMINI_API_KEY);

test(
  'Live inference — one real turn per syndicate (RUN_LIVE_TESTS=true)',
  { skip: !liveEnabled && 'set RUN_LIVE_TESTS=true and a Gemini key to enable' },
  async (t) => {
    const { runSyndicateTurn } = await import('../lib/runtime/syndicateTurn.ts');
    const { InProcessSessionService } = await import('../lib/runtime/sessions.ts');

    await Promise.all(
      agentFiles
        .filter((f) => f !== 'syndicateSchema.yaml')
        .map((filename) =>
          t.test(`${filename} answers a live turn`, async () => {
            const config = loadSyndicate(filename);
            const result = await runSyndicateTurn({
              config,
              parts: [{ text: 'Reply with the single word: ready' }],
              appName: `test-${config.syndicate_name}`,
              userId: 'test',
              sessionId: 't1',
              sessionService: new InProcessSessionService(),
              trace: false,
            });
            const reply = result.text;
            assert.ok(reply.trim().length > 0, `Empty inference reply for ${filename}`);
          }),
        ),
    );
  },
);
