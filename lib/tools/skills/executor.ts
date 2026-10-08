/**
 * lib/tools/skills/executor.ts — runs one script a skill ships, on this
 * machine (WS3-3, ADR 0083). The engine's port of ADK's
 * UnsafeLocalCodeExecutor and of the staging RunSkillScriptTool does.
 *
 * WHY this file exists:
 *   `skills.scripts: local` (ADR 0029) runs a skill's own scripts after a
 *   person approves each run (run_skill_script in ./tools.ts). The harness
 *   ran them through ADK's local executor until WS3-3. This module runs
 *   them the same way, so a run returns the same result on either runtime.
 *
 * WHAT A RUN IS, AND WHAT A SCRIPT CAN REACH (unchanged from ADK's executor):
 *   1. A fresh private directory under the OS temp directory (mkdtemp,
 *      mode 0700) is the working directory. Every file the skill ships is
 *      written into it at its path (references/…, assets/…, scripts/…),
 *      beside a wrapper that starts the script: `require('./scripts/x.js')`
 *      under this Node, `runpy.run_path` under python3, `source` under bash
 *      (PowerShell or cmd on Windows).
 *   2. The child runs with the server's own user and its permissions, with
 *      network access, and can read any file that user can read. Nothing
 *      sandboxes it: the approval of each run, and the operator's choice of
 *      skill directory, are the controls (ADR 0029). Its environment is NOT
 *      the server's: it gets only the allowlist an interpreter needs and
 *      the names the YAML lists for the agent's skills (./env.ts, ADR 0086),
 *      so no provider key, database credential or bearer secret reaches it
 *      unless the YAML names it under `skills.secret_env`.
 *   3. The arguments are the model's `args` object as `--key value` pairs,
 *      passed as argv (never through a shell string).
 *   4. It is killed (SIGKILL) after `timeoutSeconds`. Its stdout and its
 *      stderr are each kept up to SCRIPT_OUTPUT_CHAR_LIMIT characters (20,000);
 *      the rest is counted, not held, and a line saying how much was cut
 *      ends the stream the model reads. A non-zero exit with no stderr
 *      reports `Exit code N`.
 *   5. Files the script wrote in its directory (other than the ones staged)
 *      come back as `outputFiles`, UTF-8 or base64 by extension, and are
 *      copied into the toolset's output directory, never over a file
 *      already there and never outside it. The working directory is then
 *      removed.
 *
 * The model chooses only which shipped script runs and its arguments; the
 * tool resolves the script against the skill's own `scripts/` map, so a
 * path the skill does not ship never reaches this module.
 */

import { spawn } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { CappedText, SCRIPT_OUTPUT_CHAR_LIMIT, scriptEnvironment } from './env.ts';
import { SKILL_LIMITS, readFileBounded } from './loader.ts';
import type { Skill } from './loader.ts';

/** The languages a script can be in, by its extension (ADK's CodeExecutionLanguage values). */
export type ScriptLanguage = 'unspecified' | 'python' | 'javascript' | 'typescript' | 'shell' | 'powershell' | 'cmd';

type Encoding = 'utf-8' | 'base64';

/** A file staged for, or written by, a run. `content` is encoded as `contentEncoding` says. */
export interface ScriptFile {
  name: string;
  content: string;
  contentEncoding: Encoding;
  mimeType: string;
}

/** What one run returns to the model (with `outputDirectory` added by the tool). */
export interface ScriptRunResult {
  stdout: string;
  stderr: string;
  outputFiles: ScriptFile[];
}

const IS_WINDOWS = os.platform() === 'win32';

const POWERSHELL_BASE_ARGS = ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File'];
const CMD_BASE_ARGS = ['/D', '/c'];

/** ADK's MIME map: what each extension is, and whether it travels as UTF-8 or base64. */
const MIME_TYPES: Record<string, { mimeType: string; encoding: Encoding }> = {
  '.js': { mimeType: 'text/javascript', encoding: 'utf-8' },
  '.py': { mimeType: 'text/x-python', encoding: 'utf-8' },
  '.md': { mimeType: 'text/markdown', encoding: 'utf-8' },
  '.txt': { mimeType: 'text/plain', encoding: 'utf-8' },
  '.html': { mimeType: 'text/html', encoding: 'utf-8' },
  '.css': { mimeType: 'text/css', encoding: 'utf-8' },
  '.json': { mimeType: 'application/json', encoding: 'utf-8' },
  '.csv': { mimeType: 'text/csv', encoding: 'utf-8' },
  '.svg': { mimeType: 'image/svg+xml', encoding: 'utf-8' },
  '.xml': { mimeType: 'application/xml', encoding: 'utf-8' },
  '.yaml': { mimeType: 'text/yaml', encoding: 'utf-8' },
  '.yml': { mimeType: 'text/yaml', encoding: 'utf-8' },
  '.png': { mimeType: 'image/png', encoding: 'base64' },
  '.jpg': { mimeType: 'image/jpeg', encoding: 'base64' },
  '.jpeg': { mimeType: 'image/jpeg', encoding: 'base64' },
  '.pdf': { mimeType: 'application/pdf', encoding: 'base64' },
};

