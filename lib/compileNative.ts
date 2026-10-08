/**
 * lib/compileNative.ts — an AgentSpec as the native runtime runs it: the
 * NativeAgent the agent loop takes (ADR 0045, ADR 0073).
 *
 * WHY this file exists:
 *   lib/compile.ts turns a YAML agent into a runtime-neutral AgentSpec, and
 *   lib/compileAdk.ts builds ADK's LlmAgent from it. This file builds the
 *   native loop's agent from the same spec (lib/runtime/native/request.ts,
 *   NativeAgent), so both runtimes run the agent the YAML describes, with
 *   the same tools, instruction and config. tests/compile.test.ts compiles
 *   one spec both ways and requires the same first request.
 *
 * TOOLS: each resolved tool is handed to the loop as the own Tool or
 * InstructionTool behind it (lib/tools/tool.ts), else as itself: an MCP
 * tool, the skills toolset, a gated registry FunctionTool, which the loop
 * runs by shape during the dual period (ADR 0071). A delegated subagent
 * becomes a subagentTool holding its own NativeAgent, which the loop runs as
 * a child loop (lib/runtime/native/delegate.ts, ADR 0074), a nested
 * syndicate as its orchestrator's agent, a nested workflow syndicate as a
 * workflowSubagentTool whose call walks the whole graph (ADR 0098); a remote A2A subagent is the own
 * Tool the ADK runtime's FunctionTool wraps (lib/a2a/remoteAgent.ts).
 *
 * EVERY AGENT KEY COMPILES for the native loop: `context:` is handed to
 * the loop, which compacts as ADK does (lib/runtime/native/compaction.ts,
 * WS2-9); `mode: task` and `code_execution: gemini` pass through, the
 * request declaring finish_task (lib/runtime/native/taskMode.ts) and asking
 * Gemini for its code-execution tool (lib/runtime/native/request.ts). What
 * native does not run yet (workflows, resuming an approval or a
 * question, a caller's agent transform) is refused by the turn runner
 * (lib/runtime/nativeTurn.ts), which owns those choices.
 *
 * THE MODEL: the loop calls a model through its contract adapter. A
 * resolver may return an id, a contract adapter, an ADK shim (which carries
 * one) or ADK's Gemini (TracedGemini), whose key reaches the registry's
 * Gemini adapter. Any other ADK model class has no adapter behind it, so
 * compileNative and nativeAdapterFor refuse it with UnsupportedOnRuntimeError
 * before any model call, naming adkShim as the way to run it on native,
 * rather than run the registry's model for that id in its place (ADR 0088).
 * ADK classes are told apart by ADK's own Symbol.for marks, so this file
 * imports nothing from ADK.
 */

import { remoteAgentOwnTool } from './a2a/remoteAgent.ts';
import { compileSpec, compileSubagentSpec, workflowAgentSpecs } from './compile.ts';
import type { AgentSpec, CompileOptions, WorkflowSpec } from './compile.ts';
import type { SubagentYamlConfig, SyndicateYamlConfig } from './loadSyndicate.ts';
import type { ModelAdapter } from './models/contract.ts';
import { providerForModel, resolveAdapter } from './models/registry.ts';
import { subagentTool, workflowSubagentTool } from './runtime/native/delegate.ts';
import type { WorkflowSubagent } from './runtime/native/delegate.ts';
import { servedThroughShim } from './runtime/native/selfCorrection.ts';
import type { NativeAgent } from './runtime/native/request.ts';
import { unsupportedOnNative } from './runtime/runtimeFlag.ts';
export { UnsupportedOnRuntimeError, unsupportedOnNative } from './runtime/runtimeFlag.ts';
import { instructionToolOf, toolOf, toolsetOf } from './tools/tool.ts';
import { buildWorkflowGraph } from './workflow/graph.ts';
import type { WorkflowGraph } from './workflow/graph.ts';
import { refuseUnrunnableNodes, runNativeWorkflow } from './workflow/turn.ts';

