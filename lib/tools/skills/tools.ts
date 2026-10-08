/**
 * lib/tools/skills/tools.ts — the skill tools and the toolset that holds
 * them, on the engine's own tool base (lib/tools/tool.ts; WS3-3, ADR 0083).
 *
 * WHY this file exists:
 *   The skills harness (ADR 0029) was built on ADK's SkillToolset until
 *   WS3-3. These are the same tools as own Tools, and the native loop runs
 *   them directly. A model is sent the same names, descriptions and
 *   parameters as before, and reads the same results and error texts:
 *   - list_skills: the `<available_skills>` index (ADK's ListSkillsTool).
 *     The harness leaves it out, since the index is in the instruction.
 *   - load_skill: the procedure, the frontmatter and the NAMES of the files
 *     the skill ships (ADR 0029's lean load), and it activates the skill.
 *   - load_skill_resource: one of those files (ADK's tool, word for word).
 *     A binary file is shown to the model as inline data in the next
 *     request, through the Tool's `contents` hook, as ADK's tool did in its
 *     processLlmRequest.
 *   - run_skill_script: asks a person to approve, then runs one script the
 *     skill ships on the local executor (./executor.ts).
 *
 * ACTIVATION: load_skill appends the skill's name to the session state key
 *   `_adk_activated_skill_<agent>` (ADK's key, so a session ADK stored
 *   reads the same). SkillToolset.getTools reads it and adds
 *   the tools the activated skills name (`metadata.adk_additional_tools`,
 *   filled from `allowed-tools`), but only from the tools the YAML handed
 *   it under `skills.tools`: a skill cannot grant itself a tool the YAML
 *   withheld.
 *
 * WHY NOT defineTool: a defineTool contract validates its arguments with
 *   zod and answers a bad call with its own error string. These tools keep
 *   ADK's answers to a bad call (`{ error, error_code }`), so their
 *   parameters are written here as JSON Schema and their arguments checked
 *   in execute.
 *
 * UNTRUSTED INPUT: every argument is the model's. A skill name and a file
 *   path are looked up as own keys of the loaded maps (never on a
 *   prototype), so nothing a model sends opens a file the skill did not
 *   ship or names a script outside its `scripts/`.
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import type { ToolDeclaration } from '../../models/contract.ts';
import type { TurnContent } from '../../runtime/events.ts';
import type { Tool, ToolContext, Toolset, ToolsetContext } from '../tool.ts';
import { LocalScriptExecutor, guessMimeType, materializeFiles, scriptLanguage, skillResourceFiles, wrapperCode } from './executor.ts';
import type { Skill } from './loader.ts';

// ── The index ────────────────────────────────────────────────────────────────

/** ADK's escapeHtml, as list_skills writes the index. */
function escapeHtml(unsafe: string): string {
  return unsafe.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#039;');
}

/** The `<available_skills>` index, in the skills' order (ADK's formatSkillsAsXml). */
export function formatSkillsAsXml(skills: Skill[]): string {
  if (skills.length === 0) return '<available_skills>\n</available_skills>';
  const lines = ['<available_skills>'];
  for (const skill of skills) {
    lines.push('  <skill>');
    lines.push(`    <name>${escapeHtml(skill.frontmatter.name)}</name>`);
    lines.push(`    <description>${escapeHtml(skill.frontmatter.description)}</description>`);
    lines.push('  </skill>');
  }
  lines.push('</available_skills>');
  return lines.join('\n');
}

// ── The toolset ──────────────────────────────────────────────────────────────

/** The session state key holding the skills an agent has loaded (ADK's). */
export function activatedSkillsKey(agentName: string | undefined): string {
  return `_adk_activated_skill_${agentName}`;
}

/** The names of the tools a SkillToolset holds itself; an unlocked tool never shadows one. */
const OWN_TOOL_NAMES: ReadonlySet<string> = new Set([
  'list_skills',
  'load_skill',
  'load_skill_resource',
  'run_skill_script',
  'run_skill_inline_script',
  'search_skills',
]);

