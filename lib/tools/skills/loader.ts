/**
 * lib/tools/skills/loader.ts — a directory of skills, loaded by the engine
 * (WS3-3, ADR 0083).
 *
 * WHY this file exists:
 *   The skills harness (lib/tools/skillToolset.ts, ADR 0029) loaded skills
 *   through ADK's `loadAllSkillsInDir` until WS3-3. This module walks the
 *   same layout to the same objects, so a skill reads the same on either
 *   runtime:
 *   - a skill is a directory, other than the base itself, holding a file
 *     named SKILL.md in any case; its name must equal the directory's;
 *   - a directory that is not a skill is searched for skills below it;
 *   - a skill's `references/`, `assets/` and `scripts/` are read whole,
 *     each file keyed by its path inside that directory: UTF-8 text as a
 *     string, anything else as a Buffer; a script is `{ src }` and only a
 *     text one is kept;
 *   - build and tool directories (node_modules, .git, __pycache__, …) and
 *     compiled files (.pyc, …) are skipped, as are symbolic links, which a
 *     directory listing never reports as a file or a directory;
 *   - an invalid skill is skipped (validateSkillDir says why).
 *
 * WHAT IS BOUNDED (none of these limits exists in ADK's loader):
 *   SKILL_LIMITS caps a SKILL.md's size, each resource file's size, the
 *   files one skill may ship, and how deep the walk goes. A resource over
 *   its limit is skipped and reported through `onWarning`; nothing larger is
 *   read into memory.
 *
 * The files are the operator's: the YAML's `skills.dir` names the shelf,
 * and nothing a model sends reaches this module.
 */

import { isUtf8 } from 'node:buffer';
import { constants as fsConstants } from 'node:fs';
import type { Dirent } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { ALLOWED_FRONTMATTER_KEYS, MAX_SKILL_MD_CHARS, parseSkillMdContent } from './frontmatter.ts';
import type { SkillFrontmatter } from './frontmatter.ts';

/** A file a skill ships: text as a string, binary as a Buffer. */
export type SkillFile = string | Buffer;

/** One skill, loaded: the shape load_skill and the tools read. */
export interface Skill {
  frontmatter: SkillFrontmatter;
  /** The SKILL.md body: the procedure. */
  instructions: string;
  resources: {
    references: Record<string, SkillFile>;
    assets: Record<string, SkillFile>;
    scripts: Record<string, { src: string }>;
  };
}

/** What the loader refuses to read. */
/**
 * A file's bytes read through one open handle, so the size checked is the
 * size of the file read (no check-then-read race): undefined when it holds
 * more than `maxBytes`, or is not a regular file.
 */
export async function readFileBounded(file: string, maxBytes: number): Promise<Buffer | undefined> {
  const handle = await fs.open(file, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > maxBytes) return undefined;
    const buffer = Buffer.alloc(maxBytes + 1);
    let length = 0;
    for (;;) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
      if (bytesRead === 0) break;
      length += bytesRead;
      if (length > maxBytes) return undefined;
    }
    return buffer.subarray(0, length);
  } finally {
    await handle.close();
  }
}

export const SKILL_LIMITS = {
  /** Bytes a SKILL.md may hold. */
  skillMdBytes: MAX_SKILL_MD_CHARS,
  /** Bytes one resource file may hold; a larger one is skipped. */
  resourceBytes: 8 * 1024 * 1024,
  /** Resource files one skill may ship; those past it are skipped. */
  resourceFiles: 1000,
  /** Directory levels below the base (or below a resource directory) the walk descends. */
  depth: 12,
} as const;

/** Directories never searched for skills or resources (ADK's list). */
export const IGNORED_DIRECTORIES: ReadonlySet<string> = new Set([
  '__pycache__',
  '.pytest_cache',
  '.mypy_cache',
  '.ruff_cache',
  'node_modules',
  'coverage',
  'venv',
  '.venv',
  'env',
  '.env',
  '.git',
  '.vscode',
  '.idea',
]);

/** Files never read as resources (ADK's list). */
export const IGNORED_EXTENSIONS: ReadonlySet<string> = new Set(['.pyc', '.pyo', '.pyd', '.tsbuildinfo', '.DS_Store']);

/** Where the loader reports what it skipped for a limit. */
export interface LoadOptions {
  onWarning?: (message: string) => void;
}

function decode(data: Buffer): SkillFile {
  return isUtf8(data) ? data.toString('utf-8') : data;
}

/** Every file under `directoryPath`, keyed by its relative path, within the limits. Absent: none. */
async function loadDir(directoryPath: string, budget: { files: number }, opts: LoadOptions): Promise<Record<string, SkillFile>> {
  const files: Record<string, SkillFile> = {};
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > SKILL_LIMITS.depth) {
      opts.onWarning?.(`skipped '${dir}': deeper than ${SKILL_LIMITS.depth} levels`);
      return;
    }
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (IGNORED_DIRECTORIES.has(entry.name)) continue;
        await walk(fullPath, depth + 1);
      } else if (entry.isFile()) {
        if (IGNORED_EXTENSIONS.has(path.extname(entry.name))) continue;
        const relativePath = path.relative(directoryPath, fullPath);
        if (budget.files <= 0) {
          opts.onWarning?.(`skipped '${fullPath}': a skill ships at most ${SKILL_LIMITS.resourceFiles} files`);
          continue;
        }
        const bytes = await readFileBounded(fullPath, SKILL_LIMITS.resourceBytes);
        if (!bytes) {
          opts.onWarning?.(`skipped '${fullPath}': larger than ${SKILL_LIMITS.resourceBytes} bytes`);
          continue;
        }
        budget.files -= 1;
        Object.defineProperty(files, relativePath, { value: decode(bytes), enumerable: true, writable: true, configurable: true });
      }
    }
  };
  let isDir = false;
  try {
    isDir = (await fs.stat(directoryPath)).isDirectory();
  } catch {
    return files; // no such directory: the skill ships none of this kind
  }
  if (isDir) {
    try {
      await walk(directoryPath, 0);
    } catch (e) {
      opts.onWarning?.(`failed to load directory '${directoryPath}': ${(e as Error).message}`);
    }
  }
  return files;
}

