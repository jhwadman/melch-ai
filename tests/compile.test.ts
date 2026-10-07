/**
 * Shared compiler invariants — fully offline, no API keys, no network.
 *
 * lib/compile.ts is the one place a YAML syndicate becomes an ADK agent
 * graph; the A2A server and the observatory both call it. These tests pin
 * the contract both depend on: every shipped YAML compiles, DELEGATE mode
 * wraps subagents as tools, PLAN-DISPATCH compiles a tool-less classifier
 * while its routes still compile individually, nested yaml_reference
 * entries go through the injected loader, and model resolution is the
 * caller's business.
 */
import { test } from 'node:test';
import assert from 'node:assert';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { AgentTool, LlmAgent } from '@google/adk';
import { compileGraph, compileSubagent } from '../lib/compile.ts';
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
