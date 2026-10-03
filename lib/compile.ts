/**
 * lib/compile.ts — the one YAML → ADK agent-graph compiler.
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
 * injected, because the two callers differ precisely there:
 *   - the A2A server resolves `model` to a provider INSTANCE carrying the
 *     caller's BYOK key (lib/models/registry.ts resolveModel);
 *   - the observatory passes the model id through as a string (the
 *     LLMRegistry routes it) and loads nested syndicates with its
 *     per-variant overrides already applied.
 *
 * ── Two orchestration methods, one compiler ───────────────────────────────
 * DELEGATE (no `dispatch:` block): every subagent becomes an AgentTool on
 * the orchestrator. PLAN-DISPATCH (`dispatch:` present): the orchestrator
 * is compiled WITHOUT subagent tools — it is a pure classifier — and the
 * caller runs `compileSubagent(route)` directly for the chosen route. Both
 * paths build subagents through the same function, so the agent a route
 * dispatches to is identical to the one DELEGATE would have wrapped.
 * Contract and rationale: lib/dispatch.ts.
 */

import { AgentTool, BuiltInCodeExecutor, ExampleTool, FunctionTool, LLMRegistry, LlmAgent, LlmSummarizer, TokenBasedContextCompactor } from '@google/adk';
import type { BaseTool, Context, RunAsyncToolRequest } from '@google/adk';
import type { BaseLlm } from '@google/adk';
import { relative } from 'node:path';

import { isDispatchSyndicate } from './dispatch.ts';
import { loadSyndicate, nestedLoader } from './loadSyndicate.ts';
import type { SubagentYamlConfig, SyndicateYamlConfig } from './loadSyndicate.ts';
import { resolveTools as resolveNamedTools } from './toolRegistry.ts';
import { createMcpTools } from './tools/mcpToolFactory.ts';
import { capabilitySummary, describeCapabilities } from './models/capabilities.ts';
import { remoteAgentTool } from './a2a/remoteAgent.ts';
import { buildSkillHarness } from './tools/skillToolset.ts';
import type { SkillsConfig } from './tools/skillToolset.ts';
import { buildOpenApiTools, isOpenApiTool, namesTool } from './tools/openapiTools.ts';
import type { OpenApiConfig } from './tools/openapiTools.ts';

export interface CompileOptions {
  /**
   * Turns the YAML `model` string into what LlmAgent receives. Default:
   * identity — the string goes straight to ADK's LLMRegistry, which needs
   * `registerAvailableProviders()` to have run (lib/models/registry.ts).
   * The A2A server substitutes a BYOK instance factory here.
   */
  resolveModel?: (model: string | undefined) => string | BaseLlm | undefined;
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
  /**
   * Node settings for an agent compiled as a workflow node (lib/workflow.ts):
   * ADK's `retryConfig` and `timeout`, which an LlmAgent takes only at
   * construction. Called with the agent's name; undefined means none.
   */
  nodeConfig?: (agentName: string) => Record<string, unknown> | undefined;
}

/** generateContentConfig as every entrypoint has always sent it to ADK. */
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

/**
 * The LlmAgent fields a YAML agent may set beyond model, instruction, tools
 * and schemas. The schema reference (config/agents/syndicateSchema.yaml)
 * documents each as mapping 1:1 to its ADK counterpart; before this they
 * were parsed and silently dropped, so `includeContents: none` — which the
 * intake template relies on so that a document never sees an earlier one —
 * changed nothing. Only fields the YAML sets are passed, so ADK's defaults
 * stay in force otherwise.
 */
function passthroughFields(cfg: {
  includeContents?: 'default' | 'none';
  outputKey?: string;
  globalInstruction?: string;
  disallowTransferToParent?: boolean;
  disallowTransferToPeers?: boolean;
}): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (cfg.includeContents !== undefined) out.includeContents = cfg.includeContents;
  if (cfg.outputKey !== undefined) out.outputKey = cfg.outputKey;
  if (cfg.globalInstruction !== undefined) out.globalInstruction = cfg.globalInstruction;
  if (cfg.disallowTransferToParent !== undefined) out.disallowTransferToParent = cfg.disallowTransferToParent;
  if (cfg.disallowTransferToPeers !== undefined) out.disallowTransferToPeers = cfg.disallowTransferToPeers;
  return out;
}

/** An agent's `context:` block: compact a long conversation into a summary (ADR 0033). */
export interface ContextConfig {
  /** Compact when the last request's prompt passed this many tokens. */
  compact_after_tokens: number;
  /** Events kept verbatim after the summary. Default 6. */
  keep_recent_events?: number;
  /** The model that writes the summary. Default: the agent's own. */
  summary_model?: string;
}

export const DEFAULT_KEEP_RECENT_EVENTS = 6;

/**
 * The LlmAgent fields the engine builds from YAML rather than passing
 * through (ADR 0033): `code_execution: gemini` (Gemini's server-side
 * sandbox runs the model's Python; nothing runs on this host), `context:`
 * (ADK's token-based compactor with an LLM summarizer, so a long
 * conversation is summarized instead of overflowing the window), and
 * `mode: task` (the agent works until it calls finish_task; on a workflow
 * node, its arguments become the node's output).
 */
