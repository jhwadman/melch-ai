/**
 * lib/compile.ts — the one YAML → agent compiler: an AgentSpec per agent,
 * which lib/compileNative.ts turns into what the runtime runs.
 *
 * WHY this file exists:
 *   The A2A server carried this logic as two closures inside its executor,
 *   and the observatory (observatory/, the eval harness) needs to run the
 *   EXACT graph production runs — same subagent wiring, same tool
 *   resolution, same generateContentConfig merge, same nested
 *   `yaml_reference` handling. A second copy would have been a second place
 *   for the two to drift, which is how toolRegistry.ts came to exist.
 *   So the compiler moved here and both callers import it.
 *
 * What it does NOT own: model resolution and nested-config loading. Both are
 * injected, because the callers differ precisely there:
 *   - the A2A server resolves `model` to a ModelAdapter carrying the
 *     caller's BYOK key (lib/models/registry.ts resolveModel);
 *   - the observatory passes the model id through as a string (the loop
 *     resolves it, lib/models/registry.ts resolveAdapter) and loads nested
 *     syndicates with its per-variant overrides already applied.
 *
 * ── Two orchestration methods, one compiler ───────────────────────────────
 * DELEGATE (no `dispatch:` block): every subagent becomes a delegation tool
 * on the orchestrator. PLAN-DISPATCH (`dispatch:` present): the orchestrator
 * is compiled WITHOUT subagent tools — it is a pure classifier — and the
 * turn runner compiles the chosen route's own spec. Both paths build
 * subagents through the same function, so the agent a route dispatches to
 * is identical to the one DELEGATE would have delegated to.
 * Contract and rationale: lib/dispatch.ts.
 *
 * ── The spec (ADR 0073, ADR 0107) ─────────────────────────────────────────
 * compileSpec and compileSubagentSpec resolve and gate the tools, append the
 * skills index, resolve the model once and build the generateContentConfig.
 * The result is an AgentSpec; lib/compileNative.ts builds the loop's
 * NativeAgent from it.
 */

import { relative } from 'node:path';

import { isDispatchSyndicate } from './dispatch.ts';
import { isWorkflowSyndicate, nodeKind } from './workflowConfig.ts';
import { loadSyndicate, nestedLoader } from './loadSyndicate.ts';
import type { ReasoningSetting, SubagentYamlConfig, SyndicateYamlConfig } from './loadSyndicate.ts';
import { REASONING_OLDER_SPELLING } from './syndicateSchema.ts';
import { reasoningConfig } from './models/reasoning.ts';
import { instructionFor, toEngineAgent } from './agentDialect.ts';
import { resolveTools as resolveNamedTools } from './toolRegistry.ts';
import { createMcpTools } from './tools/mcpToolFactory.ts';
import { requireApproval, toolOf } from './tools/tool.ts';
import type { ModelAdapter } from './models/contract.ts';
import { examplesInstructionTool } from './tools/examples.ts';
import type { ExampleConfig } from './tools/examples.ts';
import { capabilitySummary, describeCapabilities } from './models/capabilities.ts';
import { buildSkillHarness } from './tools/skillToolset.ts';
import type { SkillsConfig } from './tools/skillToolset.ts';
import { buildOpenApiTools, namesTool, openApiOperationId } from './tools/openapiTools.ts';
import type { OpenApiConfig } from './tools/openapiTools.ts';
import type { McpAuthConfig } from './tools/oauthTools.ts';

export interface CompileOptions {
  /**
   * Turns the YAML `model` string into what the agent runs on: a model id,
   * or a ModelAdapter (lib/models/contract.ts). Default: identity — the id
   * resolves through lib/models/registry.ts resolveAdapter when the agent
   * first calls it. The A2A server substitutes a BYOK adapter factory here.
   */
  resolveModel?: (model: string | undefined) => string | ModelAdapter | undefined;
  /**
   * Loads a nested `yaml_reference:` syndicate. Default: `loadSyndicate(ref)`
   * with no bindings — the same call the server makes. The observatory wraps
   * this to apply its variant overrides to nested syndicates too.
   */
  loadNested?: (ref: string) => SyndicateYamlConfig;
  /** Called once per YAML tool name that no registry entry matches. */
  onUnknownTool?: (name: string) => void;
  /** Progress/diagnostic line sink (nested loads, MCP discovery). */
  log?: (message: string) => void;
}

