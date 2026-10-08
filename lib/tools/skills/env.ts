/**
 * lib/tools/skills/env.ts — the environment a skill script runs with, and
 * the cap on what it prints (WS3-3b, ADR 0086).
 *
 * WHY this file exists:
 *   An approved run_skill_script used to inherit the server's whole
 *   environment, so a script (or a model steering one through its
 *   arguments) could read every provider key, the database credential and
 *   the server's bearer secrets. A script now starts from an allowlist of
 *   the variables an interpreter needs to work, plus the names the
 *   syndicate YAML lists for that agent's skills. Nothing else crosses.
 *
 * WHAT IS PASSED:
 *   - BASE_ENV_NAMES, every `LC_*`: the path, the home and temp
 *     directories, the locale, the user's name, and the Windows variables a
 *     process cannot start without. None of them holds a secret.
 *   - The names in `skills.env` and `skills.secret_env`. A name that looks
 *     like it holds a secret (isSecretShapedEnvName) is accepted only under
 *     `secret_env`, so passing a credential to a script is always a visible
 *     decision in the YAML.
 *   A listed name the server does not have is simply absent.
 *
 * NO REGULAR EXPRESSION runs here: a name is checked one segment and one
 *   substring at a time, so nothing backtracks.
 */

/** Variables every script gets, when the server has them. */
export const BASE_ENV_NAMES: readonly string[] = [
  // POSIX
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'TMPDIR',
  'TEMP',
  'TMP',
  'LANG',
  'LANGUAGE',
  'TZ',
  // Windows
  'USERPROFILE',
  'USERNAME',
  'SystemRoot',
  'SystemDrive',
  'windir',
  'ComSpec',
  'PATHEXT',
  'HOMEDRIVE',
  'HOMEPATH',
  'APPDATA',
  'LOCALAPPDATA',
  'ProgramData',
  'ProgramFiles',
  'ProgramFiles(x86)',
  'ProgramW6432',
  'CommonProgramFiles',
  'CommonProgramFiles(x86)',
  'CommonProgramW6432',
  'NUMBER_OF_PROCESSORS',
  'PROCESSOR_ARCHITECTURE',
  'OS',
];

/** Segments (between underscores) that mark a name as holding a secret. */
const SECRET_SEGMENTS: ReadonlySet<string> = new Set([
  'KEY',
  'KEYS',
  'APIKEY',
  'TOKEN',
  'TOKENS',
  'SECRET',
  'SECRETS',
  'PASS',
  'PASSWORD',
  'PASSWORDS',
  'PASSWD',
  'PWD',
  'CRED',
  'CREDS',
  'CREDENTIAL',
  'CREDENTIALS',
  'AUTH',
  'AUTHORIZATION',
  'BEARER',
  'COOKIE',
  'COOKIES',
  'SESSION',
  'PRIVATE',
  'SIGNATURE',
  'SALT',
  'HEADERS',
  'DSN',
  'DATABASE',
  'REDIS',
  'CONNECTION',
]);

/** Substrings that mark a name as holding a secret wherever they fall (GITHUBTOKEN, DBPASSWORD). */
const SECRET_SUBSTRINGS: readonly string[] = ['SECRET', 'TOKEN', 'PASSWORD', 'PASSWD', 'APIKEY', 'CREDENTIAL', 'PRIVATE'];

/**
 * Whether an environment variable's NAME suggests it holds a secret: a
 * key, a token, a password, a credential, a connection string or an auth
 * header (ANTHROPIC_API_KEY, A2A_SERVER_SECRET, DATABASE_URL,
 * MCP_BEARER_TOKENS, OTEL_EXPORTER_OTLP_HEADERS). Deliberately broad: a
 * false positive costs one line under `secret_env`.
 */
export function isSecretShapedEnvName(name: string): boolean {
  const upper = name.toUpperCase();
  if (SECRET_SUBSTRINGS.some((s) => upper.includes(s))) return true;
  return upper.split('_').some((segment) => SECRET_SEGMENTS.has(segment));
}

/**
 * The environment a script runs with: BASE_ENV_NAMES, every `LC_*`, and
 * `extraNames`, each only when `source` has it. Values are copied, never
 * read or logged.
 */
export function scriptEnvironment(extraNames: readonly string[] = [], source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  const take = (name: string) => {
    const value = source[name];
    if (typeof value === 'string') env[name] = value;
  };
  for (const name of BASE_ENV_NAMES) take(name);
  for (const name of Object.keys(source)) if (name.startsWith('LC_')) take(name);
  for (const name of extraNames) take(name);
  return env;
}

/** Characters of stdout, and of stderr, a run returns to the model. */
export const SCRIPT_OUTPUT_CHAR_LIMIT = 20_000;

/** The line that ends a stream cut at the cap; the model reads it. */
export function truncationMarker(stream: 'stdout' | 'stderr', omitted: number, limit: number): string {
  return `\n[${stream} truncated: ${omitted} more characters not shown (the limit is ${limit})]`;
}

/**
 * Collects one stream up to `limit` characters and counts the rest, so a
 * script that prints without end costs the server no more than the cap.
 */
export class CappedText {
  #text = '';
  #omitted = 0;
  readonly limit: number;

  constructor(limit: number) {
    this.limit = limit;
  }

  push(chunk: string): void {
    const room = this.limit - this.#text.length;
    if (room >= chunk.length) this.#text += chunk;
    else {
      if (room > 0) this.#text += chunk.slice(0, room);
      this.#omitted += chunk.length - Math.max(room, 0);
    }
  }

  get length(): number {
    return this.#text.length;
  }

  /** The collected text, with the marker when anything was cut. */
  text(stream: 'stdout' | 'stderr'): string {
    return this.#omitted > 0 ? this.#text + truncationMarker(stream, this.#omitted, this.limit) : this.#text;
  }
}
