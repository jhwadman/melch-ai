/**
 * Shared compiler invariants — fully offline, no API keys, no network.
 *
 * lib/compile.ts is the one place a YAML syndicate becomes an ADK agent
 * graph; the A2A server and the observatory both call it. These tests pin
 * the contract both depend on: every shipped YAML compiles, DELEGATE mode
 * wraps subagents as tools, PLAN-DISPATCH compiles a tool-less classifier
 * while its routes still compile individually, nested yaml_reference
 * entries go through the injected loader, and model resolution is the
 * caller's business. Then the compile split (ADR 0073): one AgentSpec
 * builds ADK's LlmAgent and the native loop's NativeAgent, which send the
 * same first request; the runtime flag; and what native refuses at compile
 * time.
 */
process.env.OTEL_CONSOLE_SPANS = 'false';

import { test } from 'node:test';
import assert from 'node:assert';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { AgentTool, InMemorySessionService, LlmAgent, Runner } from '@google/adk';
import { z } from 'zod';
import { compileGraph, compileSpec, compileSubagent, compileSubagentSpec } from '../lib/compile.ts';
import { compileAdk } from '../lib/compileAdk.ts';
import { compileNative, nativeAdapterFor } from '../lib/compileNative.ts';
import type { SyndicateYamlConfig } from '../lib/loadSyndicate.ts';
import { ClaudeAdapter } from '../lib/models/claudeAdapter.ts';
import type { ModelRequest } from '../lib/models/contract.ts';
import { GatewayAdapter } from '../lib/models/gatewayAdapter.ts';
import { subagentOf } from '../lib/runtime/native/delegate.ts';
import { SelfCorrection } from '../lib/runtime/native/selfCorrection.ts';
import { runNativeAgent } from '../lib/runtime/nativeTurn.ts';
import { UnsupportedOnRuntimeError, chooseRuntime, runtimeSetting } from '../lib/runtime/runtimeFlag.ts';
import { InProcessSessionService } from '../lib/runtime/sessions.ts';
import { createTurnControl, runWithTurnControl } from '../lib/runtime/turnControl.ts';
import { registerTool } from '../lib/toolRegistry.ts';
import { defineTool } from '../lib/tools/toolContract.ts';
import { ScriptedModel, answer, shimResolver } from './helpers/scriptedModel.ts';
import { ClaudeLlm } from '../lib/models/claudeLlm.ts';
import { loadSyndicate } from '../lib/loadSyndicate.ts';
import { isDispatchSyndicate } from '../lib/dispatch.ts';
import { compileWorkflow, isWorkflowSyndicate } from '../lib/workflow.ts';

const agentDirectory = join(process.cwd(), 'config', 'agents');
const agentFiles = readdirSync(agentDirectory, { recursive: true })
  .map(String)
  .filter((f) => f.endsWith('.yaml') && !f.endsWith('syndicateSchema.yaml'))
  .sort();

// MCP-backed subagents open a live connection to enumerate tools, which
// both needs a server and keeps the event loop alive; they are covered by
// the offline validation in agents.test.ts. The walk follows yaml_reference
// so a syndicate that NESTS an MCP syndicate is skipped too.
function usesMcp(filename: string, seen = new Set<string>()): boolean {
  if (seen.has(filename)) return false;
  seen.add(filename);
  const config = loadSyndicate(filename);
  return (config.subagents ?? []).some(
    (s) => !!s.mcp_server_url || (!!s.yaml_reference && usesMcp(s.yaml_reference, seen)),
  );
}

test('every shipped syndicate compiles into an ADK agent graph', async (t) => {
  for (const filename of agentFiles) {
    if (usesMcp(filename)) continue;
    await t.test(`${filename} compiles`, async () => {
      const config = loadSyndicate(filename);
      if (isWorkflowSyndicate(config)) {
        // A graph: every agent a node, compiled by lib/workflow.ts.
        const { workflow, agents } = await compileWorkflow(config);
        assert.strictEqual(workflow.name, config.syndicate_name);
        assert.ok(agents.get(config.orchestrator.name) instanceof LlmAgent, 'the orchestrator is a node');
        await assert.rejects(compileGraph(config), /compileWorkflow/);
        return;
      }
      const root = await compileGraph(config);
      assert.ok(root instanceof LlmAgent, 'root is an LlmAgent');
      assert.strictEqual(root.name, config.orchestrator.name);
    });
  }
});