/** A resolved tool as the loop holds it: the own Tool, InstructionTool or Toolset behind it, else the object itself. */
function nativeTool(tool: unknown): unknown {
  return toolOf(tool) ?? instructionToolOf(tool) ?? toolsetOf(tool) ?? tool;
}

/** ADK's own marks on its model classes (BaseLlm, Gemini), registered with Symbol.for so they hold across copies of ADK. */
const ADK_BASE_MODEL = Symbol.for('google.adk.baseModel');
const ADK_GEMINI_MODEL = Symbol.for('google.adk.geminiModel');

const marked = (value: unknown, mark: symbol): boolean => !!value && typeof value === 'object' && (value as Record<symbol, unknown>)[mark] === true;

/**
 * The class name of an ADK model the native runtime cannot run, else
 * undefined: an ADK BaseLlm that is neither ADK's Gemini (TracedGemini
 * included) nor a shim carrying a contract adapter (lib/models/adkShim.ts).
 */
export function unrunnableModelClass(resolved: unknown): string | undefined {
  if (!marked(resolved, ADK_BASE_MODEL) || marked(resolved, ADK_GEMINI_MODEL)) return undefined;
  if (isModelAdapter((resolved as { adapter?: unknown }).adapter)) return undefined;
  const name = (resolved as { constructor?: { name?: unknown } }).constructor?.name;
  return typeof name === 'string' && name ? name : 'BaseLlm';
}

/** Throws UnsupportedOnRuntimeError when `resolved` is an ADK model class native cannot run (see the header). */
function refuseModelClass(resolved: unknown, modelId: string | undefined, where: string): void {
  const name = unrunnableModelClass(resolved);
  if (!name) return;
  throw unsupportedOnNative(
    `the ADK model class ${name} that resolveModel returned${modelId ? ` for '${modelId}'` : ''}, which has no contract adapter behind it ` +
      `(return the ModelAdapter itself, or adkShim(adapter) from melchizedek-agents/models/adkShim, to run it on native)`,
    where,
  );
}

/**
 * The NativeAgent for `spec`. Throws when no model id is known, and
 * UnsupportedOnRuntimeError when the resolver returned an ADK model class
 * the loop cannot call (see the header).
 */
export function compileNative(spec: AgentSpec): NativeAgent {
  refuseModelClass(spec.resolvedModel, spec.model ?? spec.modelId, spec.name);
  const tools: unknown[] = [];
  for (const entry of spec.tools) {
    if (entry.kind === 'agent') tools.push(subagentTool(compileNative(entry.agent)));
    else if (entry.kind === 'workflow') tools.push(workflowSubagentTool(workflowSubagentOf(compileNativeWorkflow(entry.workflow))));
    else if (entry.kind === 'remote') tools.push(remoteAgentOwnTool({ name: entry.name, description: entry.description, url: entry.url }));
    else tools.push(nativeTool(entry.tool));
  }
  const model = wireModelOf(spec);
  if (!model) throw new Error(`${spec.name}: no model id to run on (the YAML names none and the resolver returned none).`);

  const agent: NativeAgent = {
    name: spec.name,
    model,
    instruction: spec.instruction,
    tools,
    generateContentConfig: spec.generateContentConfig,
  };
  if (spec.description) agent.description = spec.description;
  if (spec.globalInstruction !== undefined) agent.globalInstruction = spec.globalInstruction;
  if (spec.outputSchema) agent.outputSchema = spec.outputSchema;
  if (spec.includeContents !== undefined) agent.includeContents = spec.includeContents;
  if (spec.disallowTransferToParent !== undefined) agent.disallowTransferToParent = spec.disallowTransferToParent;
  if (spec.disallowTransferToPeers !== undefined) agent.disallowTransferToPeers = spec.disallowTransferToPeers;
  if (spec.codeExecution) agent.codeExecution = spec.codeExecution;
  if (spec.mode) agent.mode = spec.mode;
  if (spec.outputKey !== undefined) agent.outputKey = spec.outputKey;
  if (spec.fallbackModel) agent.fallbackModel = spec.fallbackModel;
  if (spec.context) agent.context = spec.context;
  return agent;
}

