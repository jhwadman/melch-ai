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
 * syndicate as its orchestrator's agent; a remote A2A subagent is the own
 * Tool the ADK runtime's FunctionTool wraps (lib/a2a/remoteAgent.ts).
 *
 * WHAT THE NATIVE RUNTIME DOES NOT RUN YET fails here, at compile time,
 * with a message naming the feature and the runtime: `mode: task` (WS3-5).
 * `context:` is handed to the loop, which compacts as ADK does
 * (lib/runtime/native/compaction.ts, WS2-9). Workflows, resuming an approval or a
 * question, and a caller's agent transform are refused by the turn runner
 * (lib/runtime/nativeTurn.ts), which owns those choices.
 */

import { remoteAgentOwnTool } from './a2a/remoteAgent.ts';
import { compileSpec, compileSubagentSpec } from './compile.ts';
import type { AgentSpec, CompileOptions } from './compile.ts';
import type { SubagentYamlConfig, SyndicateYamlConfig } from './loadSyndicate.ts';
import type { ModelAdapter } from './models/contract.ts';
import { providerForModel, resolveAdapter } from './models/registry.ts';
import { subagentTool } from './runtime/native/delegate.ts';
import type { NativeAgent } from './runtime/native/request.ts';
import { unsupportedOnNative } from './runtime/runtimeFlag.ts';
export { UnsupportedOnRuntimeError, unsupportedOnNative } from './runtime/runtimeFlag.ts';
import { instructionToolOf, toolOf } from './tools/tool.ts';

/** A resolved tool as the loop holds it: the own Tool or InstructionTool behind it, else the object itself. */
function nativeTool(tool: unknown): unknown {
  return toolOf(tool) ?? instructionToolOf(tool) ?? tool;
}

/**
 * The NativeAgent for `spec`. Throws UnsupportedOnRuntimeError for what the
 * native loop does not run yet, and when no model id is known.
 */
export function compileNative(spec: AgentSpec): NativeAgent {
  const tools: unknown[] = [];
  for (const entry of spec.tools) {
    if (entry.kind === 'agent') tools.push(subagentTool(compileNative(entry.agent)));
    else if (entry.kind === 'remote') tools.push(remoteAgentOwnTool({ name: entry.name, description: entry.description, url: entry.url }));
    else tools.push(nativeTool(entry.tool));
  }
  if (spec.mode === 'task') throw unsupportedOnNative('task mode (mode: task, WS3-5)', spec.name);
  if (!spec.modelId) throw new Error(`${spec.name}: no model id to run on (the YAML names none and the resolver returned none).`);

  const agent: NativeAgent = {
    name: spec.name,
    model: spec.modelId,
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
  if (spec.outputKey !== undefined) agent.outputKey = spec.outputKey;
  if (spec.fallbackModel) agent.fallbackModel = spec.fallbackModel;
  if (spec.context) agent.context = spec.context;
  return agent;
}

/** A syndicate's orchestrator for the native loop: compileSpec, then compileNative. */
export async function compileNativeGraph(config: SyndicateYamlConfig, opts: CompileOptions = {}): Promise<NativeAgent> {
  return compileNative(await compileSpec(config, opts));
}

/** One subagent entry (a dispatch route) for the native loop: compileSubagentSpec, then compileNative. */
export async function compileNativeSubagent(subCfg: SubagentYamlConfig, opts: CompileOptions = {}): Promise<NativeAgent> {
  return compileNative(await compileSubagentSpec(subCfg, opts));
}

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
  if (typeof resolved === 'string') return resolveAdapter(resolved || model);
  if (!resolved || typeof resolved !== 'object') return resolveAdapter(model);
  const held = resolved as { adapter?: unknown; apiKey?: unknown; vertexai?: unknown };
  if (isModelAdapter(held.adapter)) return held.adapter;
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
 * (lib/models/registry.ts). The spec's own resolution is reused for its
 * model; each other id (a fallback) is resolved once and kept.
 */
export function nativeAdapterFor(opts: CompileOptions = {}, spec?: Pick<AgentSpec, 'modelId' | 'resolvedModel'>): (model: string) => ModelAdapter {
  const cache = new Map<string, ModelAdapter>();
  return (model: string) => {
    const held = cache.get(model);
    if (held) return held;
    const resolved = spec?.modelId === model && spec.resolvedModel !== undefined ? spec.resolvedModel : opts.resolveModel ? opts.resolveModel(model) : model;
    const adapter = adapterOf(resolved, model);
    cache.set(model, adapter);
    return adapter;
  };
}
