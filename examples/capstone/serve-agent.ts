/**
 * examples/capstone/serve-agent.ts — starts the A2A agent service the way the
 * capstone needs it on a learner's own machine.
 *
 *   npm run capstone:agent
 *
 * The same server as `npm run start:a2a -- event_assistant.yaml`, with three
 * settings a local capstone run always wants. Each is a default: a value
 * already in the environment wins.
 *
 *   HOST=127.0.0.1                 listen on this machine only
 *   ALLOW_PRIVATE_MCP=true         reach the starter's tool on a loopback
 *                                  address (local development only; a
 *                                  deployed server never sets it)
 *   MELCHIZEDEK_CHATGPT_SIGNIN=off ignore a ChatGPT sign-in stored on this
 *                                  machine. A served surface refuses to start
 *                                  while one would route OpenAI models
 *                                  (ADR 0126); the Event Assistant runs on
 *                                  Ollama and never uses it, and `off` is the
 *                                  setting ADR 0126 provides for a served
 *                                  process on a machine that also signed in.
 *
 * It spawns the server as a child with the same Node flags rather than
 * importing it, because the server's entry point runs only when it is the
 * process's own script; a child also keeps the settings out of the
 * learner's shell, so the command is the same on Windows, macOS and Linux.
 */
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const env = { ...process.env };
env.HOST ??= '127.0.0.1';
env.ALLOW_PRIVATE_MCP ??= 'true';
env.MELCHIZEDEK_CHATGPT_SIGNIN ??= 'off';

const syndicate = process.argv[2] ?? 'event_assistant.yaml';
const child = spawn(
  process.execPath,
  ['--disable-warning=DEP0040', '--experimental-strip-types', join(root, 'scripts', 'a2a_server.ts'), syndicate],
  { cwd: root, env, stdio: 'inherit' },
);
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => child.kill(signal));
child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