/** generateContentConfig as every entrypoint sends it: server-side tool invocations on. */
function withServerSideToolInvocations(
  generateContentConfig: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const cfg = (generateContentConfig ?? {}) as Record<string, any>;
  return {
    ...cfg,
    toolConfig: {
      ...(cfg.toolConfig ?? {}),
      includeServerSideToolInvocations: true,
    },
  };
}

// ── Reasoning (ADR 0047) ─────────────────────────────────────────────────────

// REASONING_BUDGETS and reasoningConfig live in lib/models/reasoning.ts, so a
// model adapter can map `reasoning:` without importing the compiler.
export { REASONING_BUDGETS, reasoningConfig } from './models/reasoning.ts';

/**
 * An agent's generateContentConfig with its `reasoning:` key mapped in for
 * the model it runs on. Unchanged (the same object) when the agent sets no
 * `reasoning`. The loader refuses `reasoning` next to the older spelling;
 * this refuses it too, for a config built in code.
 */
export function withReasoning(
  agent: { name?: string; reasoning?: ReasoningSetting; generateContentConfig?: object },
  model: string | undefined,
): Record<string, unknown> | undefined {
  const cfg = agent.generateContentConfig as Record<string, unknown> | undefined;
  if (agent.reasoning === undefined) return cfg;
  const clash = REASONING_OLDER_SPELLING.filter((k) => cfg?.[k] !== undefined);
  if (clash.length) {
    throw new Error(`${agent.name ?? 'agent'}: reasoning cannot be combined with ${clash.map((k) => `generateContentConfig.${k}`).join(' or ')}; reasoning replaces it (ADR 0047)`);
  }
  return { ...cfg, ...reasoningConfig(model ?? '', agent.reasoning) };
}

/** The model id an agent runs on, from its YAML or its resolved adapter. */
function modelIdOf(yamlModel: string | undefined, resolved: unknown): string | undefined {
  if (yamlModel !== undefined) return yamlModel;
  if (typeof resolved === 'string') return resolved;
  const own = resolved && typeof resolved === 'object' ? (resolved as { model?: unknown }).model : undefined;
  return typeof own === 'string' ? own : undefined;
}

/** An agent's `context:` block and its default, owned by the compactor (ADR 0033). */
export type { ContextConfig } from './runtime/native/compaction.ts';
import type { ContextConfig } from './runtime/native/compaction.ts';
export { DEFAULT_KEEP_RECENT_EVENTS } from './runtime/native/compaction.ts';

/**
 * Says, once per compiled agent, what its resolved path cannot honour — a
 * dropped server-side tool, a gateway stand-in, or no route at all. Quiet
 * for the normal case (funded direct path, nothing dropped). The check runs
 * on the model STRING under the current env, which is the same decision
 * resolveModel makes; a BYOK entrypoint that funds a provider per request
 * reports through its own resolver instead.
 */
function logCapabilities(
  opts: CompileOptions,
  agentName: string,
  model: string | undefined,
  tools: readonly string[] | undefined,
): void {
  if (!opts.log || !model) return;
  const line = capabilitySummary(agentName, describeCapabilities(model, tools ?? []));
  if (line) opts.log(`capability · ${line}`);
}

