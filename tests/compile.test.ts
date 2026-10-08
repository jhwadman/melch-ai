/**
 * Shared compiler invariants — fully offline, no API keys, no network.
 *
 * lib/compile.ts is the one place a YAML syndicate becomes an AgentSpec,
 * and lib/compileNative.ts the place a spec becomes the native loop's
 * NativeAgent; the A2A server and the observatory both call them. These
 * tests pin the contract both depend on: every shipped YAML compiles,
 * PLAN-DISPATCH compiles a tool-less classifier while its routes still
 * compile individually, nested yaml_reference entries go through the
 * injected loader, and model resolution is the caller's business. Then the
 * compile split (ADR 0073): the NativeAgent sends the first request ADK
 * 2.2's LlmAgent sent for the same spec (recorded); the runtime flag; and
 * what native refuses at compile time.
 */
process.env.OTEL_CONSOLE_SPANS = 'false';

import { test } from 'node:test';
import assert from 'node:assert';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { compileSpec, compileSubagentSpec, compileWorkflowSpec } from '../lib/compile.ts';
import { compileNative, compileNativeGraph, compileNativeSubagent, compileNativeWorkflow, nativeAdapterFor } from '../lib/compileNative.ts';
import type { SyndicateYamlConfig } from '../lib/loadSyndicate.ts';
import { ClaudeAdapter } from '../lib/models/claudeAdapter.ts';
import type { ModelRequest } from '../lib/models/contract.ts';
import { GatewayAdapter } from '../lib/models/gatewayAdapter.ts';
import { subagentOf } from '../lib/runtime/native/delegate.ts';
import { SelfCorrection } from '../lib/runtime/native/selfCorrection.ts';
import { runNativeAgent } from '../lib/runtime/nativeTurn.ts';
import { DEFAULT_RUNTIME, RUNTIMES, RuntimeRemovedError, chooseRuntime, describeRuntime, runtimeSetting } from '../lib/runtime/runtimeFlag.ts';
import { InProcessSessionService } from '../lib/runtime/sessions.ts';
import { createTurnControl, runWithTurnControl } from '../lib/runtime/turnControl.ts';
import { registerTool } from '../lib/toolRegistry.ts';
import { defineTool } from '../lib/tools/toolContract.ts';
import { ScriptedModel, answer, shimResolver } from './helpers/scriptedModel.ts';
import { loadSyndicate } from '../lib/loadSyndicate.ts';
import { isDispatchSyndicate } from '../lib/dispatch.ts';
import { isWorkflowSyndicate } from '../lib/workflow.ts';
import { adkReferences, canonical } from './helpers/adkReference.ts';

// The recorded side of the one-spec case: the first request ADK 2.2's LlmAgent sent for the same spec
// under ADK's Runner (tests/fixtures/adk-reference/compile).
const reference = adkReferences('compile');

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

test('every shipped syndicate compiles into a native agent graph', async (t) => {
  for (const filename of agentFiles) {
    if (usesMcp(filename)) continue;
    await t.test(`${filename} compiles`, async () => {
      const config = loadSyndicate(filename);
      if (isWorkflowSyndicate(config)) {
        // A graph: every agent a node, compiled by compileWorkflowSpec.
        const workflow = compileNativeWorkflow(await compileWorkflowSpec(config));
        assert.strictEqual(workflow.name, config.syndicate_name);
        assert.ok(workflow.agents.get(config.orchestrator.name), 'the orchestrator is a node');
        await assert.rejects(compileSpec(config), /compileWorkflowSpec/);
        return;
      }
      const root = await compileNativeGraph(config);
      assert.strictEqual(root.name, config.orchestrator.name);
    });
  }
});

test('PLAN-DISPATCH compiles a tool-less classifier; routes compile on their own', async () => {
  const config = loadSyndicate('research.yaml');
  assert.strictEqual(isDispatchSyndicate(config), true);
  const router = await compileNativeGraph(config);
  assert.strictEqual(
    (router.tools ?? []).filter((tool) => subagentOf(tool) !== undefined).length,
    0,
    'a dispatch classifier holds no subagent tools',
  );
  assert.ok(router.outputSchema, 'the classifier carries its route schema');

  for (const sub of config.subagents) {
    const agent = await compileNativeSubagent(sub);
    assert.strictEqual(agent.name, sub.name, `${sub.name} compiles`);
  }
});

