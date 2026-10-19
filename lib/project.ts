/**
 * lib/project.ts — the project manifest, `melchizedek.json` (ADR 0138).
 *
 * A project is a folder, usually a git repository, with a `melchizedek.json`
 * at its root. The manifest records what the engine cannot infer from the
 * files: which folder holds the syndicates, which engine version the project
 * is written for, and how each file ships. It holds names, never values: an
 * `env` entry is a variable name, and no field may carry a secret.
 *
 * `findProject()` walks up from a directory to the nearest manifest and stops
 * at the repository root (the first directory holding `.git`) or the home
 * directory, so a manifest outside the repository never steers it.
 * `resolveAgentsDir()` is the one agents-directory chain every loader and bin
 * uses: explicit option → MELCHIZEDEK_AGENTS_DIR → the manifest's `agents` →
 * <cwd>/config/agents. A deployed server sets the variable, so the manifest
 * only changes what a bare command run inside a project finds.
 *
 * Imports only node built-ins, zod and lib/paths.ts.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { z } from 'zod';
import { enginePackageRoot } from './paths.ts';

export const PROJECT_MANIFEST = 'melchizedek.json';
export const MANIFEST_VERSION = 1;

/** A path relative to the project root: no absolute paths, no `..` segments. */
const relPath = z
  .string()
  .min(1)
  .refine((p) => !/^([a-zA-Z]:)?[\\/]/.test(p) && !p.split(/[\\/]/).includes('..'), 'must be relative to the project root and stay inside it');
const envName = z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/, 'must be an environment variable name');

const syndicateRecord = z
  .object({
    deliverable: z.enum(['service', 'library', 'mcp']).optional(),
    publish: z.object({ kind: z.literal('registry'), id: z.string().min(1) }).passthrough().optional(),
  })
  .passthrough();

export const projectManifestSchema = z
  .object({
    manifest: z.number().int().min(1),
    engine: z.string().regex(/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/, 'must be an exact version, e.g. 1.8.0'),
    agents: relPath,
    ignore: z.array(z.string().min(1)).optional(),
    tests: relPath.optional(),
    env: z.array(envName).optional(),
    syndicates: z.record(z.string(), syndicateRecord).optional(),
    registry: z
      .object({ kind: z.literal('supabase'), url_env: envName.optional(), restart: z.string().optional() })
      .passthrough()
      .optional(),
    production: z
      .object({ ledger: z.object({ kind: z.literal('postgres'), url_env: envName }).passthrough().optional() })
      .passthrough()
      .optional(),
    tools: z
      .object({ remote: z.record(z.string(), z.object({ mcp_env: envName }).passthrough()).optional() })
      .passthrough()
      .optional(),
  })
  // Unknown keys are kept: a newer writer's fields survive an older reader.
  .passthrough();

export type ProjectManifest = z.infer<typeof projectManifestSchema>;

export interface Project {
  /** The folder holding `melchizedek.json`. */
  root: string;
  /** Absolute path of the manifest. */
  file: string;
  manifest: ProjectManifest;
  /** `agents`, resolved under the root. */
  agentsDir: string;
  /** `tests`, resolved under the root (default `tests/agents`). */
  testsDir: string;
}

/** Thrown for a manifest that does not parse or validate; names the file and fields, never a value. */
export class ProjectManifestError extends Error {
  readonly file: string;
  readonly issues: string[];
  constructor(file: string, issues: string[]) {
    super(`${file}: ${issues.join('; ')}`);
    this.file = file;
    this.issues = issues;
    this.name = 'ProjectManifestError';
  }
}

/**
 * The nearest folder at or above `from` holding a manifest, without crossing
 * the repository root or the home directory. Undefined when there is none.
 */