function gateTools(tools: unknown[], names: string[] | undefined, agentName: string): unknown[] {
  if (!names?.length) return tools;
  const wanted = new Set(names);
  const out = tools.map((t) => {
    const name = (t as { name?: string } | undefined)?.name;
    if (!name) return t;
    // An OpenAPI operation may be named as the YAML named it (its operationId).
    const operationId = openApiOperationId(t);
    const match = [...wanted].find((w) => w === name || (operationId !== undefined && namesTool(w, { name, operation: { operationId } })));
    if (!match) return t;
    wanted.delete(match);
    // A registry tool, an OpenAPI operation and an MCP tool are own Tools (ADR 0067): one gate for all.
    const own = toolOf(t);
    if (!own) {
      throw new Error(`${agentName}: '${name}' cannot require approval — only function tools from the registry, OpenAPI operations and MCP tools can be gated (ADR 0028).`);
    }
    return requireApproval(own);
  });
  if (wanted.size) {
    // Fail closed: a gate on a tool that did not resolve must not leave an
    // ungated tool of the same name reachable later.
    throw new Error(`${agentName}: require_approval names ${[...wanted].map((n) => `'${n}'`).join(', ')}, which did not resolve to a tool.`);
  }
  return out;
}

/** True when any agent of a syndicate may pause for approval: a gated tool, or skill scripts. */
export function declaresApprovals(config: SyndicateYamlConfig): boolean {
  return agentGates(config.orchestrator) || (config.subagents ?? []).some((s) => agentGates(s));
}

export type { ExampleConfig };

/**
 * An agent's `examples:` as their InstructionTool (lib/tools/examples.ts):
 * never called by the model, it adds the exchanges to every request's
 * instruction as few-shot examples, in the words ADK's ExampleTool used.
 */
export function examplesTool(examples: ExampleConfig[] | undefined): unknown[] {
  const tool = examplesInstructionTool(examples);
  return tool ? [tool] : [];
}

async function resolveAgentTools(
  toolNames: string[] | undefined,
  mcpServerUrl: string | undefined,
  opts: CompileOptions,
  openapi?: OpenApiConfig[],
  examples?: ExampleConfig[],
  mcpAllowed?: string[],
  mcpAuth?: McpAuthConfig,
): Promise<unknown[]> {
  const tools = [...resolveNamedTools(toolNames, opts.onUnknownTool), ...examplesTool(examples)];
  // OpenAPI operations become tools here, so require_approval can name them.
  for (const entry of openapi ?? []) {
    const built = await buildOpenApiTools(entry);
    opts.log?.(`openapi · ${relative(process.cwd(), entry.spec) || entry.spec}: ${built.map((t) => t.name).join(', ') || '(no operations)'}`);
    for (const t of built) {
      if (tools.some((existing: any) => existing?.name === t.name)) throw new Error(`openapi ${entry.spec}: tool '${t.name}' collides with another tool; set a prefix`);
      tools.push(t);
    }
  }
  if (mcpServerUrl) {
    opts.log?.(`Loading MCP tools: ${mcpServerUrl}`);
    // An authorization_code server lists nothing at startup: its tools are the mcp_tools names, each on its user's own connection (ADR 0112).
    const offered = await createMcpTools(mcpServerUrl, { ...(mcpAllowed ? { tools: mcpAllowed } : {}), ...(mcpAuth?.oauth2 ? { oauth2: mcpAuth.oauth2 } : {}) });
    // mcp_tools: only the named tools are exposed (a server's list is its
    // own to change); a name the server does not offer is reported, and a
    // gate on it fails the compile in gateTools.
    const allowed = mcpAllowed ? new Set(mcpAllowed) : undefined;
    const mcpTools = allowed ? offered.filter((t) => allowed.has(t.name)) : offered;
    if (allowed) {
      const missing = [...allowed].filter((n) => !offered.some((t) => t.name === n));
      if (missing.length) opts.log?.(`MCP ${mcpServerUrl} does not offer ${missing.map((n) => `'${n}'`).join(', ')} (mcp_tools)`);
      const hidden = offered.length - mcpTools.length;
      if (hidden) opts.log?.(`MCP ${mcpServerUrl}: ${hidden} tool(s) not in mcp_tools are not exposed`);
    }
    for (const mcpTool of mcpTools) {
      if (!tools.some((t: any) => t.name === mcpTool.name)) tools.push(mcpTool);
    }
  }
  return tools;
}