/** Seconds a skill script may run before the local executor kills it. */
export const SCRIPT_TIMEOUT_SECONDS = 120;

export interface SkillToolsetOptions {
  /** `local` runs a skill's scripts on this machine, each after approval; otherwise run_skill_script is absent. */
  scripts?: 'none' | 'local';
  /** The tools a loaded skill may unlock by name (the YAML's `skills.tools`, resolved). */
  additionalTools?: readonly unknown[];
  /** Variable names a script gets beyond the base allowlist (the YAML's `skills.env` and `skills.secret_env`; ADR 0086). */
  envNames?: readonly string[];
  /** The executor for `scripts: local`. Default: the local executor with SCRIPT_TIMEOUT_SECONDS and `envNames`. */
  executor?: LocalScriptExecutor;
  /** Where script output files are copied. Default: a private temp directory, made once. */
  scriptOutputDir?: string;
}

function nameOf(tool: unknown): string | undefined {
  const name = (tool as { name?: unknown } | null)?.name;
  return typeof name === 'string' ? name : undefined;
}

function isToolsetShaped(value: unknown): value is { getTools(ctx?: unknown): Promise<unknown[]> } {
  return !!value && typeof value === 'object' && typeof (value as { getTools?: unknown }).getTools === 'function' && typeof (value as { execute?: unknown }).execute !== 'function' && !('runAsync' in value);
}

/**
 * The tools an agent with `skills:` carries: load_skill and
 * load_skill_resource always, run_skill_script with `scripts: local`, and
 * the tools its loaded skills unlock. A toolset by shape (getTools), which
 * the native loop expands.
 */
export class SkillToolset implements Toolset {
  readonly name = 'skill_toolset';
  readonly skills: Readonly<Record<string, Skill>>;
  readonly executor?: LocalScriptExecutor;
  readonly #tools: Tool[];
  readonly #additionalTools: readonly unknown[];
  readonly #scriptOutputDir?: string;
  #tempOutputDir?: Promise<string>;

  constructor(skills: Record<string, Skill>, options: SkillToolsetOptions = {}) {
    this.skills = skills;
    this.#additionalTools = options.additionalTools ?? [];
    this.#scriptOutputDir = options.scriptOutputDir;
    if (options.scripts === 'local') this.executor = options.executor ?? new LocalScriptExecutor({ timeoutSeconds: SCRIPT_TIMEOUT_SECONDS, envNames: options.envNames });
    this.#tools = [new LoadSkillTool(this), new LoadSkillResourceTool(this)];
    if (this.executor) this.#tools.push(new RunSkillScriptTool(this));
  }

  /** The skill named `name`, or undefined. Only the toolset's own skills, never a prototype key. */
  getSkill(name: string): Skill | undefined {
    return Object.hasOwn(this.skills, name) ? this.skills[name] : undefined;
  }

  /** The harness tools, then the tools the agent's loaded skills unlock. */
  async getTools(context?: ToolsetContext): Promise<unknown[]> {
    return [...this.#tools, ...(await this.#unlocked(context))];
  }

  /** ADK's resolveAdditionalTools: the permitted tools the activated skills name, in the order they name them. */
  async #unlocked(context?: ToolsetContext): Promise<unknown[]> {
    if (!context) return [];
    const activated = context.state.get(activatedSkillsKey(context.agentName));
    if (!Array.isArray(activated) || activated.length === 0) return [];
    const wanted = new Set<string>();
    for (const skillName of activated) {
      const extra = typeof skillName === 'string' ? this.getSkill(skillName)?.frontmatter.metadata?.adk_additional_tools : undefined;
      if (Array.isArray(extra)) for (const t of extra) if (typeof t === 'string') wanted.add(t);
    }
    if (wanted.size === 0) return [];
    const candidates = new Map<string, unknown>();
    for (const union of this.#additionalTools) {
      const listed = isToolsetShaped(union) ? await union.getTools(context) : [union];
      for (const tool of listed) {
        const name = nameOf(tool);
        if (name === undefined) continue;
        if (candidates.has(name)) throw new Error(`Duplicate tool name: ${name}`);
        candidates.set(name, tool);
      }
    }
    const out: unknown[] = [];
    const taken = new Set(OWN_TOOL_NAMES);
    for (const name of wanted) {
      const tool = candidates.get(name);
      if (tool !== undefined && !taken.has(name)) {
        out.push(tool);
        taken.add(name);
      }
    }
    return out;
  }