function executionFields(
  cfg: { model?: string; code_execution?: 'gemini'; context?: ContextConfig; mode?: 'task' },
  opts: CompileOptions,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (cfg.code_execution === 'gemini') out.codeExecutor = new BuiltInCodeExecutor();
  if (cfg.mode) out.mode = cfg.mode;
  if (cfg.context) {
    const resolve = opts.resolveModel ?? ((m) => m);
    const summaryModel = resolve(cfg.context.summary_model ?? cfg.model);
    const llm = typeof summaryModel === 'string' || !summaryModel ? LLMRegistry.newLlm(String(summaryModel ?? cfg.model)) : summaryModel;
    out.contextCompactors = [
      new TokenBasedContextCompactor({
        tokenThreshold: cfg.context.compact_after_tokens,
        eventRetentionSize: cfg.context.keep_recent_events ?? DEFAULT_KEEP_RECENT_EVENTS,
        summarizer: new LlmSummarizer({ llm }),
      }),
    ];
  }
  return out;
}

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

/**
 * A copy of a FunctionTool that runs only after a person approves the call
 * (ADR 0028). ADK's own gate does the work: the call raises an
 * `adk_request_confirmation` interrupt pinning the call and its arguments,
 * and only an approval bound to that exact call runs it. The original stays
 * ungated for every other agent that lists the same tool.
 */
export function requireApprovalOn(tool: FunctionTool): FunctionTool {
  const gated = Object.create(tool) as FunctionTool;
  Object.defineProperty(gated, 'requireConfirmation', { value: true, enumerable: false });
  return gated;
}

/**
 * A copy of an OpenAPI tool (lib/tools/openapiTools.ts) that runs only after
 * a person approves the call: the same confirmation interrupt FunctionTool's
 * own gate raises, so the turn pauses and resumes exactly as ADR 0028 says.
 */
export function requireApprovalOnBaseTool<T extends BaseTool>(tool: T): T {
  const gated = Object.create(tool) as T;
  Object.defineProperty(gated, 'runAsync', {
    value: async (request: RunAsyncToolRequest) => {
      const ctx = request.toolContext as Context & { actions: { skipSummarization?: boolean } };
      if (!ctx.toolConfirmation) {
        ctx.requestConfirmation({ hint: `Approval is required before ${tool.name} runs.`, payload: request.args });
        ctx.actions.skipSummarization = true;
        return { error: 'This call requires approval, please approve or reject.' };
      }
      if (!ctx.toolConfirmation.confirmed) return { error: 'This call was rejected.' };
      return tool.runAsync(request);
    },
  });
  return gated;
}

