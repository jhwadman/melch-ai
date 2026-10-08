/**
 * lib/tools/skillToolset.ts — Agent Skills for a syndicate agent, the way a
 * coding harness holds them (ADR 0029), on the engine's own tool base
 * (ADR 0083).
 *
 * WHY this file exists:
 *   A coding harness (Claude Code, Codex, Gemini CLI) keeps every installed
 *   skill's frontmatter in its system prompt, reads a SKILL.md in full only
 *   when a request matches its description, opens the files a skill ships
 *   only when the procedure reaches them, and runs the scripts a skill
 *   ships. An agent's `skills:` block gets the same machinery here:
 *
 *   1. THE INDEX IS INJECTED. `skillsInstruction()` renders
 *      `<available_skills>` once at compile time and lib/compile.ts appends
 *      it to the agent's instruction: no round trip, always in view.
 *   2. DISCLOSURE STAYS PROGRESSIVE. load_skill returns the instructions and
 *      the NAMES of the files a skill ships; load_skill_resource reads one
 *      when the procedure asks.
 *   3. EVERY SCRIPT RUN IS GATED. run_skill_script asks for a person's
 *      approval first, through the same confirmation interrupt
 *      `require_approval` uses (ADR 0028), so the turn pauses
 *      `input-required` and resumes on approve or reject.
 *
 *   `allowed-tools` in a skill's frontmatter is honoured through activation:
 *   once the skill is loaded, the tools it names become callable, provided
 *   the agent's YAML listed them under `skills.tools`. Exposure stays two
 *   deliberate acts (the skill names the tool, the YAML permits it); a
 *   skill cannot grant itself a tool the YAML withheld.
 *
 * THE PIECES (lib/tools/skills/, no ADK import): frontmatter.ts reads and
 *   checks a SKILL.md, loader.ts loads a directory of skills, executor.ts
 *   runs a script on this machine, tools.ts holds the tools and the
 *   SkillToolset. The native loop expands the toolset before each request.
 *
 * WHAT RUNS: only scripts shipped in a skill's `scripts/` directory, on
 *   the local executor (`skills.scripts: local`), after approval. The
 *   model's own code never executes: the executor belongs to the toolset,
 *   never to the agent. What a script can reach is set out in
 *   lib/tools/skills/executor.ts.
 *
 * FAILURE CONTRACT: a missing skills directory fails the compile (an agent
 *   running without the skills it was declared with would be a silent
 *   defect). Inside a turn, the tools return `{ error }` objects the model
 *   can read, never throw.
 */

import { readdirSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';

import { splitAllowedTools } from './skills/frontmatter.ts';
import { loadAllSkillsInDir, validateSkillDir } from './skills/loader.ts';
import type { Skill } from './skills/loader.ts';
import { LoadSkillResourceTool, LoadSkillTool, RunSkillScriptTool, SCRIPT_TIMEOUT_SECONDS, SkillToolset } from './skills/tools.ts';

export { SCRIPT_TIMEOUT_SECONDS };

/** What an agent's YAML `skills:` block may say. */
export interface SkillsConfig {
  /** A directory of skills, one subdirectory each holding a SKILL.md. Relative to the working directory. */
  dir: string;
  /** Whether a skill's `scripts/` may run. `local` runs them on this host, each after a person approves. */
  scripts?: 'none' | 'local';
  /** Registry tool names a skill may unlock through its `allowed-tools` frontmatter, once loaded. */
  tools?: string[];
  /** Environment variable names a script gets beyond the base allowlist (ADR 0086). Names only; none may look like a secret. */
  env?: string[];
  /** Secret-shaped variable names a script gets, passed deliberately (ADR 0086). */
  secret_env?: string[];
}

/** One loaded skill (lib/tools/skills/loader.ts). */
export type LoadedSkill = Skill;

/**
 * Load every skill under `dir` (a skill is a directory whose name equals
 * its frontmatter `name`, holding a SKILL.md with a description; an invalid
 * skill is skipped and skillSuiteProblems says why). A directory that does
 * not exist is an error: the YAML declared skills this agent cannot have.
 * `onWarning` hears what the loader skipped for a size limit.
 */
export async function loadSkillSuite(dir: string, onWarning?: (message: string) => void): Promise<Record<string, LoadedSkill>> {
  const abs = resolve(dir);
  let real: string;
  try {
    real = realpathSync(abs);
    readdirSync(real);
  } catch {
    throw new Error(`skills: directory not found or unreadable: ${dir}`);
  }
  const skills = await loadAllSkillsInDir(real, { onWarning });
  for (const skill of Object.values(skills)) honourAllowedTools(skill);
  return skills;
}

/**
 * Why a skill directory under `dir` was NOT loaded, one line each, so the
 * compiler can report it. A candidate is a subdirectory holding a SKILL.md.
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
 * tool names) becomes `metadata.adk_additional_tools`, the activation list
 * the toolset reads once the skill is loaded. A skill that already set that
 * field keeps it.
 */
function honourAllowedTools(skill: LoadedSkill): void {
  const fm = skill.frontmatter;
  const declared = typeof fm.allowedTools === 'string' ? fm.allowedTools : typeof fm['allowed-tools'] === 'string' ? fm['allowed-tools'] : '';
  const names = splitAllowedTools(declared);
  if (names.length === 0) return;
  fm.metadata = { ...(fm.metadata ?? {}) };
  if (!Array.isArray(fm.metadata.adk_additional_tools)) fm.metadata.adk_additional_tools = names;
}

function escapeXml(s: string): string {
  return s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
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

/**
 * The toolset an agent with `skills:` carries: load_skill (lean) and
 * load_skill_resource, run_skill_script (gated) only when scripts may run,
 * and the permitted tools its loaded skills unlock. `list_skills` is left
 * out: the index is in the instruction.
 */
export class HarnessSkillToolset extends SkillToolset {
  constructor(skills: Record<string, LoadedSkill>, config: SkillsConfig, additionalTools: readonly unknown[] = []) {
    super(skills, { scripts: config.scripts, additionalTools, envNames: [...(config.env ?? []), ...(config.secret_env ?? [])] });
  }
}

/** The lean load_skill (ADR 0029), by the name it had when it extended ADK's tool. */
export const LeanLoadSkillTool = LoadSkillTool;
/** run_skill_script behind a person's approval, by the name it had when it extended ADK's tool. */
export const GatedRunSkillScriptTool = RunSkillScriptTool;
export { LoadSkillResourceTool, SkillToolset };

/** Build the toolset and its instruction block for one agent. */
export async function buildSkillHarness(
  config: SkillsConfig,
  additionalTools: readonly unknown[],
): Promise<{ toolset: HarnessSkillToolset; instruction: string; skills: Record<string, LoadedSkill>; problems: string[] }> {
  const warnings: string[] = [];
  const skills = await loadSkillSuite(config.dir, (m) => warnings.push(m));
  const toolset = new HarnessSkillToolset(skills, config, additionalTools);
  return { toolset, instruction: skillsInstruction(skills, config), skills, problems: [...(await skillSuiteProblems(config.dir)), ...warnings] };
}
