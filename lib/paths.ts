/**
 * lib/paths.ts — where the engine writes on disk (ADR 0134).
 *
 * Each location keeps its own variable, which wins. Without one, the
 * default is under MELCHIZEDEK_DATA_DIR when that is set, so an embedding
 * application points every location at its own data directory with one
 * variable; with neither, the defaults are the historical ones (the working
 * directory's outputs/, and ~/.melchizedek for the ChatGPT sign-in).
 *
 *   location               own variable                     with MELCHIZEDEK_DATA_DIR   default
 *   generated files, spool OUTPUTS_DIR                      <data>/outputs              <cwd>/outputs
 *   task lists and jobs    MELCHIZEDEK_TASKS_FILE           <data>/outputs/tasks.json   <cwd>/outputs/tasks.json
 *   ChatGPT sign-in        MELCHIZEDEK_CHATGPT_SIGNIN_FILE  <data>/chatgpt-signin.json  ~/.melchizedek/chatgpt-signin.json
 *
 * Read at each call, never cached. Imports only node built-ins.
 */

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const DATA_DIR_ENV = 'MELCHIZEDEK_DATA_DIR';

const set = (env: NodeJS.ProcessEnv, name: string): string | undefined => env[name]?.trim() || undefined;

/** MELCHIZEDEK_DATA_DIR, resolved; undefined when unset. */
export function dataDir(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const d = set(env, DATA_DIR_ENV);
  return d ? resolve(d) : undefined;
}

/** Where generated files (images) and the telemetry spool go. */
export function outputsDir(env: NodeJS.ProcessEnv = process.env): string {
  const own = set(env, 'OUTPUTS_DIR');
  if (own) return resolve(own);
  const data = dataDir(env);
  return data ? join(data, 'outputs') : join(process.cwd(), 'outputs');
}

/** The task tools' JSON file, when tasks are not in Postgres. */
export function tasksFile(env: NodeJS.ProcessEnv = process.env): string {
  const own = set(env, 'MELCHIZEDEK_TASKS_FILE');
  if (own) return resolve(own);
  const data = dataDir(env);
  return data ? join(data, 'outputs', 'tasks.json') : join(process.cwd(), 'outputs', 'tasks.json');
}

/** The local Sign in with ChatGPT credential file. */
export function chatGptSignInFile(env: NodeJS.ProcessEnv = process.env): string {
  const own = set(env, 'MELCHIZEDEK_CHATGPT_SIGNIN_FILE');
  if (own) return resolve(own);
  const data = dataDir(env);
  return data ? join(data, 'chatgpt-signin.json') : join(homedir(), '.melchizedek', 'chatgpt-signin.json');
}

/**
 * The engine's own package root (the directory of its package.json named
 * melchizedek-agents), found from this module's location, whatever the
 * working directory is; undefined if it cannot be found.
 */
export function enginePackageRoot(from: string = fileURLToPath(import.meta.url)): string | undefined {
  let dir = dirname(from);
  for (let i = 0; i < 6; i++) {
    const pkg = join(dir, 'package.json');
    if (existsSync(pkg)) {
      try {
        if (JSON.parse(readFileSync(pkg, 'utf-8')).name === 'melchizedek-agents') return dir;
      } catch {
        /* not ours; keep climbing */
      }
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}