const LANGUAGES: Record<string, ScriptLanguage> = {
  '.js': 'javascript',
  '.ts': 'typescript',
  '.py': 'python',
  '.bat': 'cmd',
  '.cmd': 'cmd',
  '.ps1': 'powershell',
  '.sh': 'shell',
};

/** The MIME type and encoding for an extension; anything unknown is base64 octets. */
export function mimeTypeAndEncoding(ext: string): { mimeType: string; encoding: Encoding } {
  return (Object.hasOwn(MIME_TYPES, ext.toLowerCase()) ? MIME_TYPES[ext.toLowerCase()] : undefined) ?? { mimeType: 'application/octet-stream', encoding: 'base64' };
}

/** The language a script's extension names, or `unspecified`. */
export function scriptLanguage(ext: string): ScriptLanguage {
  return (Object.hasOwn(LANGUAGES, ext.toLowerCase()) ? LANGUAGES[ext.toLowerCase()] : undefined) ?? 'unspecified';
}

/** ADK's guessMimeType, for a binary resource shown to the model. */
export function guessMimeType(filePath: string): string {
  const dot = filePath.lastIndexOf('.');
  const ext = dot < 0 ? filePath.toLowerCase() : filePath.slice(dot + 1).toLowerCase();
  const map: Record<string, string> = {
    pdf: 'application/pdf',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    png: 'image/png',
    gif: 'image/gif',
    csv: 'text/csv',
    json: 'application/json',
    xml: 'application/xml',
    sh: 'text/x-shellscript',
    bash: 'text/x-shellscript',
    py: 'text/x-python',
    js: 'text/javascript',
    cjs: 'text/javascript',
    mjs: 'text/javascript',
    ts: 'text/javascript',
    cts: 'text/javascript',
    mts: 'text/javascript',
  };
  return (Object.hasOwn(map, ext) ? map[ext] : undefined) ?? 'application/octet-stream';
}

/** The wrapper that starts `scriptPath` from the run's directory (ADK's buildWrapperCode). */
export function wrapperCode(scriptPath: string, language: ScriptLanguage): string {
  switch (language) {
    case 'javascript':
      return `require('./${scriptPath}');`;
    case 'typescript':
      return `require('ts-node/register');\nrequire('./${scriptPath}');`;
    case 'python':
      return `import runpy\nrunpy.run_path('./${scriptPath}', run_name='__main__')`;
    case 'shell':
      return `source ./${scriptPath} "$@"`;
    case 'powershell':
      return `& .\\${scriptPath.split('/').join('\\\\')} $args`;
    case 'cmd':
      return `call .\\${scriptPath.split('/').join('\\\\')} %*`;
    default:
      throw new Error(`Unsupported wrapper language: ${language}`);
  }
}

/** Every file a skill ships, as the run stages them (ADK's getSkillResourceFiles). */
export function skillResourceFiles(skill: Skill): ScriptFile[] {
  const files: ScriptFile[] = [];
  for (const kind of ['references', 'assets', 'scripts'] as const) {
    const resources = (skill.resources?.[kind] ?? {}) as Record<string, unknown>;
    for (const name of Object.keys(resources)) {
      const value = resources[name];
      let content: string | Buffer | undefined;
      if (typeof value === 'string' || Buffer.isBuffer(value)) content = value;
      else if (value && typeof value === 'object' && typeof (value as { src?: unknown }).src === 'string') content = (value as { src: string }).src;
      if (content === undefined) continue;
      const { encoding, mimeType } = mimeTypeAndEncoding(path.extname(name));
      files.push({ name: `${kind}/${name}`, content: Buffer.from(content).toString(encoding === 'utf-8' ? 'utf-8' : 'base64'), contentEncoding: encoding, mimeType });
    }
  }
  return files;
}