test('DELEGATE mode attaches every subagent as an AgentTool', async () => {
  const config = loadSyndicate('delegation.yaml');
  assert.strictEqual(isDispatchSyndicate(config), false);
  const root = await compileGraph(config);
  const tools = (root as any).tools ?? [];
  const agentTools = tools.filter((tool: unknown) => tool instanceof AgentTool);
  assert.strictEqual(agentTools.length, config.subagents.length);
  const names = agentTools.map((tool: any) => tool.name).sort();
  assert.deepStrictEqual(names, config.subagents.map((s) => s.name).sort());
});

test('PLAN-DISPATCH compiles a tool-less classifier; routes compile on their own', async () => {
  const config = loadSyndicate('research.yaml');
  assert.strictEqual(isDispatchSyndicate(config), true);
  const router = await compileGraph(config);
  const routerTools = (router as any).tools ?? [];
  assert.strictEqual(
    routerTools.filter((tool: unknown) => tool instanceof AgentTool).length,
    0,
    'a dispatch classifier must hold no subagent tools (ADK forbids outputSchema + AgentTool)',
  );
  assert.ok((router as any).outputSchema, 'the classifier carries its route schema');

  for (const sub of config.subagents) {
    const agent = await compileSubagent(sub);
    assert.ok(agent instanceof LlmAgent, `${sub.name} compiles`);
    assert.strictEqual(agent.name, sub.name);
  }
});

test('nested yaml_reference entries load through the injected loader', async () => {
  const config = loadSyndicate('research_brief.yaml');
  const ref = config.subagents.find((s) => s.yaml_reference);
  assert.ok(ref, 'fixture has a yaml_reference subagent');
  const seen: string[] = [];
  const agent = await compileSubagent(ref!, {
    loadNested: (file) => {
      seen.push(file);
      return loadSyndicate(file);
    },
  });
  assert.deepStrictEqual(seen, [ref!.yaml_reference]);
  // The nested graph answers under the PARENT's entry name and description.
  assert.strictEqual(agent.name, ref!.name);
  assert.strictEqual(agent.description, ref!.description);
});

test('model resolution is injected, not assumed', async () => {
  const config = loadSyndicate('delegation.yaml');
  const resolved: Array<string | undefined> = [];
  await compileGraph(config, {
    resolveModel: (model) => {
      resolved.push(model);
      return model;
    },
  });
  // Orchestrator plus every subagent, each resolved exactly once.
  assert.strictEqual(resolved.length, 1 + config.subagents.length);
  assert.ok(resolved.includes(config.orchestrator.model));
});

test('unknown tool names are reported, never thrown', async () => {
  const config = loadSyndicate('delegation.yaml');
  config.orchestrator.tools = ['no_such_tool'];
  const unknown: string[] = [];
  await compileGraph(config, { onUnknownTool: (name) => unknown.push(name) });
  assert.deepStrictEqual(unknown, ['no_such_tool']);
});

test('documented LlmAgent fields reach the compiled agent', async () => {
  const config = {
    syndicate_name: 'Passthrough',
    orchestrator: {
      name: 'Root',
      model: 'gemini-3.5-flash-lite',
      instruction: 'x',
      globalInstruction: 'Be kind.',
      includeContents: 'none',
      outputKey: 'root_out',
    },
    subagents: [{ name: 'Sub', model: 'gemini-3.5-flash-lite', instruction: 'y', includeContents: 'none', disallowTransferToPeers: true }],
  } as any;
  const root = (await compileGraph(config)) as any;
  assert.strictEqual(root.includeContents, 'none');
  assert.strictEqual(root.outputKey, 'root_out');
  assert.strictEqual(root.globalInstruction, 'Be kind.');
  const sub = (await compileSubagent(config.subagents[0])) as any;
  assert.strictEqual(sub.includeContents, 'none');
  assert.strictEqual(sub.disallowTransferToPeers, true);
});

