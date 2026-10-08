/**
 * lib/compileAdk.ts — an AgentSpec as the ADK runtime runs it: today's
 * LlmAgent (ADR 0045, ADR 0073).
 *
 * WHY this file exists:
 *   lib/compile.ts turns a YAML agent into a runtime-neutral AgentSpec: its
 *   tools resolved and gated, its instruction with the skills index, its
 *   model resolved once and its generateContentConfig built for that model.
 *   This file adds what only ADK's LlmAgent takes: the model wrapped in a
 *   FallbackLlm for `fallback_model:`, each delegated subagent as an
 *   AgentTool (a remote one as its A2A tool), Gemini's code executor, the
 *   context compactor, task mode and a workflow node's settings. Every field
 *   reaches LlmAgent as compileGraph and compileSubagent always passed it, so
 *   the ADK runtime runs the agent it ran before the split.
 *   lib/compileNative.ts builds the native loop's agent from the same spec.
 *
 * Imports from lib/compile.ts are types only, so the two modules load in
 * either order.
 */

import { AgentTool, BaseLlm, BuiltInCodeExecutor, LLMRegistry, LlmAgent, LlmSummarizer, LogLevel, TokenBasedContextCompactor, setLogLevel as setAdkLogLevel } from '@google/adk';

import { remoteAgentTool } from './a2a/remoteAgent.ts';
import type { AgentSpec, CompileOptions, ContextConfig } from './compile.ts';
import { FallbackLlm } from './models/fallback.ts';
import { resolveModel as resolveRegistryModel } from './models/registry.ts';
import { onLogLevel } from './runtime/logging.ts';
import type { LogLevelName } from './runtime/logging.ts';
import { DEFAULT_KEEP_RECENT_EVENTS } from './runtime/native/compaction.ts';

/**
 * ADK's logger follows the engine's level (lib/runtime/logging.ts, ADR
 * 0080), so a surface sets one level and never names ADK to quiet it.
 */
const ADK_LOG_LEVELS: Record<LogLevelName, LogLevel> = {
  debug: LogLevel.DEBUG,
  info: LogLevel.INFO,
  warn: LogLevel.WARN,
  error: LogLevel.ERROR,
};
onLogLevel((level) => setAdkLogLevel(ADK_LOG_LEVELS[level]));

/** Events kept verbatim after a compaction summary when `context:` names none: the native compactor's default. */
export { DEFAULT_KEEP_RECENT_EVENTS };

/**
 * The LlmAgent fields a YAML agent may set beyond model, instruction, tools
 * and schemas. The schema reference (config/agents/syndicateSchema.yaml)
 * documents each as mapping 1:1 to its ADK counterpart. Only fields the YAML
 * sets are passed, so ADK's defaults stay in force otherwise.
 */
function passthroughFields(spec: AgentSpec): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (spec.includeContents !== undefined) out.includeContents = spec.includeContents;
  if (spec.outputKey !== undefined) out.outputKey = spec.outputKey;
  if (spec.globalInstruction !== undefined) out.globalInstruction = spec.globalInstruction;
  if (spec.disallowTransferToParent !== undefined) out.disallowTransferToParent = spec.disallowTransferToParent;
  if (spec.disallowTransferToPeers !== undefined) out.disallowTransferToPeers = spec.disallowTransferToPeers;
  return out;
}

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
  cfg: { model?: string; codeExecution?: 'gemini'; context?: ContextConfig; mode?: 'task' },
  opts: CompileOptions,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (cfg.codeExecution === 'gemini') out.codeExecutor = new BuiltInCodeExecutor();
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
 * An agent with `fallback_model:` gets its model wrapped (lib/models/fallback.ts):
 * the fallback answers a provider-side failure, and a provider that keeps
 * failing is skipped for a cooldown. A model id string is resolved to its
 * adapter first, so the wrapper always holds two adapters.
 */
function withFallback(primary: unknown, fallbackId: string | undefined, opts: CompileOptions): unknown {
  if (!fallbackId) return primary;
  const resolve = opts.resolveModel ?? ((m) => m);
  const asLlm = (m: unknown): BaseLlm => (m instanceof BaseLlm ? m : resolveRegistryModel(String(m)));
  return new FallbackLlm(asLlm(primary), asLlm(resolve(fallbackId)), opts.log ?? ((m) => console.warn(m)));
}

/** The spec's tools as LlmAgent takes them: a delegated subagent as an AgentTool, a remote one as its A2A tool. */
function adkTools(spec: AgentSpec, opts: CompileOptions): unknown[] {
  return spec.tools.map((entry) => {
    switch (entry.kind) {
      case 'tool':
        return entry.tool;
      case 'agent':
        return new AgentTool({ agent: compileAdk(entry.agent, opts) });
      case 'remote':
        return remoteAgentTool({ name: entry.name, description: entry.description, url: entry.url });
    }
  });
}

/**
 * The LlmAgent for `spec`. `extra` is spread last: a workflow node's
 * settings (CompileOptions.nodeConfig), which compileSubagent passes.
 */
export function compileAdk(spec: AgentSpec, opts: CompileOptions = {}, extra: Record<string, unknown> = {}): LlmAgent {
  const tools = adkTools(spec, opts);
  return new LlmAgent({
    name: spec.name,
    description: spec.description,
    model: withFallback(spec.resolvedModel, spec.fallbackModel, opts) as any,
    instruction: spec.instruction,
    tools: tools.length > 0 ? (tools as any[]) : undefined,
    outputSchema: spec.outputSchema as any,
    generateContentConfig: spec.generateContentConfig as any,
    ...passthroughFields(spec),
    ...executionFields(spec, opts),
    ...extra,
  });
}