test('nested yaml_reference entries load through the injected loader', async () => {
  const config = loadSyndicate('research_brief.yaml');
  const ref = config.subagents.find((s) => s.yaml_reference);
  assert.ok(ref, 'fixture has a yaml_reference subagent');
  const seen: string[] = [];
  const agent = await compileNativeSubagent(ref!, {
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
  await compileSpec(config, {
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
  await compileSpec(config, { onUnknownTool: (name) => unknown.push(name) });
  assert.deepStrictEqual(unknown, ['no_such_tool']);
});

test('documented agent fields reach the compiled agent', async () => {
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
  const root = (await compileNativeGraph(config)) as any;
  assert.strictEqual(root.includeContents, 'none');
  assert.strictEqual(root.outputKey, 'root_out');
  assert.strictEqual(root.globalInstruction, 'Be kind.');
  const sub = (await compileNativeSubagent(config.subagents[0])) as any;
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
  const root = (await compileNativeGraph(config)) as any;
  assert.deepStrictEqual(root.generateContentConfig, { maxOutputTokens: 512, reasoningEffort: 'low', thinkingConfig: { thinkingLevel: 'LOW' }, toolConfig });
  const compiled = async (i: number) => ((await compileNativeSubagent(config.subagents[i])) as any).generateContentConfig;
  assert.deepStrictEqual(await compiled(0), { reasoningEffort: 'high', thinkingConfig: { thinkingBudget: 16384 }, toolConfig });
  // Neither key, or only the older spelling: exactly what compiled before.
  assert.deepStrictEqual(await compiled(1), { thinkingConfig: { thinkingLevel: 'MEDIUM', includeThoughts: false }, toolConfig });
  assert.deepStrictEqual(await compiled(2), { toolConfig });
});

test('reasoning maps for the model the resolver picks, and refuses the older spelling beside it', async () => {
  // A subagent with no model runs on whatever the resolver returns (on the server, a BYOK adapter).
  const inherit = { name: 'Inherit', description: 'i', instruction: 'y', reasoning: 'medium' } as any;
  const viaInstance = (await compileNativeSubagent(inherit, { resolveModel: () => new ClaudeAdapter({ model: 'claude-sonnet-4-6' }) })) as any;
  assert.deepStrictEqual(viaInstance.generateContentConfig.thinkingConfig, { thinkingBudget: 8192 });
  const viaString = (await compileNativeSubagent(inherit, { resolveModel: () => 'kimi-k3' })) as any;
  assert.strictEqual(viaString.generateContentConfig.reasoningEffort, 'high');
  assert.ok(!('thinkingConfig' in viaString.generateContentConfig));

  // A config built in code skips the loader; the compiler refuses the clash itself.
  const both = { name: 'Both', description: 'b', model: 'gpt-5-mini', instruction: 'y', reasoning: 'low', generateContentConfig: { reasoningEffort: 'high' } } as any;
  await assert.rejects(compileSubagentSpec(both), /Both: reasoning cannot be combined with generateContentConfig\.reasoningEffort/);
});

test('the intake template is stateless as its header promises', async () => {
  const config = loadSyndicate('intake_extractor.yaml');
  const root = (await compileNativeGraph(config)) as any;
  assert.strictEqual(root.includeContents, 'none');
});

// ── One spec, the recorded ADK request (WS2-10, ADR 0073) ────────────────────

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

test("one AgentSpec's NativeAgent sends the first request ADK's LlmAgent sent for it (recorded)", async () => {
  const requests: Record<string, ModelRequest[]> = {};
  const modelsFor = (runtime: string) => {
    const grader = new ScriptedModel('scripted/grader', (req) => {
      (requests[runtime] ??= []).push(req);
      return answer('{"verdict":"pass"}');
    });
    return { grader, backup: new ScriptedModel('scripted/backup', () => answer('{"verdict":"backup"}')) };
  };
  const nativeModels = modelsFor('native');
  const message = { role: 'user', parts: [{ text: 'grade alpha' }] };
  const strip = ({ signal: _signal, ...rest }: ModelRequest) => rest;

  // ADK 2.2: the spec's LlmAgent under ADK's Runner (recorded: its first request, signal aside, and the backup's calls).
  const adk = await reference<{ first?: Omit<ModelRequest, 'signal'>; backupCalls: number }>('one-spec-first-request');

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
      // The recorded Runner installed no reflect-and-retry plugins: self-correction off here too.
      selfCorrection: new SelfCorrection({ model_errors: 0, tool_errors: 0 }),
    }));
  });
  control.dispose();

  const adkFirst = adk.first;
  const nativeFirst = requests.native?.[0];
  assert.ok(adkFirst && nativeFirst, 'the recording and the native run both called the model');
  // In the recording's canonical form (adkReference.ts), so any ids line up.
  assert.deepStrictEqual(canonical({ first: strip(nativeFirst), backupCalls: nativeModels.backup.calls }).first, adkFirst);
  assert.deepStrictEqual(nativeFirst.tools?.map((t) => t.name), ['compile_split_lookup', 'load_memory', 'load_skill', 'load_skill_resource', 'set_model_response']);
  assert.match(nativeFirst.system ?? '', /Be fair\.[\s\S]*<available_skills>[\s\S]*<EXAMPLES>/);
  assert.strictEqual(adk.backupCalls + nativeModels.backup.calls, 0);
});