/**
 * An agent's `skills:` block becomes one toolset among its tools and one
 * block appended to its instruction (the frontmatter index, always in view).
 * The registry tools a skill may unlock (`skills.tools`) are resolved here,
 * by name, and handed to the toolset; they reach the model only after a
 * skill naming them is loaded (lib/tools/skillToolset.ts).
 */
async function withSkills(
  instruction: string,
  tools: unknown[],
  skills: SkillsConfig | undefined,
  agentName: string,
  opts: CompileOptions,
): Promise<{ instruction: string; tools: unknown[] }> {
  if (!skills) return { instruction, tools };
  const unlockable = resolveNamedTools(skills.tools, opts.onUnknownTool);
  const harness = await buildSkillHarness(skills, unlockable);
  const count = Object.keys(harness.skills).length;
  opts.log?.(`skills · ${agentName}: ${count} skill${count === 1 ? '' : 's'} from ${skills.dir}${skills.scripts === 'local' ? ' · scripts run after approval' : ''}`);
  for (const problem of harness.problems) opts.log?.(`⚠ skills · ${skills.dir}: not loaded — ${problem}`);
  return { instruction: `${instruction.trimEnd()}\n\n${harness.instruction}`, tools: [...tools, harness.toolset] };
}

/** True when a turn running this agent directly may pause for a person (ADR 0028). */
export function agentGates(agent: { require_approval?: string[]; skills?: SkillsConfig } | undefined): boolean {
  return !!agent?.require_approval?.length || agent?.skills?.scripts === 'local';
}

// ── The runtime-neutral agent (ADR 0073) ────────────────────────────────────

/**
 * One entry of an agent's tool list, in the order the model sees it.
 * `tool` is a resolved tool as the registry gives it: an own Tool,
 * InstructionTool, NativeToolMarker or Toolset (lib/tools/tool.ts), gated
 * by require_approval where the YAML says so. `agent` is a delegated subagent
 * (DELEGATE mode), `remote` a subagent served over A2A, `workflow` a
 * `yaml_reference` to a workflow syndicate, whose whole graph is the tool
 * (ADR 0098).
 */
export type SpecTool =
  | { kind: 'tool'; tool: unknown }
  | { kind: 'agent'; agent: AgentSpec }
  | { kind: 'remote'; name: string; description: string; url: string }
  | { kind: 'workflow'; workflow: WorkflowSpec };

/**
 * A workflow syndicate, compiled: lib/compileNative.ts builds the walk's
 * graph and agents from it. Nested as a subagent (a `yaml_reference` in
 * DELEGATE mode), the graph runs under the entry's name and description,
 * and that name is the root of every node path.
 */
export interface WorkflowSpec {
  /** The workflow's name: the syndicate's, or the subagent entry's when nested. */
  name: string;
  /** The tool's description when nested; '' at the root. */
  description: string;
  /** The syndicate, its `syndicate_name` set to `name`. */
  config: SyndicateYamlConfig;
  /** Every agent of the graph, the orchestrator first, as compileSubagentSpec builds it, with its YAML entry. */
  agents: Array<{ yaml: SubagentYamlConfig; spec: AgentSpec }>;
  /**
   * Every node that is a `yaml_reference` to a workflow syndicate, with its
   * YAML entry: the nested graph under the entry's name (ADR 0106). The
   * walk runs it as the node, on its own child session.
   */
  workflows: Array<{ yaml: SubagentYamlConfig; workflow: WorkflowSpec }>;
  /** The registry entry for a tool node's tool name, or undefined (CompileOptions.onUnknownTool applies). */
  resolveTool: (name: string) => unknown;
}

/**
 * One YAML agent, compiled: what lib/compileNative.ts turns into the loop's
 * NativeAgent. Built once per agent by compileSpec and compileSubagentSpec:
 * the tools resolved (OpenAPI operations built, MCP tools listed) and
 * gated, the skills index appended to the instruction, the model resolved
 * once through CompileOptions.resolveModel, and the generateContentConfig
 * built for the model the agent runs on.
 */
