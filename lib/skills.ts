/**
 * lib/skills.ts — the agent-skills suite installer, as a library.
 *
 * WHY: the framework ships a suite of Agent Skills (skills/<name>/SKILL.md,
 * the open SKILL.md standard) that teach a coding agent — Claude Code, Codex,
 * Cursor, OpenCode, Gemini CLI — where the syndicates are and how to run,
 * author, serve and remember with them. Each platform reads skills from its
 * own directory; this module knows those directories and copies the suite
 * into them. `scripts/skills_install.ts` (the `melchizedek-skills` bin) is
 * the CLI over it; `tests/skills.test.ts` exercises it against temp dirs.
 *
 * Safety: the source is the package's own skills/ directory (resolved by
 * walking up from this file), symlinks are never followed, and a file that
 * already exists with different content is left alone unless `force` is set.
 * A SKILL.md's frontmatter is read by the skills harness's own parser
 * (lib/tools/skills/frontmatter.ts), the one an agent's `skills:` uses.
 */
import { closeSync, constants as fsConstants, existsSync, fstatSync, ftruncateSync, lstatSync, mkdirSync, openSync, readSync, readdirSync, readFileSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { MAX_SKILL_MD_CHARS, parseSkillMd } from './tools/skills/frontmatter.ts';

export type SkillTarget = 'claude' | 'agents' | 'codex' | 'cursor' | 'opencode' | 'gemini';

export interface TargetPaths {
  /** Relative to the project root (the directory the agent is opened in). */
  project: string;
  /** Relative to the home directory. */
  global: string;
  /** Which agents read this location. */
  readBy: string;
}

/**
 * Where each coding agent discovers skills. `.agents/skills/` is the shared
 * location Codex, Cursor, OpenCode and Gemini CLI all read, so the default
 * install writes `claude` + `agents` and reaches every listed agent.
 */
export const SKILL_TARGETS: Record<SkillTarget, TargetPaths> = {
  claude: { project: '.claude/skills', global: '.claude/skills', readBy: 'Claude Code (also read by OpenCode)' },
  agents: { project: '.agents/skills', global: '.agents/skills', readBy: 'Codex, Cursor, OpenCode, Gemini CLI' },
  codex: { project: '.agents/skills', global: '.codex/skills', readBy: 'Codex' },
  cursor: { project: '.cursor/skills', global: '.cursor/skills', readBy: 'Cursor' },
  opencode: { project: '.opencode/skills', global: '.config/opencode/skills', readBy: 'OpenCode' },
  gemini: { project: '.gemini/skills', global: '.gemini/skills', readBy: 'Gemini CLI' },
};

export const DEFAULT_TARGETS: SkillTarget[] = ['claude', 'agents'];

/** The package's skills/ directory: walk up from this module until it appears. */
export function resolveSkillsSource(from: string = fileURLToPath(import.meta.url)): string {
  let dir = dirname(from);
  for (let i = 0; i < 6; i++) {
    const candidate = join(dir, 'skills');
    if (existsSync(join(candidate, 'melchizedek', 'SKILL.md'))) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error('skills/ directory not found beside the package (looked for skills/melchizedek/SKILL.md)');
}

/**
 * A SKILL.md's frontmatter as written, read by the harness's own parser
 * (lib/tools/skills/frontmatter.ts: bounded, no backtracking pattern). A
 * file that is too large, has no frontmatter or does not parse yields none,
 * and the listing falls back to the directory's name.
 */
function frontmatterOf(file: string): Record<string, unknown> {
  try {
    // One open file: the size checked is the size of the file read.
    const fd = openSync(file, 'r');
    try {
      if (fstatSync(fd).size > MAX_SKILL_MD_CHARS) return {};
      const buffer = Buffer.alloc(MAX_SKILL_MD_CHARS + 1);
      const length = readSync(fd, buffer, 0, buffer.length, 0);
      if (length > MAX_SKILL_MD_CHARS) return {};
      return parseSkillMd(buffer.subarray(0, length).toString('utf-8')).raw;
    } finally {
      closeSync(fd);
    }
  } catch {
    return {};
  }
}

export interface SkillInfo {
  name: string;
  description: string;
  dir: string;
}

/** Every skill in the suite: a directory holding a SKILL.md with name + description frontmatter. */
export function listSkills(source: string = resolveSkillsSource()): SkillInfo[] {
  return readdirSync(source, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(join(source, d.name, 'SKILL.md')))
    .map((d) => {
      const fm = frontmatterOf(join(source, d.name, 'SKILL.md'));
      const field = (k: string): string => (typeof fm[k] === 'string' ? (fm[k] as string).trim() : '');
      return { name: field('name') || d.name, description: field('description'), dir: join(source, d.name) };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

export interface InstallOptions {
  /** Explicit destination directory; overrides targets/global. */
  dir?: string;
  targets?: SkillTarget[];
  global?: boolean;
  /** Project root for non-global installs (default: cwd). */
  projectRoot?: string;
  /** Home directory for global installs (default: os.homedir()). */
  home?: string;
  /** Skill names to install (default: every skill). */
  only?: string[];
  force?: boolean;
  dryRun?: boolean;
  source?: string;
}

export interface InstallResult {
  destination: string;
  written: string[];
  skipped: string[];
  unchanged: string[];
}

/** Resolve the destination directories an install would write to (deduplicated, in order). */
export function destinationsFor(opts: InstallOptions): string[] {
  if (opts.dir) return [resolve(opts.dir)];
  const targets = opts.targets && opts.targets.length > 0 ? opts.targets : DEFAULT_TARGETS;
  const root = opts.global ? (opts.home ?? homedir()) : resolve(opts.projectRoot ?? process.cwd());
  const out: string[] = [];
  for (const t of targets) {
    const paths = SKILL_TARGETS[t];
    if (!paths) throw new Error(`unknown target "${t}" (known: ${Object.keys(SKILL_TARGETS).join(', ')})`);
    const dest = join(root, opts.global ? paths.global : paths.project);
    if (!out.includes(dest)) out.push(dest);
  }
  return out;
}

function walk(dir: string, base: string = dir): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (lstatSync(full).isSymbolicLink()) continue; // never follow links out of the suite
    if (entry.isDirectory()) out.push(...walk(full, base));
    else if (entry.isFile()) out.push(relative(base, full));
  }
  return out.sort();
}

/** Copy the suite into every destination. Returns one result per destination. */
export function installSkills(opts: InstallOptions = {}): InstallResult[] {
  const source = opts.source ?? resolveSkillsSource();
  const skills = listSkills(source).filter((s) => !opts.only || opts.only.includes(s.name));
  if (opts.only) {
    const known = new Set(listSkills(source).map((s) => s.name));
    for (const name of opts.only) if (!known.has(name)) throw new Error(`unknown skill "${name}"`);
  }
  const results: InstallResult[] = [];
  for (const destination of destinationsFor(opts)) {
    const result: InstallResult = { destination, written: [], skipped: [], unchanged: [] };
    for (const skill of skills) {
      const skillDir = skill.dir;
      const destSkillDir = join(destination, relative(dirname(skillDir), skillDir));
      for (const rel of walk(skillDir)) {
        const src = join(skillDir, rel);
        const dst = join(destSkillDir, rel);
        // The destination stays inside the skill's own directory: a hostile
        // filename in the suite could not escape it.
        if (!resolve(dst).startsWith(resolve(destSkillDir))) throw new Error(`refusing to write outside ${destSkillDir}: ${rel}`);
        const label = relative(destination, dst);
        const bytes = readFileSync(src);
        if (existsSync(dst)) {
          if (statSync(dst).isFile() && readFileSync(dst).equals(bytes)) { result.unchanged.push(label); continue; }
          if (!opts.force) { result.skipped.push(label); continue; }
        }
        if (!opts.dryRun) {
          mkdirSync(dirname(dst), { recursive: true });
          writeFileSync(dst, bytes);
        }
        result.written.push(label);
      }
    }
    results.push(result);
  }
  return results;
}

// ── The AGENTS.md pointer ────────────────────────────────────────────────────

/** The markers that delimit the block this installer owns inside AGENTS.md. */
export const AGENTS_MD_BEGIN = '<!-- melchizedek-skills:begin -->';
export const AGENTS_MD_END = '<!-- melchizedek-skills:end -->';

/** The pointer: where the skills are, and the onboarding entry point. */
export function agentsMdBlock(destinations: string[], projectRoot: string): string {
  const where = destinations.map((d) => `\`${relative(projectRoot, d) || '.'}/\``).join(' and ');
  return [
    AGENTS_MD_BEGIN,
    '## Melchizedek agent skills',
    '',
    `The melchizedek-agents skills are installed in ${where}, one directory per skill with a SKILL.md.`,
    'To onboard someone, start with `melchizedek-onboard/SKILL.md`, or run `npx melchizedek-setup --auto`.',
    'Never ask for an API key in chat and never print a value from `.env`: the person types keys into `.env` themselves.',
    AGENTS_MD_END,
  ].join('\n');
}

export interface AgentsMdResult {
  path: string;
  status: 'created' | 'appended' | 'updated' | 'unchanged';
}

/**
 * Write the pointer into `<projectRoot>/AGENTS.md`, the instructions file
 * Codex and other agents read: create the file when absent, append the block
 * when the file has none, or replace only the block between the markers.
 * Nothing outside the markers is ever changed.
 */
export function writeAgentsMdPointer(
  projectRoot: string,
  destinations: string[],
  opts: { dryRun?: boolean } = {},
): AgentsMdResult {
  const path = join(resolve(projectRoot), 'AGENTS.md');
  const block = agentsMdBlock(destinations, resolve(projectRoot));
  const plan = (text: string | undefined): { status: AgentsMdResult['status']; next: string } => {
    if (text === undefined) return { status: 'created', next: `# AGENTS.md\n\n${block}\n` };
    const start = text.indexOf(AGENTS_MD_BEGIN);
    const end = text.indexOf(AGENTS_MD_END);
    if (start !== -1 && end > start) {
      const next = text.slice(0, start) + block + text.slice(end + AGENTS_MD_END.length);
      return { status: next === text ? 'unchanged' : 'updated', next };
    }
    return { status: 'appended', next: `${text}${text.endsWith('\n') ? '' : '\n'}\n${block}\n` };
  };
  if (opts.dryRun) {
    // Nothing is written, so a path check is enough to report what would happen.
    if (existsSync(path) && lstatSync(path).isSymbolicLink()) throw new Error(`refusing to write through a symlink: ${path}`);
    return { path, status: plan(existsSync(path) ? readFileSync(path, 'utf-8') : undefined).status };
  }
  // One handle for the read and the write, so the file read is the file written:
  // created if absent, never followed through a symlink (O_NOFOLLOW).
  let fd: number;
  try {
    fd = openSync(path, fsConstants.O_RDWR | fsConstants.O_CREAT | (fsConstants.O_NOFOLLOW ?? 0), 0o644);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ELOOP') throw new Error(`refusing to write through a symlink: ${path}`);
    throw err;
  }
  let status: AgentsMdResult['status'];
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) throw new Error(`not a regular file: ${path}`);
    const existing = stat.size > 0 ? readFileSync(fd, 'utf-8') : undefined;
    const result = plan(existing);
    status = result.status;
    if (status !== 'unchanged') {
      ftruncateSync(fd, 0);
      writeSync(fd, result.next, 0);
    }
  } finally {
    closeSync(fd);
  }
  return { path, status };
}