test('reasoning compiles to the field each provider reads; an agent without it compiles as before (ADR 0047)', async () => {
  const toolConfig = { includeServerSideToolInvocations: true };
  const config = {
    syndicate_name: 'Reasoning',
    orchestrator: { name: 'Root', model: 'gemini-3.8-flash', instruction: 'x', reasoning: 'low', generateContentConfig: { maxOutputTokens: 512 } },
    subagents: [
      { name: 'Claude', description: 'c', model: 'claude-sonnet-4-6', instruction: 'y', reasoning: 'high' },
      { name: 'Older', description: 'o', model: 'gemini-3.8-flash', instruction: 'y', generateContentConfig: { thinkingConfig: { thinkingLevel: 'MEDIUM', includeThoughts: false } } },
      { name: 'Plain', description: 'p', model: 'gpt-5-mini', instruction: 'y' },
    ],
  } as any;
  const root = (await compileGraph(config)) as any;
  assert.deepStrictEqual(root.generateContentConfig, { maxOutputTokens: 512, reasoningEffort: 'low', thinkingConfig: { thinkingLevel: 'LOW' }, toolConfig });
  const compiled = async (i: number) => ((await compileSubagent(config.subagents[i])) as any).generateContentConfig;
  assert.deepStrictEqual(await compiled(0), { reasoningEffort: 'high', thinkingConfig: { thinkingBudget: 16384 }, toolConfig });
  // Neither key, or only the older spelling: exactly what compiled before.
  assert.deepStrictEqual(await compiled(1), { thinkingConfig: { thinkingLevel: 'MEDIUM', includeThoughts: false }, toolConfig });
  assert.deepStrictEqual(await compiled(2), { toolConfig });
});

test('reasoning maps for the model the resolver picks, and refuses the older spelling beside it', async () => {
  // A subagent with no model runs on whatever the resolver returns (on the server, a BYOK adapter).
  const inherit = { name: 'Inherit', description: 'i', instruction: 'y', reasoning: 'medium' } as any;
  const viaInstance = (await compileSubagent(inherit, { resolveModel: () => new ClaudeLlm({ model: 'claude-sonnet-4-6' }) })) as any;
  assert.deepStrictEqual(viaInstance.generateContentConfig.thinkingConfig, { thinkingBudget: 8192 });
  const viaString = (await compileSubagent(inherit, { resolveModel: () => 'kimi-k3' })) as any;
  assert.strictEqual(viaString.generateContentConfig.reasoningEffort, 'high');
  assert.ok(!('thinkingConfig' in viaString.generateContentConfig));

  // A config built in code skips the loader; the compiler refuses the clash itself.
  const both = { name: 'Both', description: 'b', model: 'gpt-5-mini', instruction: 'y', reasoning: 'low', generateContentConfig: { reasoningEffort: 'high' } } as any;
  await assert.rejects(compileSubagent(both), /Both: reasoning cannot be combined with generateContentConfig\.reasoningEffort/);
});

test('the intake template is stateless as its header promises', async () => {
  const config = loadSyndicate('intake_extractor.yaml');
  const root = (await compileGraph(config)) as any;
  assert.strictEqual(root.includeContents, 'none');
});

// ── One spec, two runtimes (WS2-10, ADR 0073) ────────────────────────────────

registerTool(
  'compile_split_lookup',
  defineTool({ name: 'compile_split_lookup', description: 'Look a key up.', schema: z.object({ key: z.string() }), execute: async ({ key }) => `found ${key}` }),
  { override: true },
);

/** A fixture with every field both builders read: tools of each kind, examples, a skill, reasoning, a schema beside tools. */
const splitFixture = (): SyndicateYamlConfig =>
  ({
    syndicate_name: 'Split',
    orchestrator: {
      name: 'Grader',
      description: 'Grades answers',
      model: 'scripted/grader',
      fallback_model: 'scripted/backup',
      instruction: 'Look the key up, then grade. Topic: {topic?}.',
      globalInstruction: 'Be fair.',
      tools: ['compile_split_lookup', 'web_search', 'load_memory'],
      examples: [{ input: 'grade 1', output: '{"verdict":"pass"}' }],
      skills: { dir: join(process.cwd(), 'tests', 'fixtures', 'skills') },
      reasoning: 'low',
      generateContentConfig: { temperature: 0.2, maxOutputTokens: 512 },
      outputSchema: { type: 'object', properties: { verdict: { type: 'string' } }, required: ['verdict'] },
      outputKey: 'grade',
      includeContents: 'default',
    },
    subagents: [],
  }) as unknown as SyndicateYamlConfig;