export interface AgentSpec {
  name: string;
  description?: string;
  /** The model id the YAML names; undefined when the agent takes the resolver's default. */
  model?: string;
  /** What CompileOptions.resolveModel returned for `model`: an id, or an adapter instance (a BYOK one on the A2A server). */
  resolvedModel?: unknown;
  /** The id the agent runs on: the YAML's, else the resolved adapter's. */
  modelId?: string;
  /** `fallback_model:`, unresolved: the loop resolves it where it calls it. */
  fallbackModel?: string;
  /** The YAML instruction, with the skills index appended when the agent has `skills:`. */
  instruction: string;
  globalInstruction?: string;
  tools: SpecTool[];
  outputSchema?: Record<string, unknown>;
  /** The YAML's config with `reasoning:` mapped in and server-side tool invocations on. */
  generateContentConfig: Record<string, unknown>;
  includeContents?: 'default' | 'none';
  outputKey?: string;
  disallowTransferToParent?: boolean;
  disallowTransferToPeers?: boolean;
  /** `code_execution: gemini`. */
  codeExecution?: 'gemini';
  /** `context:`: compaction (ADR 0033). */
  context?: ContextConfig;
  /** `mode: task`. */
  mode?: 'task';
}

/** The agent fields a spec carries from YAML, orchestrator or subagent alike. */
interface AgentYaml {
  name: string;
  model?: string;
  fallback_model?: string;
  outputSchema?: unknown;
  includeContents?: 'default' | 'none';
  outputKey?: string;
  globalInstruction?: string;
  disallowTransferToParent?: boolean;
  disallowTransferToPeers?: boolean;
  code_execution?: 'gemini';
  context?: ContextConfig;
  mode?: 'task';
  reasoning?: ReasoningSetting;
  generateContentConfig?: object;
}

/** The model an agent runs on, resolved once through CompileOptions.resolveModel, and its id. */
interface ResolvedModel {
  resolvedModel: unknown;
  modelId: string | undefined;
}

function resolveAgentModel(model: string | undefined, opts: CompileOptions): ResolvedModel {
  const resolvedModel = (opts.resolveModel ?? ((m) => m))(model);
  return { resolvedModel, modelId: modelIdOf(model, resolvedModel) };
}

function specOf(
  yaml: AgentYaml,
  name: string,
  description: string | undefined,
  instruction: string,
  tools: SpecTool[],
  { resolvedModel, modelId }: ResolvedModel,
): AgentSpec {
  const spec: AgentSpec = {
    name,
    instruction,
    tools,
    resolvedModel,
    generateContentConfig: withServerSideToolInvocations(withReasoning(yaml, modelId)),
  };
  if (description !== undefined) spec.description = description;
  if (yaml.model !== undefined) spec.model = yaml.model;
  if (modelId !== undefined) spec.modelId = modelId;
  if (yaml.fallback_model) spec.fallbackModel = yaml.fallback_model;
  if (yaml.outputSchema) spec.outputSchema = yaml.outputSchema as Record<string, unknown>;
  if (yaml.includeContents !== undefined) spec.includeContents = yaml.includeContents;
  if (yaml.outputKey !== undefined) spec.outputKey = yaml.outputKey;
  if (yaml.globalInstruction !== undefined) spec.globalInstruction = yaml.globalInstruction;
  if (yaml.disallowTransferToParent !== undefined) spec.disallowTransferToParent = yaml.disallowTransferToParent;
  if (yaml.disallowTransferToPeers !== undefined) spec.disallowTransferToPeers = yaml.disallowTransferToPeers;
  if (yaml.code_execution) spec.codeExecution = yaml.code_execution;
  if (yaml.context) spec.context = yaml.context;
  if (yaml.mode) spec.mode = yaml.mode;
  return spec;
}

const asTools = (tools: unknown[]): SpecTool[] => tools.map((tool) => ({ kind: 'tool', tool }));

/**
 * A nested `yaml_reference:` syndicate, loaded. A nested syndicate runs
 * inside a tool call (or as a route whose own subagents do): a pause there
 * cannot reach the caller (ADR 0028), so one that declares approval gates is
 * refused.
 */