export function findProjectRoot(from: string = process.cwd()): string | undefined {
  const home = resolve(homedir());
  let dir = resolve(from);
  for (;;) {
    if (existsSync(join(dir, PROJECT_MANIFEST))) return dir;
    if (existsSync(join(dir, '.git')) || dir === home) return undefined;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/** Parse and validate a manifest's text. Throws `ProjectManifestError`. */
export function parseProjectManifest(text: string, file = PROJECT_MANIFEST): ProjectManifest {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new ProjectManifestError(file, ['not valid JSON']);
  }
  const parsed = projectManifestSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ProjectManifestError(
      file,
      parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`),
    );
  }
  if (parsed.data.manifest > MANIFEST_VERSION) {
    throw new ProjectManifestError(file, [`manifest: version ${parsed.data.manifest} is newer than this engine reads (${MANIFEST_VERSION}); upgrade melchizedek-agents`]);
  }
  return parsed.data;
}

/** A path under the root, or an error when it would leave it. */
function under(root: string, rel: string, field: string, file: string): string {
  const abs = resolve(root, rel);
  if (abs !== root && !abs.startsWith(root + sep)) throw new ProjectManifestError(file, [`${field}: resolves outside the project root`]);
  return abs;
}

/** Load the project rooted at `root` (the folder holding the manifest). Throws `ProjectManifestError`. */
export function loadProject(root: string): Project {
  const r = resolve(root);
  const file = join(r, PROJECT_MANIFEST);
  const manifest = parseProjectManifest(readFileSync(file, 'utf-8'), file);
  return {
    root: r,
    file,
    manifest,
    agentsDir: under(r, manifest.agents, 'agents', file),
    testsDir: under(r, manifest.tests ?? join('tests', 'agents'), 'tests', file),
  };
}

/** The project at or above `from`, or undefined when there is none. Throws on a broken manifest. */
export function findProject(from: string = process.cwd()): Project | undefined {
  const root = findProjectRoot(from);
  return root ? loadProject(root) : undefined;
}

// The agents-directory chain runs on every syndicate read (an A2A route
// reads per request), so the manifest lookup is cached per working
// directory. A broken manifest is cached as "none" and reported by
// `melchizedek-doctor`, never by a request path.
const agentsDirCache = new Map<string, string | null>();

/** Forget cached manifest lookups (tests, and an embedder that edits the manifest in-process). */
export function clearProjectCache(): void {
  agentsDirCache.clear();
}

function manifestAgentsDir(cwd: string): string | undefined {
  if (!agentsDirCache.has(cwd)) {
    let dir: string | null = null;
    try {
      dir = findProject(cwd)?.agentsDir ?? null;
    } catch {
      dir = null;
    }
    agentsDirCache.set(cwd, dir);
  }
  return agentsDirCache.get(cwd) ?? undefined;
}

/**
 * The agents directory: `explicit` → MELCHIZEDEK_AGENTS_DIR → the nearest
 * manifest's `agents` → <cwd>/config/agents. Always absolute.
 */
export function resolveAgentsDir(explicit?: string, env: NodeJS.ProcessEnv = process.env): string {
  const fromEnv = env.MELCHIZEDEK_AGENTS_DIR?.trim();
  const cwd = process.cwd();
  return resolve(explicit ?? (fromEnv || undefined) ?? manifestAgentsDir(cwd) ?? join(cwd, 'config', 'agents'));
}

/** Glob to RegExp for `*` (one segment), `**` (any depth) and `?`, on `/`-separated paths. */
function globToRegExp(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        i++;
        if (glob[i + 1] === '/') {
          i++;
          re += '(?:.*/)?';
        } else re += '.*';
      } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

/** True when `relFromRoot` (a `/`-separated path relative to the project root) matches an `ignore` pattern. */
export function isIgnored(project: Pick<Project, 'manifest'>, relFromRoot: string): boolean {
  const p = relFromRoot.split(sep).join('/');
  return (project.manifest.ignore ?? []).some((g) => globToRegExp(g).test(p));
}

/** The syndicate files directly in the agents folder, as names relative to it, minus `ignore`. */
export function listProjectSyndicates(project: Project): string[] {
  if (!existsSync(project.agentsDir)) return [];
  const rel = relative(project.root, project.agentsDir);
  return readdirSync(project.agentsDir)
    .filter((f) => (f.endsWith('.yaml') || f.endsWith('.yml')) && f !== 'syndicateSchema.yaml')
    .filter((f) => statSync(join(project.agentsDir, f)).isFile())
    .filter((f) => !isIgnored(project, rel ? `${rel}/${f}` : f))
    .sort();
}

/** The installed engine's package version (no commit suffix). */
export function enginePackageVersion(): string {
  try {
    const root = enginePackageRoot();
    if (root) return String(JSON.parse(readFileSync(join(root, 'package.json'), 'utf-8')).version);
  } catch {
    /* fall through */
  }
  return '0.0.0';
}

export interface ProjectCheck {
  root: string;
  agentsDir: string;
  /** The manifest's engine pin, and the engine running now. */
  engine: { pinned: string; running: string; matches: boolean };
  syndicates: string[];
  /** Stop `melchizedek-doctor --check`. */
  problems: string[];
  /** Shown, never fatal. */
  warnings: string[];
}

/** What is wrong with a project: engine pin, missing folders, stale ignores, unset env names. Never reads a value. */
export function checkProject(project: Project, running = enginePackageVersion(), env: NodeJS.ProcessEnv = process.env): ProjectCheck {
  const problems: string[] = [];
  const warnings: string[] = [];
  const pinned = project.manifest.engine;
  const matches = pinned === running;
  if (!matches) problems.push(`engine: the project pins melchizedek-agents ${pinned}; ${running} is running`);
  if (!existsSync(project.agentsDir)) problems.push(`agents: ${project.manifest.agents} does not exist`);
  if (project.manifest.tests && !existsSync(project.testsDir)) problems.push(`tests: ${project.manifest.tests} does not exist`);
  for (const g of project.manifest.ignore ?? []) {
    if (!anyPathMatches(project.root, globToRegExp(g))) warnings.push(`ignore: "${g}" matches nothing`);
  }
  for (const name of project.manifest.env ?? []) if (!env[name]?.trim()) warnings.push(`env: ${name} is not set`);
  const syndicates = listProjectSyndicates(project);
  for (const f of Object.keys(project.manifest.syndicates ?? {})) {
    if (!syndicates.includes(f)) warnings.push(`syndicates: ${f} is not in ${project.manifest.agents}`);
  }
  return { root: project.root, agentsDir: project.agentsDir, engine: { pinned, running, matches }, syndicates, problems, warnings };
}

const SKIP_DIRS = new Set(['.git', 'node_modules', 'venv', '.venv', '__pycache__', 'dist']);

/** Whether any path under root (depth-limited, skipping vendor folders) matches. */
function anyPathMatches(root: string, re: RegExp, rel = '', depth = 0): boolean {
  if (depth > 6) return false;
  let entries: string[];
  try {
    entries = readdirSync(join(root, rel));
  } catch {
    return false;
  }
  for (const e of entries) {
    if (SKIP_DIRS.has(e)) continue;
    const p = rel ? `${rel}/${e}` : e;
    if (re.test(p)) return true;
    let dir = false;
    try {
      dir = statSync(join(root, p)).isDirectory();
    } catch {
      /* unreadable entry */
    }
    if (dir && anyPathMatches(root, re, p, depth + 1)) return true;
  }
  return false;
}