/** The SKILL.md in `skillDir`, checked; throws ADK's texts when it is missing or invalid. */
export async function loadSkillFile(skillDir: string): Promise<{ frontmatter: SkillFrontmatter; instructions: string }> {
  const resolvedDir = path.resolve(skillDir);
  let content: string | undefined;
  let entries: Dirent[] = [];
  try {
    entries = await fs.readdir(resolvedDir, { withFileTypes: true });
  } catch {
    entries = [];
  }
  for (const entry of entries) {
    if (!entry.isFile() || entry.name.toLowerCase() !== 'skill.md') continue;
    const file = path.join(resolvedDir, entry.name);
    try {
      const bytes = await readFileBounded(file, SKILL_LIMITS.skillMdBytes);
      if (!bytes) throw new Error(`SKILL.md is larger than ${SKILL_LIMITS.skillMdBytes} bytes`);
      content = bytes.toString('utf-8');
      break;
    } catch (e) {
      if ((e as Error).message.startsWith('SKILL.md is larger')) throw e;
    }
  }
  if (content === undefined) throw new Error(`SKILL.md (or any case variation like skill.md) not found in '${skillDir}'.`);
  const { frontmatter, body } = parseSkillMdContent(content);
  const dirName = path.basename(resolvedDir);
  if (dirName !== frontmatter.name) throw new Error(`Skill name '${frontmatter.name}' does not match directory name '${dirName}'.`);
  return { frontmatter, instructions: body };
}

/** One skill directory: its SKILL.md and the files it ships. */
export async function loadSkillFromDir(skillDir: string, opts: LoadOptions = {}): Promise<Skill> {
  const resolvedDir = path.resolve(skillDir);
  const skill = await loadSkillFile(skillDir);
  const budget = { files: SKILL_LIMITS.resourceFiles };
  const references = await loadDir(path.join(resolvedDir, 'references'), budget, opts);
  const assets = await loadDir(path.join(resolvedDir, 'assets'), budget, opts);
  const rawScripts = await loadDir(path.join(resolvedDir, 'scripts'), budget, opts);
  const scripts: Record<string, { src: string }> = {};
  for (const [name, src] of Object.entries(rawScripts)) {
    if (typeof src === 'string') Object.defineProperty(scripts, name, { value: { src }, enumerable: true, writable: true, configurable: true });
  }
  return { ...skill, resources: { references, assets, scripts } };
}

/**
 * Why `skillDir` is not a valid skill, or nothing: ADK's validateSkillDir.
 * A SKILL.md that cannot be read or parsed is one problem; otherwise each
 * frontmatter key the standard does not name, and a name that is not the
 * directory's.
 */
export async function validateSkillDir(skillDir: string): Promise<string[]> {
  const resolvedDir = path.resolve(skillDir);
  let skill: { frontmatter: SkillFrontmatter };
  try {
    skill = await loadSkillFile(resolvedDir);
  } catch (e) {
    return [(e as Error).message];
  }
  const problems: string[] = [];
  const unknown = Object.keys(skill.frontmatter).filter((k) => !ALLOWED_FRONTMATTER_KEYS.has(k));
  if (unknown.length > 0) problems.push(`Unknown frontmatter fields: [${unknown.sort().join(', ')}]`);
  const dirName = path.basename(resolvedDir);
  if (dirName !== skill.frontmatter.name) problems.push(`Skill name '${skill.frontmatter.name}' does not match directory name '${dirName}'.`);
  return problems;
}

/**
 * Every valid skill under `basePath`, by name, in the order the walk finds
 * them (a later skill of the same name replaces an earlier one, as in ADK).
 * A base that is not a readable directory yields none.
 */
export async function loadAllSkillsInDir(basePath: string, opts: LoadOptions = {}): Promise<Record<string, Skill>> {
  const resolvedPath = path.resolve(basePath);
  const skills: Record<string, Skill> = {};
  const scan = async (currentDir: string, depth: number): Promise<void> => {
    if (depth > SKILL_LIMITS.depth) return;
    let entries: Dirent[];
    try {
      entries = await fs.readdir(currentDir, { withFileTypes: true });
    } catch {
      return;
    }
    const isSkillDir = currentDir !== resolvedPath && entries.some((e) => e.isFile() && e.name.toLowerCase() === 'skill.md');
    if (isSkillDir) {
      try {
        const skill = await loadSkillFromDir(currentDir, opts);
        Object.defineProperty(skills, skill.frontmatter.name, { value: skill, enumerable: true, writable: true, configurable: true });
      } catch {
        // Skipped: validateSkillDir (skillSuiteProblems) reports why.
      }
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || IGNORED_DIRECTORIES.has(entry.name)) continue;
      await scan(path.join(currentDir, entry.name), depth + 1);
    }
  };
  await scan(resolvedPath, 0);
  return skills;
}