/** Where the yaml_reference chain a compile is inside is kept: an own symbol on the options, so a spread copy keeps it. */
const NESTING = Symbol('melchizedek.compile.nesting');

/** The deepest a yaml_reference chain may go: well past any syndicate the engine ships, short of the stack. */
const MAX_NESTING_DEPTH = 16;

/**
 * The options a nested `ref` compiles with: `opts` and the chain of
 * references above it. A reference already on the chain (a syndicate that
 * reaches itself) or a chain past MAX_NESTING_DEPTH is refused by name (WS5-5,
 * ADR 0101): the compile would otherwise recurse until the stack gave out,
 * which took the process with it.
 */
function nestedOptions(ref: string, opts: CompileOptions): CompileOptions {
  const chain = ((opts as { [NESTING]?: readonly string[] })[NESTING] ?? []) as readonly string[];
  if (chain.includes(ref)) throw new Error(`${ref}: a nested syndicate reaches itself (${[...chain, ref].join(' → ')}); a yaml_reference chain must end.`);
  if (chain.length >= MAX_NESTING_DEPTH) throw new Error(`${ref}: nested syndicates go deeper than ${MAX_NESTING_DEPTH} levels (${[...chain, ref].join(' → ')}).`);
  return { ...opts, [NESTING]: [...chain, ref] } as CompileOptions;
}

function loadNestedSyndicate(ref: string, opts: CompileOptions): SyndicateYamlConfig {
  opts.log?.(`Loading nested syndicate: ${ref}`);
  const nested = (opts.loadNested ?? loadSyndicate)(ref);
  if (declaresApprovals(nested)) {
    throw new Error(`${ref}: approval gates (require_approval) are not supported inside a nested syndicate.`);
  }
  return nested;
}

/**
 * The spec of a workflow syndicate: every agent through compileSubagentSpec
 * (the orchestrator first, as a node like any other), and the registry's
 * lookup for its tool nodes. `name` and `description` name a nested one
 * after its subagent entry (ADR 0098); `ref` is the file it came from.
 *
 * A nested workflow runs inside its caller's tool call, so a pause inside it
 * could not reach the caller (ADR 0028, as for any nested syndicate): an
 * `ask_user` node is refused by name here.
 */
export async function compileWorkflowSpec(
  config: SyndicateYamlConfig,
  opts: CompileOptions = {},
  name?: string,
  description?: string,
  ref?: string,
): Promise<WorkflowSpec> {
  if (!isWorkflowSyndicate(config)) throw new Error(`${config.syndicate_name}: no workflow block`);
  if (name) {
    const asking = Object.entries(config.workflow.nodes ?? {}).find(([, node]) => nodeKind(node) === 'ask_user');
    if (asking) {
      throw new Error(
        `${ref ?? config.syndicate_name}: the ask_user node '${asking[0]}' pauses for a person, which a workflow nested in another syndicate (${name}) cannot carry to its caller; run the workflow as its own syndicate, or remove the node.`,
      );
    }
  }
  const workflowName = name || config.syndicate_name;
  const agents: WorkflowSpec['agents'] = [];
  const workflows: WorkflowSpec['workflows'] = [];
  for (const yaml of [{ description: '', ...config.orchestrator } as SubagentYamlConfig, ...(config.subagents ?? [])]) {
    const entry = await compileEntrySpec(yaml, opts);
    if (entry.kind === 'workflow') workflows.push({ yaml, workflow: entry.workflow });
    else agents.push({ yaml, spec: entry.spec });
  }
  // A map runs one agent per item; a nested graph is not an agent a map item can be (ADR 0106).
  for (const [node, entry] of Object.entries(config.workflow.nodes ?? {})) {
    const mapped = nodeKind(entry) === 'map' ? workflows.find((w) => w.yaml.name === entry.map) : undefined;
    if (mapped) {
      throw new Error(
        `${ref ?? config.syndicate_name}: the map node '${node}' runs '${mapped.yaml.name}', a workflow syndicate (${mapped.yaml.yaml_reference}); a map runs one agent per item, so make the workflow a node of its own.`,
      );
    }
  }
  return {
    name: workflowName,
    description: description ?? '',
    config: { ...config, syndicate_name: workflowName },
    agents,
    workflows,
    resolveTool: (tool) => resolveNamedTools([tool], opts.onUnknownTool)[0],
  };
}

