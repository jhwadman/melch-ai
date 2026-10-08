/**
 * scripts/direct_call.ts — the no-syndicate path.
 *
 * ONE model, ONE prompt, ZERO YAML. No loadSyndicate(), no config/agents/,
 * no orchestrator/subagent graph, no agent framework: the syndicate
 * structure is a convenience this framework adds, never a requirement. The
 * block marked "the direct call" below is the whole integration surface of
 * the engine's model contract (lib/models/contract.ts, ADR 0048): resolve an
 * adapter for a model id, send it a request, read its responses. In your own
 * repo the import is `melchizedek-agents/model`, which loads no
 * `@google/adk` (ADR 0068).
 *
 * The id's prefix picks the provider (gemini-*, claude-*, gpt-*, grok-*,
 * kimi-*, ollama/*), and the provider's key comes from the environment, or
 * MODEL_GATEWAY when the key is absent. The adapter opens no span and
 * charges nothing (ADR 0053): this is the bare call. A turn with tools,
 * sessions and telemetry is runSyndicateTurn (scripts/syndicate_chat.ts).
 *
 * Usage:
 *   npm run demo:direct
 *   npm run demo:direct -- write a haiku about type safety
 *   npm run demo:direct -- --model claude-sonnet-4-6 why is the sky blue
 *   npm run demo:direct -- --model ollama/qwen3:8b hello   # keyless, local
 */

import { DEFAULT_GEMINI_MODEL } from '../lib/config.ts';
import { loadEnv } from '../lib/loadEnv.ts';
import { PROVIDERS, providerForModel, providerKeyPresent, resolveAdapter } from '../lib/model.ts';

loadEnv(import.meta.url);

// ── CLI: [--model <id>] [prompt words…] ──────────────────────────────────────
const argv = process.argv.slice(2).filter((a) => a !== '--');
let model = DEFAULT_GEMINI_MODEL;
const words: string[] = [];
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--model' && i + 1 < argv.length) {
    model = argv[++i];
  } else {
    words.push(argv[i]);
  }
}
const prompt =
  words.length > 0 ? words.join(' ') : 'In one sentence: what is an agent?';

// Fail fast with the missing env var's NAME instead of a deep API error.
// (Ollama models pass unconditionally — local inference needs no key.)
const provider = providerForModel(model);
if (!providerKeyPresent(provider) && !process.env.MODEL_GATEWAY?.trim()) {
  console.error(
    `✗ ${PROVIDERS[provider].label} requires ${PROVIDERS[provider].keyEnv}, which is not set.`,
  );
  process.exit(1);
}

// ── The direct call — this block is the whole point ──────────────────────────
const adapter = resolveAdapter(model);

console.log(`\n[direct] model=${model} — no syndicate, no YAML`);
console.log(`You › ${prompt}\n`);

let streamed = false;

for await (const response of adapter.generate({
  model,
  system: 'You are a concise, helpful assistant. Answer directly.',
  messages: [{ role: 'user', parts: [{ type: 'text', text: prompt }] }],
  stream: true,
})) {
  if (response.partial) {
    // Deltas as the model writes; thinking stays off the screen.
    for (const part of response.parts) {
      if (part.type === 'text') {
        process.stdout.write(part.text);
        streamed = true;
      }
    }
    continue;
  }
  // The final response repeats the answer whole: print it only when no
  // delta arrived.
  if (!streamed) for (const part of response.parts) if (part.type === 'text') process.stdout.write(part.text);
  // A failed call ends with an error on the final response instead of
  // throwing: surface it rather than silently printing nothing.
  if (response.error) console.error(`⚠ [${response.error.code}] ${response.error.message}`);
}
process.stdout.write('\n');
