/**
 * lib/tools/skillToolset.ts — Agent Skills for a syndicate agent, the way a
 * coding harness holds them.
 *
 * WHY this file exists:
 *   A coding harness (Claude Code, Codex, Gemini CLI) keeps every installed
 *   skill's frontmatter in its system prompt, reads a SKILL.md in full only
 *   when a request matches its description, opens the files a skill ships
 *   only when the procedure reaches them, and runs the scripts a skill
 *   ships. ADK 2.2 carries the mechanism (`SkillToolset`, `loadAllSkillsInDir`,
 *   the open SKILL.md standard's layout: SKILL.md + references/, assets/,
 *   scripts/). Three things it does not do, this file does:
 *
 *   1. INJECT THE INDEX. ADK's TypeScript port never calls the toolset's own
 *      request hook, so `<available_skills>` would reach the model only
 *      through a `list_skills` call. `skillsInstruction()` renders the index
 *      once at compile time and lib/compile.ts appends it to the agent's
 *      instruction: no round trip, always in view.
 *   2. KEEP DISCLOSURE PROGRESSIVE. ADK's `load_skill` returns every
 *      resource's full content with the instructions. `LeanLoadSkillTool`
 *      returns the instructions and the resources' NAMES; `load_skill_resource`
 *      reads one when the procedure asks.
 *   3. GATE EVERY SCRIPT RUN. ADK's `run_skill_script` runs when called.
 *      `GatedRunSkillScriptTool` asks for a person's approval first through
 *      the same confirmation interrupt `require_approval` uses (ADR 0028),
 *      so the turn pauses `input-required` and resumes on approve or reject.
 *
 *   `allowed-tools` in a skill's frontmatter is honoured through ADK's
 *   activation mechanism: once the skill is loaded, the tools it names
 *   become callable, provided the agent's YAML listed them under
 *   `skills.tools`. Exposure stays two deliberate acts (the skill names the
 *   tool, the YAML permits it); a skill cannot grant itself a tool the YAML
 *   withheld.
 *
 * WHAT RUNS: only scripts shipped in a skill's `scripts/` directory, through
 *   ADK's local executor (`skills.scripts: local`), after approval. The
 *   model's own code never executes: the executor is handed to the toolset,
 *   never to the agent, so ADK's code-block execution stays off. ADK's
 *   container executor cannot stage a skill's files yet, so it is not offered.
 *
 * FAILURE CONTRACT: a missing skills directory fails the compile (an agent
 *   running without the skills it was declared with would be a silent
 *   defect). Inside a turn, the ADK tools return `{ error }` objects the
 *   model can read, never throw.
 */

import { readdirSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { Type } from '@google/genai';
import type { FunctionDeclaration } from '@google/genai';
import {
  BaseTool,
  LoadSkillResourceTool,
  RunSkillScriptTool,
  SkillToolset,
  UnsafeLocalCodeExecutor,
  loadAllSkillsInDir,
  validateSkillDir,
} from '@google/adk';
import type { BaseCodeExecutor, Context, ReadonlyContext, RunAsyncToolRequest } from '@google/adk';

/** What an agent's YAML `skills:` block may say. */
export interface SkillsConfig {
  /** A directory of skills, one subdirectory each holding a SKILL.md. Relative to the working directory. */
  dir: string;
  /** Whether a skill's `scripts/` may run. `local` runs them on this host, each after a person approves. */
  scripts?: 'none' | 'local';
  /** Registry tool names a skill may unlock through its `allowed-tools` frontmatter, once loaded. */
  tools?: string[];
}

/** ADK's Skill, as this module reads it (the type is not exported from the package index). */
export interface LoadedSkill {
  frontmatter: {
    name: string;
    description: string;
    allowedTools?: string;
    metadata?: Record<string, unknown>;
    [key: string]: unknown;
  };
  instructions: string;
  resources?: {
    references?: Record<string, unknown>;
    assets?: Record<string, unknown>;
    scripts?: Record<string, unknown>;
  };
}

/** Seconds a skill script may run before the local executor kills it. */
export const SCRIPT_TIMEOUT_SECONDS = 120;

/**
 * Load every skill under `dir` (ADK's loader: a skill is a directory whose
 * name equals its frontmatter `name`, holding a SKILL.md with a description;
 * an invalid skill is skipped with ADK's warning). A directory that does
 * not exist is an error: the YAML declared skills this agent cannot have.
 */
export async function loadSkillSuite(dir: string): Promise<Record<string, LoadedSkill>> {
  const abs = resolve(dir);
  let real: string;
  try {
    real = realpathSync(abs);
    readdirSync(real);
  } catch {
    throw new Error(`skills: directory not found or unreadable: ${dir}`);
  }
  const skills = (await loadAllSkillsInDir(real)) as Record<string, LoadedSkill>;
  for (const skill of Object.values(skills)) honourAllowedTools(skill);
  return skills;
}

/**
 * Why a skill directory under `dir` was NOT loaded: ADK skips an invalid
 * skill with a log line the operator may never see, so the compiler reports
 * each one. A candidate is a subdirectory holding a SKILL.md.
 */
export async function skillSuiteProblems(dir: string): Promise<string[]> {
  const real = realpathSync(resolve(dir));
  const out: string[] = [];
  for (const entry of readdirSync(real, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const skillDir = resolve(real, entry.name);
    if (!readdirSync(skillDir).some((f) => f.toLowerCase() === 'skill.md')) continue;
    for (const problem of await validateSkillDir(skillDir)) out.push(`${entry.name}: ${problem.split('\n')[0]}`);
  }
  return out;
}

/**
 * The open standard's `allowed-tools` (a space- or comma-separated list of
 * tool names) becomes ADK's `metadata.adk_additional_tools`, which is what
 * the toolset reads when the skill is loaded. A skill that already set the
 * ADK field keeps it.
 */
function honourAllowedTools(skill: LoadedSkill): void {
  const fm = skill.frontmatter;
  const declared = typeof fm.allowedTools === 'string' ? fm.allowedTools : typeof fm['allowed-tools'] === 'string' ? (fm['allowed-tools'] as string) : '';
  const names = declared.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean);
  if (names.length === 0) return;
  fm.metadata = { ...(fm.metadata ?? {}) };
  if (!Array.isArray(fm.metadata.adk_additional_tools)) fm.metadata.adk_additional_tools = names;
}

function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * The block lib/compile.ts appends to an agent's instruction: the frontmatter
 * index every request sees, and the names of the tools that read and run a
 * skill. The ORDER of use (read before following, cite, when to run a
 * script) is the YAML instruction's to state; this block only says what
 * exists.
 */
export function skillsInstruction(skills: Record<string, LoadedSkill>, config: SkillsConfig): string {
  const entries = Object.values(skills).sort((a, b) => a.frontmatter.name.localeCompare(b.frontmatter.name));
  const index =
    entries.length === 0
      ? '<available_skills>\n</available_skills>'
      : [
          '<available_skills>',
          ...entries.flatMap((s) => [
            '  <skill>',
            `    <name>${escapeXml(s.frontmatter.name)}</name>`,
            `    <description>${escapeXml(s.frontmatter.description.trim())}</description>`,
            '  </skill>',
          ]),
          '</available_skills>',
        ].join('\n');
  const scripts = config.scripts === 'local';
  const lines = [
    'Skills are installed procedures, one directory each: a SKILL.md with the procedure, and optionally references/, assets/ and scripts/. The index below lists every installed skill by name and description; it is complete, so never call a tool to list skills.',
    'load_skill(name) returns a skill\'s full SKILL.md and the names of the files it ships. load_skill_resource(skill_name, path) returns one of those files ("references/x.md", "assets/x.yaml", "scripts/x.sh").',
    scripts
      ? 'run_skill_script(skill_name, script_path, args) runs a script from a skill\'s scripts/ directory on this machine. Every run waits for the user\'s approval before it executes; when a run is refused, say so and do not retry it.'
      : 'Scripts in a skill\'s scripts/ directory cannot run here; when a procedure says to run one, give the user the exact command instead.',
    index,
  ];
  return lines.join('\n\n');
}

function resourceNames(skill: LoadedSkill): string[] {
  const out: string[] = [];
  for (const [dir, files] of Object.entries(skill.resources ?? {})) {
    for (const name of Object.keys(files ?? {})) out.push(`${dir}/${name}`);
  }
  return out.sort();
}

/**
 * ADK's `load_skill`, minus the resource dump: the procedure in full, the
 * frontmatter, and the names of the files the skill ships. Loading also
 * activates the skill for the agent (ADK's state key), which is what unlocks
 * its `allowed-tools`.
 */
export class LeanLoadSkillTool extends BaseTool {
  private readonly toolset: SkillToolset;

  constructor(toolset: SkillToolset) {
    super({
      name: 'load_skill',
      description:
        'Read one installed skill in full: its SKILL.md procedure, its frontmatter, and the names of the files it ships. Read a skill before you follow it.',
    });
    this.toolset = toolset;
  }

  override _getDeclaration(): FunctionDeclaration {
    return {
      name: this.name,
      description: this.description,
      parameters: {
        type: Type.OBJECT,
        properties: { name: { type: Type.STRING, description: 'The skill\'s name, exactly as the index lists it.' } },
        required: ['name'],
      },
    };
  }

  async runAsync({ args, toolContext }: RunAsyncToolRequest): Promise<unknown> {
    const name = typeof args.name === 'string' ? args.name.trim() : '';
    if (!name) return { error: 'Skill name is required.', error_code: 'MISSING_SKILL_NAME' };
    const skill = this.toolset.getSkill(name) as LoadedSkill | undefined;
    if (!skill) {
      return { error: `Skill '${name}' not found. Installed: ${Object.keys(this.toolset.skills).sort().join(', ') || '(none)'}.`, error_code: 'SKILL_NOT_FOUND' };
    }
    // The same state key ADK's own load_skill sets: SkillToolset reads it to
    // resolve the skill's additional tools on the next request.
    const agentName = (toolContext.invocationContext as { agent?: { name?: string } }).agent?.name ?? toolContext.agentName;
    const stateKey = `_adk_activated_skill_${agentName}`;
    const activated = (toolContext.state.get(stateKey) as string[] | undefined) ?? [];
    if (!activated.includes(name)) toolContext.state.set(stateKey, [...activated, name]);
    return { skill_name: name, frontmatter: skill.frontmatter, instructions: skill.instructions, files: resourceNames(skill) };
  }
}

/**
 * ADK's `run_skill_script` behind a person's approval: the first call raises
 * the confirmation interrupt (the hint names the skill, the script and the
 * arguments) and returns without running; the resumed call runs only when
 * the answer confirmed it. Mirrors FunctionTool's own gate, so the turn
 * runner and the A2A server treat it exactly as `require_approval` (ADR 0028).
 */
export class GatedRunSkillScriptTool extends RunSkillScriptTool {
  override async runAsync(request: RunAsyncToolRequest): Promise<unknown> {
    const { args, toolContext } = request;
    const ctx = toolContext as Context & { actions: { skipSummarization?: boolean } };
    if (!ctx.toolConfirmation) {
      const summary = `${String(args.skill_name ?? '?')}: ${String(args.script_path ?? '?')}${args.args ? ` ${JSON.stringify(args.args)}` : ''}`;
      ctx.requestConfirmation({
        hint: `Approval is required before a skill script runs on this machine. The agent asks to run ${summary}.`,
        payload: { skill_name: args.skill_name, script_path: args.script_path, args: args.args ?? {} },
      });
      ctx.actions.skipSummarization = true;
      return { error: 'This script run requires approval, please approve or reject.' };
    }
    if (!ctx.toolConfirmation.confirmed) return { error: 'This script run was rejected.' };
    return super.runAsync(request);
  }
}

/**
 * The toolset an agent with `skills:` carries. `list_skills` is left out
 * (the index is in the instruction); `load_skill` is the lean one;
 * `run_skill_script` is present, gated, only when scripts may run.
 */
export class HarnessSkillToolset extends SkillToolset {
  private readonly harnessTools: BaseTool[];

  constructor(skills: Record<string, LoadedSkill>, config: SkillsConfig, additionalTools: unknown[] = []) {
    const codeExecutor: BaseCodeExecutor | undefined =
      config.scripts === 'local' ? new UnsafeLocalCodeExecutor({ timeoutSeconds: SCRIPT_TIMEOUT_SECONDS }) : undefined;
    super(skills as any, { codeExecutor, additionalTools: additionalTools as any });
    this.harnessTools = [new LeanLoadSkillTool(this), new LoadSkillResourceTool(this)];
    if (codeExecutor) this.harnessTools.push(new GatedRunSkillScriptTool(this));
  }

  override async getTools(context?: ReadonlyContext): Promise<BaseTool[]> {
    // The parent resolves the skills' additional tools from the activation
    // state; its own fixed tools are replaced by the harness set.
    const parentTools = await super.getTools(context);
    const fixed = new Set(['list_skills', 'load_skill', 'load_skill_resource', 'run_skill_script', 'run_skill_inline_script', 'search_skills']);
    return [...this.harnessTools, ...parentTools.filter((t) => !fixed.has(t.name))];
  }
}

/** Build the toolset and its instruction block for one agent. */
export async function buildSkillHarness(
  config: SkillsConfig,
  additionalTools: unknown[],
): Promise<{ toolset: HarnessSkillToolset; instruction: string; skills: Record<string, LoadedSkill>; problems: string[] }> {
  const skills = await loadSkillSuite(config.dir);
  const toolset = new HarnessSkillToolset(skills, config, additionalTools);
  return { toolset, instruction: skillsInstruction(skills, config), skills, problems: await skillSuiteProblems(config.dir) };
}