/** Every agent spec a workflow runs, its nested workflow nodes' agents included, for one adapter lookup (nativeAdapterFor). */
export function workflowAgentSpecs(spec: WorkflowSpec): AgentSpec[] {
  return [...spec.agents.map((a) => a.spec), ...spec.workflows.flatMap((w) => workflowAgentSpecs(w.workflow))];
}

/** A subagent entry, compiled: one agent, or a nested workflow syndicate's whole graph (ADR 0098, ADR 0106). */
export type EntrySpec = { kind: 'agent'; spec: AgentSpec } | { kind: 'workflow'; workflow: WorkflowSpec };

/**
 * A subagent entry as what it runs: an inline agent or a nested syndicate's
 * orchestrator as one agent, or a `yaml_reference` to a workflow syndicate
 * as its whole graph under the entry's name and description. A delegated
 * subagent, a dispatch route and a workflow node all compile through here,
 * so the graph a file describes is the graph that runs (ADR 0106).
 */
export async function compileEntrySpec(subCfg: SubagentYamlConfig, opts: CompileOptions = {}): Promise<EntrySpec> {
  if (subCfg.yaml_reference && !subCfg.a2a_agent_url) {
    const nestedOpts = nestedOptions(subCfg.yaml_reference, opts);
    const nested = loadNestedSyndicate(subCfg.yaml_reference, nestedOpts);
    if (isWorkflowSyndicate(nested)) {
      return { kind: 'workflow', workflow: await compileWorkflowSpec(nested, nestedOpts, subCfg.name, subCfg.description, subCfg.yaml_reference) };
    }
    return { kind: 'agent', spec: await compileSpec(nested, nestedOpts, subCfg.name, subCfg.description) };
  }
  return { kind: 'agent', spec: await compileSubagentSpec(subCfg, opts) };
}

/**
 * The names of a syndicate's subagent entries that are `yaml_reference`s to
 * a workflow syndicate. Loads each reference once and compiles nothing, so a
 * runtime can refuse what it cannot run before the session is touched.
 */
export function workflowEntryNames(config: SyndicateYamlConfig, opts: CompileOptions = {}): string[] {
  const load = opts.loadNested ?? (config.bundled_references ? nestedLoader(config) : loadSyndicate);
  return (config.subagents ?? []).filter((s) => !!s.yaml_reference && !s.a2a_agent_url && isWorkflowSyndicate(load(s.yaml_reference))).map((s) => s.name);
}

/**
 * The spec of ONE agent from a subagent entry. A `yaml_reference` entry is
 * the nested syndicate's orchestrator under this entry's name and
 * description, its own subagents delegated to as in any DELEGATE graph. A
 * `yaml_reference` to a workflow syndicate has no one agent to build: it
 * runs as its whole graph (compileEntrySpec), and is refused here by name.
 */