  /**
   * Where a script's output files are copied: the configured directory, or
   * a private temp directory made once per toolset. Output file names are
   * the script's choice, so they are never resolved against the server's
   * working directory.
   */
  scriptOutputDir(): Promise<string> {
    if (this.#scriptOutputDir) {
      const dir = path.resolve(this.#scriptOutputDir);
      return fs.mkdir(dir, { recursive: true }).then(() => dir);
    }
    return (this.#tempOutputDir ??= fs.mkdtemp(path.join(os.tmpdir(), 'melchizedek_skill_output_')));
  }
}

// ── The tools ────────────────────────────────────────────────────────────────

abstract class SkillTool implements Tool {
  abstract readonly name: string;
  abstract readonly description: string;
  protected abstract readonly parameters: Record<string, unknown>;
  protected readonly toolset: SkillToolset;

  constructor(toolset: SkillToolset) {
    this.toolset = toolset;
  }

  declaration(): ToolDeclaration {
    return { name: this.name, description: this.description, parameters: structuredClone(this.parameters) as ToolDeclaration['parameters'] };
  }

  abstract execute(args: Record<string, unknown>, ctx: ToolContext): Promise<unknown>;
}

/** The arguments' string value, or undefined when absent or empty (ADK's `if (!x)`). */
function stringArg(args: Record<string, unknown>, key: string): unknown {
  return Object.hasOwn(args, key) ? args[key] : undefined;
}

/** list_skills: the index of every installed skill. The harness does not carry it (ADR 0029). */
export class ListSkillsTool extends SkillTool {
  readonly name = 'list_skills';
  readonly description = 'Lists all available skills with their names and descriptions.';
  protected readonly parameters = { type: 'object', properties: {} };

  async execute(): Promise<unknown> {
    return formatSkillsAsXml(Object.values(this.toolset.skills));
  }
}

/**
 * load_skill, lean (ADR 0029): the procedure, the frontmatter and the names
 * of the files the skill ships, never their contents. Loading activates the
 * skill, which unlocks its permitted `allowed-tools` on the next request.
 */
export class LoadSkillTool extends SkillTool {
  readonly name = 'load_skill';
  readonly description =
    'Read one installed skill in full: its SKILL.md procedure, its frontmatter, and the names of the files it ships. Read a skill before you follow it.';
  protected readonly parameters = {
    type: 'object',
    properties: { name: { type: 'string', description: "The skill's name, exactly as the index lists it." } },
    required: ['name'],
  };

  async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<unknown> {
    const raw = stringArg(args, 'name');
    const name = typeof raw === 'string' ? raw.trim() : '';
    if (!name) return { error: 'Skill name is required.', error_code: 'MISSING_SKILL_NAME' };
    const skill = this.toolset.getSkill(name);
    if (!skill) {
      return { error: `Skill '${name}' not found. Installed: ${Object.keys(this.toolset.skills).sort().join(', ') || '(none)'}.`, error_code: 'SKILL_NOT_FOUND' };
    }
    const key = activatedSkillsKey(ctx.agentName);
    const current = ctx.state.get<unknown>(key);
    const activated = Array.isArray(current) ? (current as string[]) : [];
    if (!activated.includes(name)) ctx.state.set(key, [...activated, name]);
    return { skill_name: name, frontmatter: skill.frontmatter, instructions: skill.instructions, files: resourceNames(skill) };
  }
}

function resourceNames(skill: Skill): string[] {
  const out: string[] = [];
  for (const [dir, files] of Object.entries(skill.resources ?? {})) {
    for (const name of Object.keys(files ?? {})) out.push(`${dir}/${name}`);
  }
  return out.sort();
}

const BINARY_FILE_DETECTED_MSG =
  'Binary file detected. The content has been injected into the conversation history for you to analyze.';

const RESOURCE_KINDS = ['references/', 'assets/', 'scripts/'] as const;

/** The file at `resourcePath` in `skill`: its content, or undefined. Own keys only. */
function resourceAt(skill: Skill, resourcePath: string, kinds: readonly string[] = RESOURCE_KINDS): string | Buffer | undefined {
  const resources = skill.resources ?? ({} as Skill['resources']);
  for (const prefix of kinds) {
    if (!resourcePath.startsWith(prefix)) continue;
    const key = resourcePath.slice(prefix.length);
    if (prefix === 'scripts/') {
      const scripts = resources.scripts ?? {};
      return Object.hasOwn(scripts, key) ? scripts[key]?.src : undefined;
    }
    const files = (prefix === 'references/' ? resources.references : resources.assets) ?? {};
    return Object.hasOwn(files, key) ? files[key] : undefined;
  }
  return undefined;
}

/** load_skill_resource: one file a skill ships, by its path (ADK's tool). */
export class LoadSkillResourceTool extends SkillTool {
  readonly name = 'load_skill_resource';
  readonly description = 'Loads a resource file (from references/, assets/, or scripts/) from within a skill.';
  protected readonly parameters = {
    type: 'object',
    properties: {
      skill_name: { type: 'string', description: 'The name of the skill.' },
      path: {
        type: 'string',
        description: "The relative path to the resource (e.g., 'references/my_doc.md', 'assets/template.txt', or 'scripts/setup.sh').",
      },
    },
    required: ['skill_name', 'path'],
  };

  async execute(args: Record<string, unknown>): Promise<unknown> {
    const skillName = stringArg(args, 'skill_name');
    const rawPath = stringArg(args, 'path');
    if (!skillName) return { error: 'Skill name is required.', error_code: 'MISSING_SKILL_NAME' };
    if (!rawPath) return { error: 'Resource path is required.', error_code: 'MISSING_RESOURCE_PATH' };
    const resourcePath = path.posix.normalize(String(rawPath));
    const skill = this.toolset.getSkill(String(skillName));
    if (!skill) return { error: `Skill '${String(skillName)}' not found.`, error_code: 'SKILL_NOT_FOUND' };
    if (!RESOURCE_KINDS.some((prefix) => resourcePath.startsWith(prefix))) {
      return { error: "Path must start with 'references/', 'assets/', or 'scripts/'.", error_code: 'INVALID_RESOURCE_PATH' };
    }
    const content = resourceAt(skill, resourcePath);
    if (content === undefined) return { error: `Resource '${resourcePath}' not found in skill '${String(skillName)}'.`, error_code: 'RESOURCE_NOT_FOUND' };
    if (Buffer.isBuffer(content)) return { skill_name: skillName, path: resourcePath, status: BINARY_FILE_DETECTED_MSG };
    return { skill_name: skillName, path: resourcePath, content };
  }

  /**
   * A binary file this tool just answered for is added to the request as
   * inline data, after the history (ADK's processLlmRequest): the latest
   * content, when it is the tools' answer, is searched for this tool's
   * binary notices.
   */
  async contents(contents: TurnContent[]): Promise<void> {
    const last = contents.at(-1);
    if (!last || last.role !== 'user' || !last.parts) return;
    for (const part of last.parts) {
      const fr = part.functionResponse;
      if (!fr || fr.name !== this.name) continue;
      const response = (fr.response ?? {}) as Record<string, unknown>;
      if (response.status !== BINARY_FILE_DETECTED_MSG) continue;
      const skill = typeof response.skill_name === 'string' ? this.toolset.getSkill(response.skill_name) : undefined;
      const resourcePath = typeof response.path === 'string' ? response.path : undefined;
      if (!skill || resourcePath === undefined) continue;
      const content = resourceAt(skill, resourcePath, ['references/', 'assets/']);
      if (!Buffer.isBuffer(content)) continue;
      contents.push({
        role: 'user',
        parts: [{ text: `The content of binary file '${resourcePath}' is:` }, { inlineData: { data: content.toString('base64'), mimeType: guessMimeType(resourcePath) } }],
      });
    }
  }
}

/**
 * run_skill_script behind a person's approval: the first call asks for it
 * (the hint names the skill, the script and the arguments) and returns
 * without running; the call made again with the answer runs only when the
 * answer approved it. The confirmation travels as `adk_request_confirmation`,
 * so the turn pauses `input-required` exactly as for
 * `require_approval` (ADR 0028), with this tool's own texts.
 */
export class RunSkillScriptTool extends SkillTool {
  readonly name = 'run_skill_script';
  readonly description = "Executes a script from a skill's scripts/ directory.";
  protected readonly parameters = {
    type: 'object',
    properties: {
      skill_name: { type: 'string', description: 'The name of the skill.' },
      script_path: { type: 'string', description: "The relative path to the script (e.g., 'scripts/setup.js')." },
      args: { type: 'object', description: 'Optional arguments to pass to the script as key-value pairs.' },
    },
    required: ['skill_name', 'script_path'],
  };

  async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<unknown> {
    if (!ctx.confirmation) {
      const summary = `${String(args.skill_name ?? '?')}: ${String(args.script_path ?? '?')}${args.args ? ` ${JSON.stringify(args.args)}` : ''}`;
      ctx.requestConfirmation({
        hint: `Approval is required before a skill script runs on this machine. The agent asks to run ${summary}.`,
        payload: { skill_name: args.skill_name, script_path: args.script_path, args: args.args ?? {} },
      });
      ctx.actions.skipSummarization = true;
      return { error: 'This script run requires approval, please approve or reject.' };
    }
    if (!ctx.confirmation.confirmed) return { error: 'This script run was rejected.' };
    return this.#run(args);
  }

  /** The script run, after the gate, as ADK's RunSkillScriptTool ran it. */
  async #run(args: Record<string, unknown>): Promise<unknown> {
    const skillName = stringArg(args, 'skill_name');
    const scriptPath = stringArg(args, 'script_path');
    const scriptArgs = (stringArg(args, 'args') || {}) as Record<string, unknown> | unknown[];
    if (!skillName) return { error: 'Skill name is required.', errorCode: 'MISSING_SKILL_NAME' };
    if (!scriptPath) return { error: 'Script path is required.', errorCode: 'MISSING_SCRIPT_PATH' };
    const skill = this.toolset.getSkill(String(skillName));
    if (!skill) return { error: `Skill '${String(skillName)}' not found.`, errorCode: 'SKILL_NOT_FOUND' };
    const scriptPathText = String(scriptPath);
    const scripts = skill.resources?.scripts ?? {};
    const relative = scriptPathText.startsWith('scripts/') ? scriptPathText.slice('scripts/'.length) : scriptPathText;
    const script = Object.hasOwn(scripts, relative) ? scripts[relative] : Object.hasOwn(scripts, scriptPathText) ? scripts[scriptPathText] : undefined;
    if (!script) return { error: `Script '${scriptPathText}' not found in skill '${String(skillName)}'.`, errorCode: 'SCRIPT_NOT_FOUND' };
    const executor = this.toolset.executor;
    if (!executor) return { error: 'No code executor configured.', errorCode: 'NO_CODE_EXECUTOR' };
    try {
      const language = scriptLanguage(path.extname(scriptPathText));
      const result = await executor.run({ code: wrapperCode(scriptPathText, language), inputFiles: skillResourceFiles(skill), language, args: scriptArgs });
      const outputDirectory = await this.toolset.scriptOutputDir();
      result.outputFiles = await materializeFiles(result.outputFiles, outputDirectory);
      return { ...result, outputDirectory };
    } catch (e) {
      return { error: `Failed to execute script '${scriptPathText}': ${(e as Error).message}`, errorCode: 'EXECUTION_ERROR' };
    }
  }
}