/**
 * The model id a request is sent under, as ADK's LlmAgent sends it: the id
 * of the model object the resolver returned (an ADK model or a contract
 * adapter carries its own), else the id the resolver returned, else the
 * spec's. A resolver may answer a YAML id with a model under another id (a
 * gateway stand-in, a caller's alias); the adapter, the span and the
 * circuit breaker then see that id on both runtimes.
 */
export function wireModelOf(spec: Pick<AgentSpec, 'modelId' | 'resolvedModel'>): string | undefined {
  const resolved = spec.resolvedModel;
  if (typeof resolved === 'string' && resolved) return resolved;
  const own = resolved && typeof resolved === 'object' ? (resolved as { model?: unknown }).model : undefined;
  if (typeof own === 'string' && own) return own;
  return spec.modelId;
}

/** A syndicate's orchestrator for the native loop: compileSpec, then compileNative. */
export async function compileNativeGraph(config: SyndicateYamlConfig, opts: CompileOptions = {}): Promise<NativeAgent> {
  return compileNative(await compileSpec(config, opts));
}

/** A workflow syndicate for the native walk (lib/workflow/turn.ts): its graph, every agent by YAML name, and the tool nodes' lookup. */
export interface NativeWorkflow {
  name: string;
  description: string;
  graph: WorkflowGraph;
  agents: Map<string, NativeAgent>;
  resolveTool: (name: string) => unknown;
  /** The nodes that are a nested workflow syndicate, each compiled the same way, by YAML name (ADR 0106). */
  workflows: Map<string, NativeWorkflow>;
}

/**
 * A workflow spec for the native walk: the graph, every agent compiled for
 * native from the same specs ADK's assembleWorkflow builds its agents from,
 * and the registry's lookup for tool nodes. A tool node ADK's compile
 * refuses (an unregistered or long-running tool) is refused here, before
 * any model call, with ADK's message.
 */
export function compileNativeWorkflow(spec: WorkflowSpec): NativeWorkflow {
  const graph = buildWorkflowGraph(spec.config);
  const agents = new Map<string, NativeAgent>();
  for (const { yaml, spec: agentSpec } of spec.agents) agents.set(yaml.name, compileNative(agentSpec));
  const workflows = new Map<string, NativeWorkflow>();
  for (const { yaml, workflow } of spec.workflows) workflows.set(yaml.name, compileNativeWorkflow(workflow));
  refuseUnrunnableNodes(graph, spec.resolveTool);
  return { name: spec.name, description: spec.description, graph, agents, resolveTool: spec.resolveTool, workflows };
}

/**
 * A nested workflow as the delegated subagent the native loop calls (ADR
 * 0098): one call walks the whole graph with runNativeWorkflow on the child
 * session lib/runtime/native/delegate.ts opened, as ADK's AgentTool runs a
 * Workflow on its own Runner.
 */
export function workflowSubagentOf(workflow: NativeWorkflow): WorkflowSubagent {
  return {
    name: workflow.name,
    ...(workflow.description ? { description: workflow.description } : {}),
    walk: (run) =>
      runNativeWorkflow({
        graph: workflow.graph,
        agents: workflow.agents,
        resolveTool: workflow.resolveTool,
        workflows: workflow.workflows,
        sessions: run.sessions,
        appName: run.appName,
        userId: run.userId,
        sessionId: run.sessionId,
        userParts: run.userParts,
        adapterFor: run.adapterFor,
        selfCorrection: run.selfCorrection,
        stream: false,
        ...(run.signal ? { signal: run.signal } : {}),
        ...(run.memory ? { memory: run.memory } : {}),
        ...(run.log ? { log: run.log } : {}),
        ...(run.credentials ? { credentials: run.credentials } : {}),
      }),
  };
}

/** One subagent entry (a dispatch route) for the native loop: compileSubagentSpec, then compileNative. */
export async function compileNativeSubagent(subCfg: SubagentYamlConfig, opts: CompileOptions = {}): Promise<NativeAgent> {
  return compileNative(await compileSubagentSpec(subCfg, opts));
}