export async function compileSubagentSpec(subCfg: SubagentYamlConfig, opts: CompileOptions = {}): Promise<AgentSpec> {
  if (subCfg.a2a_agent_url) {
    // A remote agent has its own model and prompt on its own server; there
    // is no local agent to build. It is reached as a delegation tool
    // (compileSpec) or a dispatch route (lib/runtime/syndicateTurn.ts).
    throw new Error(`'${subCfg.name}' is a remote A2A agent (a2a_agent_url) and has no local agent to compile.`);
  }
  if (subCfg.yaml_reference) {
    const nestedOpts = nestedOptions(subCfg.yaml_reference, opts);
    const nested = loadNestedSyndicate(subCfg.yaml_reference, nestedOpts);
    if (isWorkflowSyndicate(nested)) {
      throw new Error(`${subCfg.yaml_reference}: '${subCfg.name}' is a workflow syndicate, which runs as its whole graph, not as one agent; compile the entry with compileEntrySpec (ADR 0106).`);
    }
    return compileSpec(nested, nestedOpts, subCfg.name, subCfg.description);
  }

  // YAML v2 (ADR 0115): the engine form, for a config built in code (a loaded one already is).
  const agent = toEngineAgent(subCfg);
  const gated = gateTools(await resolveAgentTools(agent.tools, agent.mcp_server_url, opts, agent.openapi, agent.examples, agent.mcp_tools, agent.mcp_auth), agent.require_approval, agent.name);
  const model = resolveAgentModel(agent.model, opts);
  // model_overrides for the provider the agent runs on, before the skills index is appended.
  const { instruction, tools } = await withSkills(instructionFor(agent, model.modelId), gated, agent.skills, agent.name, opts);
  logCapabilities(opts, agent.name, agent.model, agent.tools);
  return specOf(agent as AgentYaml, agent.name, agent.description, instruction, asTools(tools), model);
}

/**
 * The spec of a syndicate's orchestrator. In DELEGATE mode its subagents
 * come first among its tools, as delegations; in PLAN-DISPATCH mode it gets
 * none (a classifier answers with its outputSchema — see
 * config/agents/critic.yaml), and the caller dispatches to a route's own
 * spec itself.
 */
export async function compileSpec(
  config: SyndicateYamlConfig,
  opts: CompileOptions = {},
  overrideName?: string,
  overrideDescription?: string,
): Promise<AgentSpec> {
  // A registry definition carries its nested syndicates (ADR 0018 item 6).
  if (config.bundled_references && !opts.loadNested) opts = { ...opts, loadNested: nestedLoader(config) };
  // A graph has no orchestrator-with-tools shape to build: its agents are
  // nodes (lib/workflow.ts). A yaml_reference to one runs the whole graph, as
  // a delegated tool (ADR 0098), a dispatch route or a workflow node (ADR
  // 0106), through compileEntrySpec, which never compiles one here.
  if (config.workflow) {
    throw new Error(`${config.syndicate_name}: a workflow syndicate is compiled with compileWorkflowSpec, not compileSpec`);
  }
  const delegated: SpecTool[] = isDispatchSyndicate(config)
    ? []
    : await Promise.all(
        (config.subagents ?? []).map(async (subCfg): Promise<SpecTool> => {
          if (subCfg.a2a_agent_url) {
            opts.log?.(`Remote A2A agent: ${subCfg.name} → ${subCfg.a2a_agent_url}`);
            return { kind: 'remote', name: subCfg.name, description: subCfg.description, url: subCfg.a2a_agent_url };
          }
          const entry = await compileEntrySpec(subCfg, opts);
          return entry.kind === 'workflow' ? entry : { kind: 'agent', agent: entry.spec };
        }),
      );

  const orchestrator = toEngineAgent(config.orchestrator); // YAML v2 (ADR 0115), for a config built in code
  const name = overrideName || orchestrator.name;
  // Orchestrator tools are registry names only — no entrypoint has ever
  // attached an MCP server to an orchestrator, and this compiler preserves
  // that exactly rather than widening the contract in passing.
  const own = gateTools(
    await resolveAgentTools(orchestrator.tools, undefined, opts, orchestrator.openapi, orchestrator.examples),
    orchestrator.require_approval,
    name,
  );
  const model = resolveAgentModel(orchestrator.model, opts);
  // The skills toolset goes last, after the delegations and the agent's own tools; the
  // skills index goes after the instruction with its model_overrides entry applied.
  const { instruction, tools } = await withSkills(instructionFor(orchestrator, model.modelId), own, orchestrator.skills, name, opts);
  logCapabilities(opts, name, orchestrator.model, orchestrator.tools);
  return specOf(
    orchestrator as AgentYaml,
    name,
    overrideDescription || orchestrator.description,
    instruction,
    [...delegated, ...asTools(tools)],
    model,
  );
}