test('native adapters follow the resolver: a scripted model’s own adapter, and a BYOK adapter the resolver returns', () => {
  const grader = new ScriptedModel('scripted/grader', () => answer('x'));
  assert.strictEqual(nativeAdapterFor({ resolveModel: shimResolver({ grader }) })('scripted/grader'), grader);

  // No Anthropic key in the environment, a gateway configured: only the adapter the resolver built with a key routes direct.
  const keys = ['ANTHROPIC_API_KEY', 'MODEL_GATEWAY', 'MODEL_GATEWAY_API_KEY', 'ANTHROPIC_PLATFORM'] as const;
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  try {
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_PLATFORM;
    process.env.MODEL_GATEWAY = 'vercel';
    process.env.MODEL_GATEWAY_API_KEY = 'fixture-gateway-key-0123';
    const model = 'claude-sonnet-4-6';
    const byok = new ClaudeAdapter({ model, apiKey: 'fixture-byok-key-0123' });
    const withKey = nativeAdapterFor({ resolveModel: () => byok })(model);
    assert.strictEqual(withKey, byok, 'the BYOK adapter pays: the direct adapter, as resolved');
    const withoutKey = nativeAdapterFor({ resolveModel: () => model })(model);
    assert.ok(withoutKey instanceof GatewayAdapter, 'an id alone: the environment decides');
  } finally {
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
});

test('the runtime flag: native is the one runtime; adk names its removal in 1.0.0 (ADR 0107)', () => {
  assert.strictEqual(DEFAULT_RUNTIME, 'native');
  assert.deepStrictEqual(RUNTIMES, ['native']);
  assert.strictEqual(chooseRuntime(undefined, {}), 'native');
  assert.strictEqual(chooseRuntime(undefined, { MELCHIZEDEK_RUNTIME: 'native' }), 'native');
  assert.strictEqual(chooseRuntime(undefined, { MELCHIZEDEK_RUNTIME: ' Native ' }), 'native');
  assert.strictEqual(chooseRuntime(undefined, { MELCHIZEDEK_RUNTIME: '' }), 'native');
  assert.strictEqual(chooseRuntime('native', {}), 'native');
  assert.throws(() => chooseRuntime(undefined, { MELCHIZEDEK_RUNTIME: 'adk' }), (err: Error) => err instanceof RuntimeRemovedError && /1\.0\.0/.test(err.message));
  assert.throws(() => chooseRuntime(undefined, { MELCHIZEDEK_RUNTIME: ' ADK ' }), RuntimeRemovedError);
  assert.throws(() => chooseRuntime('adk', { MELCHIZEDEK_RUNTIME: 'native' }), RuntimeRemovedError);
  assert.strictEqual(chooseRuntime('native', { MELCHIZEDEK_RUNTIME: 'adk' }), 'native', 'the option wins, and the environment is not read');
  assert.deepStrictEqual(describeRuntime(undefined, {}), { runtime: 'native', source: 'default' });
  assert.deepStrictEqual(describeRuntime(undefined, { MELCHIZEDEK_RUNTIME: 'native' }), { runtime: 'native', source: 'MELCHIZEDEK_RUNTIME' });
  assert.deepStrictEqual(describeRuntime('native', {}), { runtime: 'native', source: 'option' });
  assert.throws(() => describeRuntime('adk', {}), RuntimeRemovedError);
  assert.strictEqual(runtimeSetting({}), undefined);
  assert.throws(() => runtimeSetting({ MELCHIZEDEK_RUNTIME: 'adk' }), RuntimeRemovedError);
  assert.throws(() => chooseRuntime(undefined, { MELCHIZEDEK_RUNTIME: 'langgraph' }), /MELCHIZEDEK_RUNTIME must be "native"/);
  assert.throws(() => chooseRuntime('loop', {}), /must be "native"/);
});

test('a delegation compiles to a subagentTool holding the subagent’s NativeAgent', async () => {
  const config = loadSyndicate('delegation.yaml');
  assert.strictEqual(isDispatchSyndicate(config), false);
  const spec = await compileSpec(config);
  const delegated = spec.tools.filter((t) => t.kind === 'agent');
  assert.deepStrictEqual(delegated.map((t) => (t.kind === 'agent' ? t.agent.name : '')), config.subagents.map((s) => s.name));
  const native = compileNative(spec);
  const subagents = (native.tools ?? []).map((t) => subagentOf(t)).filter((a) => a !== undefined);
  assert.deepStrictEqual(subagents.map((a) => a!.name), config.subagents.map((s) => s.name));
  assert.strictEqual(subagents[0]!.model, config.subagents[0]!.model, 'each subagent is its own compiled NativeAgent');
});

test('context: and mode: task compile for the native loop', async () => {
  const base = { name: 'Solo', description: 'd', model: 'gemini-3.5-flash-lite', instruction: 'x' };
  // Task mode runs on native (WS3-5): mode carried.
  const task = await compileSubagentSpec({ ...base, mode: 'task' } as any);
  assert.strictEqual(compileNative(task).mode, 'task');
  // context: compiles for the loop, which compacts as ADK did (WS2-9).
  const compaction = await compileSubagentSpec({ ...base, context: { compact_after_tokens: 1000, keep_recent_events: 2 } } as any);
  assert.deepStrictEqual(compileNative(compaction).context, { compact_after_tokens: 1000, keep_recent_events: 2 });
});

test('a yaml_reference chain that reaches itself, or goes past 16 levels, is refused by name, never recursed until the stack gives out (WS5-5)', async () => {
  const syndicateOf = (name: string, ref?: string): SyndicateYamlConfig =>
    ({
      syndicate_name: name,
      orchestrator: { name: `${name}Boss`, model: 'scripted/boss', instruction: 'x' },
      subagents: ref ? [{ name: `${name}Sub`, description: 'd', yaml_reference: ref }] : [],
    }) as SyndicateYamlConfig;
  const opts = (files: Record<string, SyndicateYamlConfig>) => ({ loadNested: (ref: string) => files[ref] as SyndicateYamlConfig, log: () => {} });

  const self = syndicateOf('Self', 'self.yaml');
  await assert.rejects(compileSpec(self, opts({ 'self.yaml': self })), /self\.yaml: a nested syndicate reaches itself \(self\.yaml → self\.yaml\)/);

  const files = { 'a.yaml': syndicateOf('A', 'b.yaml'), 'b.yaml': syndicateOf('B', 'a.yaml') };
  await assert.rejects(compileSpec(syndicateOf('Root', 'a.yaml'), opts(files)), /a\.yaml: a nested syndicate reaches itself \(a\.yaml → b\.yaml → a\.yaml\)/);
  // A dispatch route, a single subagent entry, takes the same check.
  await assert.rejects(compileSubagentSpec({ name: 'Route', description: 'd', yaml_reference: 'a.yaml' } as never, opts(files)), /reaches itself/);

  const deep: Record<string, SyndicateYamlConfig> = {};
  for (let i = 0; i < 20; i++) deep[`d${i}.yaml`] = syndicateOf(`D${i}`, i < 19 ? `d${i + 1}.yaml` : undefined);
  await assert.rejects(compileSpec(syndicateOf('Root', 'd0.yaml'), opts(deep)), /nested syndicates go deeper than 16 levels/);

  // A chain that ends compiles, and one syndicate referenced twice side by side is no cycle.
  const twice = {
    ...syndicateOf('Root'),
    subagents: [
      { name: 'One', description: 'd', yaml_reference: 'leaf.yaml' },
      { name: 'Two', description: 'd', yaml_reference: 'leaf.yaml' },
    ],
  } as SyndicateYamlConfig;
  const spec = await compileSpec(twice, opts({ 'leaf.yaml': syndicateOf('Leaf') }));
  assert.equal(spec.tools.length, 2);
});

test('compileNative refuses an ADK tool (anything with runAsync) in a spec\'s tools, naming 1.0.0 and defineTool', () => {
  const adkTool = { name: 'legacy_lookup', description: 'An ADK FunctionTool, by shape.', runAsync: async () => 'ran' };
  assert.throws(
    () => compileNative({ name: 'Lead', model: 'scripted/lead', instruction: 'x', tools: [{ kind: 'tool', tool: adkTool }], generateContentConfig: {} }),
    (e: Error) => /compile: 'legacy_lookup' is an ADK tool/.test(e.message) && /1\.0\.0/.test(e.message) && /defineTool/.test(e.message),
  );
});
