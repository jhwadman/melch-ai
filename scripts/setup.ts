#!/usr/bin/env node
/**
 * scripts/setup.ts — the `melchizedek-setup` bin and `npm run setup`.
 *
 * The onboarding command: a menu of authentication levels (no key, one
 * provider, several, a gateway, a cloud platform, per-caller keys, caller
 * tokens, OAuth tool grants, and an honest entry for subscription sign-ins),
 * each with a startup guide: the variables to set (names and shapes only),
 * the doctor command that confirms it, the shipped files that run there and
 * the first commands to try. The levels and guides live in lib/onboarding.ts;
 * ONBOARDING.md is generated from the same function.
 *
 *   npx melchizedek-setup                     # the menu (interactive terminal)
 *   npx melchizedek-setup --auto              # detect from the environment, names only
 *   npx melchizedek-setup --level gateway     # one guide, by id or number
 *   npx melchizedek-setup --level 2 --write-env   # also create .env from .env.example
 *   npx melchizedek-setup --list
 *   npx melchizedek-setup --markdown          # ONBOARDING.md, regenerated
 *   npx melchizedek-setup --chatgpt-signin    # Sign in with ChatGPT, local only (ADR 0126)
 *   npx melchizedek-setup --chatgpt-signout | --chatgpt-status
 *
 * Never prints a value. `--write-env` never overwrites `.env`, leaves every
 * name blank, and refuses unless `git check-ignore` confirms `.env` is ignored.
 */

import { realpathSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { loadEnv } from '../lib/loadEnv.ts';
import { runChatGptSignIn, runChatGptSignOut, runChatGptStatus } from '../lib/chatgpt/cli.ts';
import { runDoctor } from '../lib/doctor.ts';
import {
  detectLevels,
  highestLevel,
  LEVELS,
  levelById,
  renderAuto,
  renderGuide,
  renderMenu,
  renderOnboardingDoc,
  writeEnvForLevel,
} from '../lib/onboarding.ts';
import type { CommandForm, Level } from '../lib/onboarding.ts';

const USAGE = `melchizedek-setup — start from what you have

  melchizedek-setup                       the menu of authentication levels
  melchizedek-setup --auto                detect the highest level from the environment (names only)
  melchizedek-setup --level <id|number>   print one level's startup guide
  melchizedek-setup --list                the levels
  melchizedek-setup --markdown            every guide as Markdown (ONBOARDING.md)

  melchizedek-setup --chatgpt-signin [--port <n>]
                                          sign in with ChatGPT in your browser; OpenAI ids then run
                                          on your ChatGPT plan on this machine (local only)
  melchizedek-setup --chatgpt-signout     remove the stored tokens and revoke them at OpenAI
  melchizedek-setup --chatgpt-status      where the sign-in is stored, and whether it is used

  --write-env   with --level or --auto: create .env from .env.example with the level's
                names left blank (never overwrites; requires git to ignore .env)
  --clone | --package   spell commands for a clone or an installed package (default: detected)

Levels:
${renderMenu()}
`;

function pickLevel(raw: string): Level | undefined {
  const n = Number(raw);
  if (Number.isInteger(n) && n >= 1 && n <= LEVELS.length) return LEVELS[n - 1];
  return levelById(raw.trim());
}

function writeEnv(level: Level): number {
  const r = writeEnvForLevel(level);
  switch (r.status) {
    case 'written':
      console.log(`\n✓ wrote ${r.path} (mode 600) from .env.example${r.added.length ? `, adding blank: ${r.added.join(', ')}` : ''}. Fill in the values yourself, in your editor.`);
      return 0;
    case 'exists':
      console.log(`\n· kept ${r.path}: it exists, and setup never overwrites it. Add the names above to it yourself.`);
      return 0;
    case 'not-ignored':
      console.error(`\n✗ did not write .env: ${r.reason}`);
      return 1;
    case 'no-template':
      console.error('\n✗ did not write .env: .env.example was not found beside the package');
      return 1;
  }
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const args = argv.filter((a) => a !== '--');
  const flag = (name: string) => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined;
  };
  const inPackage = fileURLToPath(import.meta.url).includes('node_modules');
  const form: CommandForm = args.includes('--clone') ? 'clone' : args.includes('--package') ? 'package' : inPackage ? 'package' : 'clone';

  if (args.includes('--help') || args.includes('-h')) {
    console.log(USAGE);
    return 0;
  }
  if (args.includes('--list')) {
    console.log(renderMenu());
    return 0;
  }
  if (args.includes('--chatgpt-signin')) {
    loadEnv();
    const port = flag('port');
    const n = port === undefined ? undefined : Number(port);
    if (n !== undefined && !(Number.isInteger(n) && n >= 0 && n <= 65535)) {
      console.error('✗ --port must be a port number (0 picks a free one)');
      return 2;
    }
    return runChatGptSignIn(n !== undefined ? { port: n } : {});
  }
  if (args.includes('--chatgpt-signout')) {
    loadEnv();
    return runChatGptSignOut();
  }
  if (args.includes('--chatgpt-status')) {
    loadEnv();
    return runChatGptStatus();
  }
  if (args.includes('--markdown')) {
    process.stdout.write(renderOnboardingDoc());
    return 0;
  }

  let level: Level | undefined;
  if (args.includes('--auto')) {
    loadEnv();
    const result = runDoctor();
    console.log(renderAuto(result, form));
    if (!args.includes('--write-env')) return 0;
    return writeEnv(highestLevel(detectLevels(result)));
  }
  const raw = flag('level');
  if (raw !== undefined) {
    level = pickLevel(raw);
    if (!level) {
      console.error(`✗ unknown level "${raw}"\n\n${USAGE}`);
      return 2;
    }
    console.log(renderGuide(level, form));
    return args.includes('--write-env') ? writeEnv(level) : 0;
  }

  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.log(USAGE);
    return 0;
  }

  // The interactive menu.
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    console.log(`What do you have? Pick the closest; you can come back for another.\n\n${renderMenu()}\n`);
    const answer = (await rl.question(`Level [1-${LEVELS.length}], a = detect from my environment, q = quit: `)).trim().toLowerCase();
    if (answer === 'q' || answer === '') return 0;
    if (answer === 'a') {
      loadEnv();
      console.log(`\n${renderAuto(runDoctor(), form)}`);
      return 0;
    }
    level = pickLevel(answer);
    if (!level) {
      console.error(`✗ "${answer}" is not a level`);
      return 2;
    }
    console.log(`\n${renderGuide(level, form)}\n`);
    if (level.detectable) {
      const write = (await rl.question('Create .env from .env.example with these names left blank? (never overwrites) [y/N]: ')).trim().toLowerCase();
      if (write === 'y' || write === 'yes') return writeEnv(level);
    }
    return 0;
  } finally {
    rl.close();
  }
}

const invokedAsMain = (() => {
  if (!process.argv[1]) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
  } catch {
    return false;
  }
})();
if (invokedAsMain) {
  main().then(
    (code) => process.exit(code),
    (err: unknown) => {
      console.error(`✗ ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    },
  );
}