function isInsideDir(resolved: string, base: string): boolean {
  return resolved === base || resolved.startsWith(base + path.sep);
}

/**
 * Write `files` into `dir` (ADK's materializeFiles): a name that resolves
 * outside `dir` is refused, and a file already there is never overwritten:
 * the new one takes the next free `name_N.ext`. Returns the files with the
 * names they were written under, relative to `dir`.
 */
export async function materializeFiles(files: ScriptFile[], dir: string): Promise<ScriptFile[]> {
  const base = path.resolve(dir);
  const created: ScriptFile[] = [];
  for (const file of files) {
    const fullPath = path.resolve(dir, file.name);
    if (!isInsideDir(fullPath, base)) throw new Error(`Path traversal detected: ${file.name} resolves outside of ${dir}`);
    const ext = path.extname(fullPath);
    const dirName = path.dirname(fullPath);
    const stem = path.basename(fullPath, ext);
    let finalPath = fullPath;
    for (let counter = 2; ; counter++) {
      try {
        await fs.access(finalPath);
      } catch {
        break;
      }
      const renamed = `${stem}_${counter}${ext}`;
      finalPath = path.join(dirName, renamed);
      const originalDir = path.dirname(file.name);
      file.name = originalDir === '.' ? renamed : path.join(originalDir, renamed);
    }
    if (!isInsideDir(finalPath, base)) throw new Error(`Path traversal detected: ${file.name} resolves outside of ${dir}`);
    await fs.mkdir(path.dirname(finalPath), { recursive: true });
    await fs.writeFile(finalPath, Buffer.from(file.content, file.contentEncoding === 'utf-8' ? 'utf-8' : 'base64'), { flag: 'wx' });
    created.push({ ...file, name: path.relative(dir, finalPath) });
  }
  return created;
}

function isPowerShellCommand(commandPath: string): boolean {
  const base = path.win32.basename(commandPath).toLowerCase();
  return base === 'powershell' || base === 'powershell.exe' || base === 'pwsh' || base === 'pwsh.exe';
}

function extensionFor(language: ScriptLanguage, shellCommandPath: string): string | undefined {
  switch (language) {
    case 'javascript':
      return '.js';
    case 'python':
      return '.py';
    case 'powershell':
      return '.ps1';
    case 'cmd':
      return '.bat';
    case 'shell':
      if (isPowerShellCommand(shellCommandPath)) return '.ps1';
      if (IS_WINDOWS) return shellCommandPath.toLowerCase().includes('cmd') ? '.bat' : '.ps1';
      return '.sh';
    default:
      return undefined;
  }
}

/** Where and how long a run may go. */
export interface LocalScriptExecutorOptions {
  timeoutSeconds?: number;
  /** The Node binary for JavaScript. Default: this process's. */
  nodeCommandPath?: string;
  pythonCommandPath?: string;
  shellCommandPath?: string;
  /** Variable names passed to a script beyond the base allowlist (the YAML's `skills.env` and `skills.secret_env`). */
  envNames?: readonly string[];
  /** Where variable values are read from. Default: process.env. */
  sourceEnv?: NodeJS.ProcessEnv;
  /** Characters of stdout, and of stderr, kept per run. Default SCRIPT_OUTPUT_CHAR_LIMIT. */
  maxOutputChars?: number;
}

/** What one run is handed: the wrapper code, the files to stage, the language and the model's arguments. */
export interface ScriptRunInput {
  code: string;
  inputFiles?: ScriptFile[];
  language: ScriptLanguage;
  args?: Record<string, unknown> | unknown[];
}

const RUNNABLE: ReadonlySet<ScriptLanguage> = new Set(['javascript', 'python', 'shell', 'cmd', 'powershell']);

/** Runs a script on this machine, unsandboxed, as described above. */
export class LocalScriptExecutor {
  readonly timeoutSeconds: number;
  readonly nodeCommandPath: string;
  readonly pythonCommandPath: string;
  readonly shellCommandPath: string;
  readonly envNames: readonly string[];
  readonly maxOutputChars: number;
  readonly #sourceEnv?: NodeJS.ProcessEnv;

  constructor(options: LocalScriptExecutorOptions = {}) {
    this.timeoutSeconds = options.timeoutSeconds ?? 30;
    this.nodeCommandPath = options.nodeCommandPath ?? process.execPath;
    this.pythonCommandPath = options.pythonCommandPath ?? (IS_WINDOWS ? 'python' : 'python3');
    this.shellCommandPath = options.shellCommandPath ?? (IS_WINDOWS ? 'powershell' : 'bash');
    this.envNames = [...(options.envNames ?? [])];
    this.maxOutputChars = options.maxOutputChars ?? SCRIPT_OUTPUT_CHAR_LIMIT;
    this.#sourceEnv = options.sourceEnv;
  }