function gateTools(tools: unknown[], names: string[] | undefined, agentName: string): unknown[] {
  if (!names?.length) return tools;
  const wanted = new Set(names);
  const out = tools.map((t) => {
    const tool = t as { name?: string; operation?: { operationId?: string } };
    const name = tool?.name;
    if (!name) return t;
    // An OpenAPI operation may be named as the YAML named it (its operationId).
    const match = [...wanted].find((w) => w === name || (isOpenApiTool(t) && namesTool(w, { name, operation: tool.operation })));
    if (!match) return t;
    wanted.delete(match);
    if (isOpenApiTool(t)) return requireApprovalOnBaseTool(t as BaseTool);
    if (!(t instanceof FunctionTool)) {
      throw new Error(`${agentName}: '${name}' cannot require approval — only function tools from the registry and OpenAPI operations can be gated (ADR 0028).`);
    }
    return requireApprovalOn(t);
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

/** An agent's `examples:` entry: one exchange the model should imitate. */
export interface ExampleConfig {
  input: string;
  output: string;
}

/**
 * ADK's ExampleTool from YAML pairs: never called by the model, it adds the
 * exchanges to every request's instruction as few-shot examples.
 */
export function examplesTool(examples: ExampleConfig[] | undefined): unknown[] {
  if (!examples?.length) return [];
  return [
    new ExampleTool(
      examples.map((e) => ({ input: { role: 'user', parts: [{ text: e.input }] }, output: [{ role: 'model', parts: [{ text: e.output }] }] })),
    ),
  ];
}

async function resolveAgentTools(
  toolNames: string[] | undefined,
  mcpServerUrl: string | undefined,
  opts: CompileOptions,
  openapi?: OpenApiConfig[],
  examples?: ExampleConfig[],
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
    const mcpTools = await createMcpTools(mcpServerUrl);
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

/**
 * Builds ONE runnable agent from a subagent entry. A `yaml_reference` entry
 * compiles the nested syndicate's whole graph under this entry's name and
 * description, so the parent sees one tool (or one route) either way.
 */
export async function compileSubagent(
  subCfg: SubagentYamlConfig,
  opts: CompileOptions = {},
): Promise<LlmAgent> {
  if (subCfg.a2a_agent_url) {
    // A remote agent has its own model and prompt on its own server; there
    // is no local agent to build. It is reached as a delegation tool
    // (compileGraph) or a dispatch route (lib/runtime/syndicateTurn.ts).
    throw new Error(`'${subCfg.name}' is a remote A2A agent (a2a_agent_url) and has no local agent to compile.`);
  }
  if (subCfg.yaml_reference) {
    opts.log?.(`Loading nested syndicate: ${subCfg.yaml_reference}`);
    const nested = (opts.loadNested ?? loadSyndicate)(subCfg.yaml_reference);
    if (declaresApprovals(nested)) {
      // A nested syndicate runs inside a tool call (or as a route whose
      // own subagents do): a pause there cannot reach the caller (ADR 0028).
      throw new Error(`${subCfg.yaml_reference}: approval gates (require_approval) are not supported inside a nested syndicate.`);
    }
    return compileGraph(nested, opts, subCfg.name, subCfg.description);
  }

  const gated = gateTools(await resolveAgentTools(subCfg.tools, subCfg.mcp_server_url, opts, subCfg.openapi, subCfg.examples), subCfg.require_approval, subCfg.name);
  const { instruction, tools } = await withSkills(subCfg.instruction ?? '', gated, subCfg.skills, subCfg.name, opts);
  const resolveModel = opts.resolveModel ?? ((m) => m);
  logCapabilities(opts, subCfg.name, subCfg.model, subCfg.tools);

  return new LlmAgent({
    name: subCfg.name,
    description: subCfg.description,
    model: resolveModel(subCfg.model) as any,
    instruction,
    tools: tools.length > 0 ? (tools as any[]) : undefined,
    outputSchema: subCfg.outputSchema as any,
    generateContentConfig: withServerSideToolInvocations(
      subCfg.generateContentConfig as Record<string, unknown> | undefined,
    ) as any,
    ...passthroughFields(subCfg),
    ...executionFields(subCfg, opts),
    ...(opts.nodeConfig?.(subCfg.name) ?? {}),
  });
}

/**
 * Compiles a syndicate's orchestrator. In DELEGATE mode its subagents are
 * attached as AgentTools; in PLAN-DISPATCH mode it gets none (ADK refuses
 * outputSchema + AgentTool on one agent — see config/agents/critic.yaml),
 * and the caller dispatches to `compileSubagent(route)` itself.
 */
export async function compileGraph(
  config: SyndicateYamlConfig,
  opts: CompileOptions = {},
  overrideName?: string,
  overrideDescription?: string,
): Promise<LlmAgent> {
  // A registry definition carries its nested syndicates (ADR 0018 item 6).
  if (config.bundled_references && !opts.loadNested) opts = { ...opts, loadNested: nestedLoader(config) };
  // A graph has no orchestrator-with-tools shape to build: its agents are
  // nodes (lib/workflow.ts). Nested as a yaml_reference, only its
  // orchestrator runs, since ADK cannot yet make a Workflow a subagent.
  if (config.workflow && !overrideName) {
    throw new Error(`${config.syndicate_name}: a workflow syndicate is compiled with compileWorkflow (lib/workflow.ts), not compileGraph`);
  }
  if (config.workflow) opts.log?.(`${config.syndicate_name}: nested as a subagent, so only its orchestrator runs (a Workflow cannot be a subagent yet)`);
  const compiledTools: unknown[] = isDispatchSyndicate(config)
    ? []
    : await Promise.all(
        (config.subagents ?? []).map(async (subCfg) => {
          if (subCfg.a2a_agent_url) {
            opts.log?.(`Remote A2A agent: ${subCfg.name} → ${subCfg.a2a_agent_url}`);
            return remoteAgentTool({ name: subCfg.name, description: subCfg.description, url: subCfg.a2a_agent_url });
          }
          return new AgentTool({ agent: await compileSubagent(subCfg, opts) });
        }),
      );

  // Orchestrator tools are registry names only — no entrypoint has ever
  // attached an MCP server to an orchestrator, and this compiler preserves
  // that exactly rather than widening the contract in passing.
  compiledTools.push(
    ...gateTools(
      await resolveAgentTools(config.orchestrator.tools, undefined, opts, config.orchestrator.openapi, config.orchestrator.examples),
      config.orchestrator.require_approval,
      overrideName || config.orchestrator.name,
    ),
  );
  const { instruction, tools: orchestratorTools } = await withSkills(
    config.orchestrator.instruction,
    compiledTools,
    config.orchestrator.skills,
    overrideName || config.orchestrator.name,
    opts,
  );
  const resolveModel = opts.resolveModel ?? ((m) => m);
  logCapabilities(
    opts,
    overrideName || config.orchestrator.name,
    config.orchestrator.model,
    config.orchestrator.tools,
  );

  return new LlmAgent({
    name: overrideName || config.orchestrator.name,
    description: overrideDescription || config.orchestrator.description,
    model: resolveModel(config.orchestrator.model) as any,
    instruction,
    tools: orchestratorTools.length > 0 ? (orchestratorTools as any[]) : undefined,
    outputSchema: config.orchestrator.outputSchema as any,
    generateContentConfig: withServerSideToolInvocations(
      config.orchestrator.generateContentConfig as Record<string, unknown> | undefined,
    ) as any,
    ...passthroughFields(config.orchestrator),
    ...executionFields(config.orchestrator, opts),
  });
}