/** What nativeAdapterFor reads from a spec: its model resolution, the other ids it calls, and its delegated subagents. */
type NativeModelSpec = Pick<AgentSpec, 'modelId' | 'resolvedModel'> & Partial<Pick<AgentSpec, 'name' | 'fallbackModel' | 'context' | 'tools'>>;

function isModelAdapter(value: unknown): value is ModelAdapter {
  return !!value && typeof value === 'object' && typeof (value as ModelAdapter).generate === 'function' && typeof (value as ModelAdapter).model === 'string';
}

/**
 * The contract adapter behind what a resolver returned: an ADK shim's own
 * adapter; for an ADK class that is not a shim (TracedGemini, ADK's Gemini)
 * the registry's adapter under the key the instance carries, so a caller's
 * BYOK key still pays for the call; else the registry's for the id.
 */
function adapterOf(resolved: unknown, model: string): ModelAdapter {
  if (isModelAdapter(resolved)) return resolved;
  refuseModelClass(resolved, model, 'the native runtime');
  if (typeof resolved === 'string') return resolveAdapter(resolved || model);
  if (!resolved || typeof resolved !== 'object') return resolveAdapter(model);
  const held = resolved as { adapter?: unknown; apiKey?: unknown; vertexai?: unknown };
  // On ADK a shim declares the toolsDict, the reflection tool included, whatever its adapter (ADR 0097).
  if (isModelAdapter(held.adapter)) return servedThroughShim(held.adapter);
  // On Vertex AI the client authenticates with the platform's credentials, never a key (ADR 0023).
  if (typeof held.apiKey === 'string' && held.apiKey && held.vertexai !== true) {
    return resolveAdapter(model, { apiKey: held.apiKey, keyProvider: providerForModel(model) });
  }
  return resolveAdapter(model);
}

/**
 * The loop's `adapterFor` under the same model resolution the ADK runtime
 * uses: the leaf adapter behind what CompileOptions.resolveModel returns
 * (an ADK shim carries its contract adapter, so a caller's BYOK key on a
 * shimmed provider reaches the call), else resolveAdapter for the id
 * (lib/models/registry.ts). The spec's own resolution, and each delegated
 * subagent's, is reused for the id its agent runs under (wireModelOf).
 * Each agent's `fallback_model:` and compaction `summary_model` are
 * resolved here, as compileAdk resolves them at compile time, so a model
 * class native cannot run is refused before any model call; any other id
 * is resolved when first asked for. Each is kept.
 */
export function nativeAdapterFor(opts: CompileOptions = {}, spec?: NativeModelSpec | readonly NativeModelSpec[]): (model: string) => ModelAdapter {
  const cache = new Map<string, ModelAdapter>();
  const known = new Map<string, unknown>();
  const learn = (s: NativeModelSpec): void => {
    if (s.resolvedModel !== undefined) {
      for (const id of [wireModelOf(s), s.modelId]) if (id && !known.has(id)) known.set(id, s.resolvedModel);
    }
    for (const id of [s.fallbackModel, s.context?.summary_model]) {
      if (!id || known.has(id) || !opts.resolveModel) continue;
      const resolved = opts.resolveModel(id);
      refuseModelClass(resolved, id, s.name ?? 'the native runtime');
      known.set(id, resolved);
    }
    for (const entry of s.tools ?? []) {
      if (entry.kind === 'agent') learn(entry.agent);
      // A nested workflow's agents run under the caller's lookup (ADR 0098).
      else if (entry.kind === 'workflow') for (const node of workflowAgentSpecs(entry.workflow)) learn(node);
    }
  };
  // A workflow's agents share one lookup: every node's spec is learned.
  for (const s of spec === undefined ? [] : Array.isArray(spec) ? spec : [spec as NativeModelSpec]) learn(s);
  return (model: string) => {
    const held = cache.get(model);
    if (held) return held;
    const resolved = known.has(model) ? known.get(model) : opts.resolveModel ? opts.resolveModel(model) : model;
    const adapter = adapterOf(resolved, model);
    cache.set(model, adapter);
    return adapter;
  };
}