  async run(input: ScriptRunInput): Promise<ScriptRunResult> {
    const { code, language } = input;
    if (!RUNNABLE.has(language)) return { stdout: '', stderr: `Unsupported language: ${language}`, outputFiles: [] };
    let tempDir: string | undefined;
    try {
      tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'melchizedek_skill_script_'));
      const filePath = path.join(tempDir, `script${extensionFor(language, this.shellCommandPath) ?? '.js'}`);
      await fs.writeFile(filePath, code);
      if (input.inputFiles) await materializeFiles(input.inputFiles, tempDir);

      let command = this.nodeCommandPath;
      let args = [filePath];
      if (language === 'python') command = this.pythonCommandPath;
      else if (language === 'shell') {
        command = this.shellCommandPath;
        if (isPowerShellCommand(this.shellCommandPath)) args = [...POWERSHELL_BASE_ARGS, filePath];
        else if (this.shellCommandPath.toLowerCase().includes('cmd')) args = [...CMD_BASE_ARGS, filePath];
      } else if (language === 'powershell') {
        command = IS_WINDOWS ? 'powershell' : 'pwsh';
        args = [...POWERSHELL_BASE_ARGS, filePath];
      } else if (language === 'cmd') {
        command = 'cmd.exe';
        args = [...CMD_BASE_ARGS, filePath];
      }
      if (input.args) {
        if (Array.isArray(input.args)) args.push(...input.args.map(String));
        else for (const [k, v] of Object.entries(input.args)) args.push(`--${k}`, String(v));
      }

      const cwd = tempDir;
      const env = scriptEnvironment(this.envNames, this.#sourceEnv ?? process.env);
      const outcome = await new Promise<{ stdout: string; stderr: string }>((resolve) => {
        const child = spawn(command, args, { cwd, env });
        const stdout = new CappedText(this.maxOutputChars);
        const stderr = new CappedText(this.maxOutputChars);
        let processError = '';
        let timedOut = false;
        const timer = setTimeout(() => {
          timedOut = true;
          child.kill('SIGKILL');
          child.stdout?.destroy();
          child.stderr?.destroy();
        }, this.timeoutSeconds * 1000);
        // Decoded as UTF-8 across chunk boundaries; past the cap a chunk is counted, not kept.
        child.stdout?.setEncoding('utf8');
        child.stderr?.setEncoding('utf8');
        child.stdout?.on('data', (data: string) => stdout.push(data));
        child.stderr?.on('data', (data: string) => stderr.push(data));
        child.on('error', (err) => {
          processError += `Process error: ${err.message}\n`;
        });
        child.on('close', (exitCode, signal) => {
          clearTimeout(timer);
          // The engine's own lines follow the capped text, so the model always sees them.
          let err = stderr.text('stderr') + processError;
          if (timedOut || signal === 'SIGKILL' || signal === 'SIGTERM') err += `\nCode execution timed out after ${this.timeoutSeconds} seconds.`;
          else if (exitCode !== 0 && exitCode !== null && !err) err = `Exit code ${exitCode}`;
          resolve({ stdout: stdout.text('stdout'), stderr: err });
        });
      });

      const outputFiles: ScriptFile[] = [];
      try {
        const staged = new Set((input.inputFiles ?? []).map((f) => f.name));
        for (const relativePath of await fs.readdir(cwd, { recursive: true })) {
          const fullPath = path.join(cwd, relativePath);
          if (relativePath === path.basename(filePath) || staged.has(relativePath)) continue;
          // One open handle (no symlink followed): the file checked is the file read.
          const content = await readFileBounded(fullPath, SKILL_LIMITS.resourceBytes).catch(() => undefined);
          if (!content) continue;
          const { mimeType, encoding } = mimeTypeAndEncoding(path.extname(relativePath));
          outputFiles.push({ name: relativePath, content: content.toString(encoding === 'utf-8' ? 'utf-8' : 'base64'), contentEncoding: encoding, mimeType });
        }
      } catch {
        // A directory that cannot be listed yields no output files, as in ADK.
      }
      return { stdout: outcome.stdout, stderr: outcome.stderr, outputFiles };
    } finally {
      if (tempDir) await fs.rm(tempDir, { recursive: true, force: true });
    }
  }
}