test('one AgentSpec compiles on both paths, and the two agents send the same first request', async () => {
  const requests: Record<string, ModelRequest[]> = {};
  const modelsFor = (runtime: string) => {
    const grader = new ScriptedModel('scripted/grader', (req) => {
      (requests[runtime] ??= []).push(req);
      return answer('{"verdict":"pass"}');
    });
    return { grader, backup: new ScriptedModel('scripted/backup', () => answer('{"verdict":"backup"}')) };
  };
  const adkModels = modelsFor('adk');
  const nativeModels = modelsFor('native');
  const message = { role: 'user', parts: [{ text: 'grade alpha' }] };

  // ADK: the spec's LlmAgent under ADK's Runner.
  const adkOpts = { resolveModel: shimResolver(adkModels), log: () => {} };
  const adkSpec = await compileSpec(splitFixture(), adkOpts);
  const adkAgent = compileAdk(adkSpec, adkOpts);
  assert.ok(adkAgent instanceof LlmAgent);
  const adkSessions = new InMemorySessionService();
  await adkSessions.createSession({ appName: 'split', userId: 'u1', sessionId: 's1' });
  const runner = new Runner({ agent: adkAgent, appName: 'split', sessionService: adkSessions });
  for await (const _ of runner.runAsync({ userId: 'u1', sessionId: 's1', newMessage: message as any }));

  // Native: the same fixture's spec as the loop's NativeAgent.
  const nativeOpts = { resolveModel: shimResolver(nativeModels), log: () => {} };
  const nativeSpec = await compileSpec(splitFixture(), nativeOpts);
  const nativeAgent = compileNative(nativeSpec);
  assert.equal(nativeAgent.model, 'scripted/grader');
  assert.equal(nativeAgent.fallbackModel, 'scripted/backup');
  assert.equal(nativeAgent.outputKey, 'grade');
  const sessions = new InProcessSessionService();
  await sessions.create({ appName: 'split', userId: 'u1', sessionId: 's1' });
  const control = createTurnControl();
  await runWithTurnControl(control, async () => {
    for await (const _ of runNativeAgent({
      agent: nativeAgent,
      adapterFor: nativeAdapterFor(nativeOpts, nativeSpec),
      sessions,
      appName: 'split',
      userId: 'u1',
      sessionId: 's1',
      userParts: message.parts,
      // The Runner above installs no reflect-and-retry plugins: self-correction off on both sides.
      selfCorrection: new SelfCorrection({ model_errors: 0, tool_errors: 0 }),
    }));
  });
  control.dispose();

  const strip = ({ signal: _signal, ...rest }: ModelRequest) => rest;
  const adkFirst = requests.adk?.[0];
  const nativeFirst = requests.native?.[0];
  assert.ok(adkFirst && nativeFirst, 'both runtimes called the model');
  assert.deepStrictEqual(strip(nativeFirst), strip(adkFirst));
  assert.deepStrictEqual(nativeFirst.tools?.map((t) => t.name), ['compile_split_lookup', 'load_memory', 'load_skill', 'load_skill_resource', 'set_model_response']);
  assert.match(nativeFirst.system ?? '', /Be fair\.[\s\S]*<available_skills>[\s\S]*<EXAMPLES>/);
  assert.strictEqual(adkModels.backup.calls + nativeModels.backup.calls, 0);
});

test('native adapters follow the resolver: a shim’s own adapter, and a BYOK key an ADK instance carries', () => {
  const grader = new ScriptedModel('scripted/grader', () => answer('x'));
  assert.strictEqual(nativeAdapterFor({ resolveModel: shimResolver({ grader }) })('scripted/grader'), grader);

  // No Anthropic key in the environment, a gateway configured: only a key the instance carries routes direct.
  const keys = ['ANTHROPIC_API_KEY', 'MODEL_GATEWAY', 'MODEL_GATEWAY_API_KEY', 'ANTHROPIC_PLATFORM'] as const;
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  try {
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_PLATFORM;
    process.env.MODEL_GATEWAY = 'vercel';
    process.env.MODEL_GATEWAY_API_KEY = 'fixture-gateway-key-0123';
    const model = 'claude-sonnet-4-6';
    const withKey = nativeAdapterFor({ resolveModel: () => ({ model, apiKey: 'fixture-byok-key-0123' }) as any })(model);
    assert.ok(withKey instanceof ClaudeAdapter, 'the carried key pays: the direct adapter');
    const withoutKey = nativeAdapterFor({ resolveModel: () => ({ model }) as any })(model);
    assert.ok(withoutKey instanceof GatewayAdapter, 'no key carried: the environment decides');
  } finally {
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
});

test('the runtime flag: the turn option wins, then MELCHIZEDEK_RUNTIME, then adk', () => {
  assert.strictEqual(chooseRuntime(undefined, {}), 'adk');
  assert.strictEqual(chooseRuntime(undefined, { MELCHIZEDEK_RUNTIME: 'native' }), 'native');
  assert.strictEqual(chooseRuntime(undefined, { MELCHIZEDEK_RUNTIME: ' Native ' }), 'native');
  assert.strictEqual(chooseRuntime(undefined, { MELCHIZEDEK_RUNTIME: '' }), 'adk');
  assert.strictEqual(chooseRuntime('adk', { MELCHIZEDEK_RUNTIME: 'native' }), 'adk');
  assert.strictEqual(chooseRuntime('native', {}), 'native');
  assert.strictEqual(runtimeSetting({}), undefined);
  assert.throws(() => chooseRuntime(undefined, { MELCHIZEDEK_RUNTIME: 'langgraph' }), /MELCHIZEDEK_RUNTIME must be "adk" or "native"/);
  assert.throws(() => chooseRuntime('loop', {}), /must be "adk" or "native"/);
});

test('a delegation compiles both ways: an AgentTool on ADK, a subagentTool holding the subagent’s NativeAgent on native', async () => {
  const config = loadSyndicate('delegation.yaml');
  const spec = await compileSpec(config);
  const delegated = spec.tools.filter((t) => t.kind === 'agent');
  assert.deepStrictEqual(delegated.map((t) => (t.kind === 'agent' ? t.agent.name : '')), config.subagents.map((s) => s.name));
  const adk = compileAdk(spec);
  assert.deepStrictEqual((adk.tools ?? []).filter((t) => t instanceof AgentTool).map((t: any) => t.name), config.subagents.map((s) => s.name));
  const native = compileNative(spec);
  const subagents = (native.tools ?? []).map((t) => subagentOf(t)).filter((a) => a !== undefined);
  assert.deepStrictEqual(subagents.map((a) => a!.name), config.subagents.map((s) => s.name));
  assert.strictEqual(subagents[0]!.model, config.subagents[0]!.model, 'each subagent is its own compiled NativeAgent');
});

test('a feature native does not run yet fails at compile time, naming the feature and the runtime', async () => {
  const base = { name: 'Solo', description: 'd', model: 'gemini-3.5-flash-lite', instruction: 'x' };
  const compaction = await compileSubagentSpec({ ...base, context: { compact_after_tokens: 1000 } } as any);
  assert.throws(
    () => compileNative(compaction),
    (e: unknown) => e instanceof UnsupportedOnRuntimeError && e.runtime === 'native' && /Solo: context compaction \(context:, WS2-9\) is not supported on the native runtime yet/.test(e.message),
  );
  // Task mode runs on native (WS3-5): the spec builds both ways, mode carried.
  const task = await compileSubagentSpec({ ...base, mode: 'task' } as any);
  assert.strictEqual(compileNative(task).mode, 'task');
  assert.ok(compileAdk(task) instanceof LlmAgent);
});
