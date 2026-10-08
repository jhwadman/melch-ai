/**
 * lib/workflow.ts — the `workflow:` block: a syndicate as a graph.
 *
 * ── The third orchestration method ───────────────────────────────────────
 * DELEGATE lets an orchestrator call subagents as tools; PLAN-DISPATCH
 * (lib/dispatch.ts) lets a classifier pick ONE subagent to answer. Neither
 * can say "run these two in parallel, join their outputs, review, ask the
 * person, then publish". A `workflow:` block does: it is a graph whose
 * nodes are the syndicate's own agents plus a few node kinds the engine
 * supplies, and whose edges say what runs after what and on which route.
 *
 *   workflow:
 *     edges:
 *       - [START, Planner, { article: [Writer, Checker], answer: Answerer }]
 *       - [[Writer, Checker], Both, Editor, Confirm, Publisher]
 *     nodes:
 *       Both:    { join: true }                 # waits for every predecessor
 *       Confirm: { ask_user: "Publish? yes, or say what to change." }
 *       Planner: { route_key: "kind", retry: { max_attempts: 2 } }
 *
 * ADK 2.2 runs it (`Workflow`, `FunctionNode`, `JoinNode`, `ParallelWorker`,
 * `ToolNode`, `RequestInput`): per-node retries and timeouts, fan-out and
 * fan-in, a pause that waits for a person and resumes on the next message,
 * and resumption from the session's own events. Every agent is already a
 * node (`LlmAgent extends BaseNode`): a node agent receives the previous
 * node's output as its user turn and, unless its YAML sets
 * `includeContents`, sees nothing else of the conversation.
 *
 * ── What the engine adds to ADK ───────────────────────────────────────────
 * ROUTING. ADK's TypeScript port never derives a route from an agent's
 *   output, so a routing map in YAML gets a hidden step after the agent
 *   (`<Agent>__route`) that reads the route from the output — the
 *   `route_key` property of a JSON output, else the trimmed text — and
 *   re-emits the output with it. A `default` key catches what no key
 *   matched.
 * THE PAUSE. `ask_user` is a node that raises ADK's `RequestInput`. The
 *   turn ends `input-required` carrying the question (`result.input`); the
 *   next message on the conversation is the answer and becomes that node's
 *   output. The A2A server publishes the question; the chat prints it.
 * NAMES. Nodes are addressed by their YAML names everywhere (edges, events,
 *   the wiki), including a `map` node, which ADK would otherwise name after
 *   the agent it wraps.
 *
 * ── As a subagent (ADR 0098) ─────────────────────────────────────────────
 * A delegated `yaml_reference` to a workflow syndicate is the whole graph:
 * `assembleWorkflow` builds its Workflow under the subagent entry's name
 * and description, and lib/compileAdk.ts wraps it in ADK's AgentTool, whose
 * answer is the graph's last event's text. A nested workflow with an
 * `ask_user` node is refused by name (lib/compile.ts compileWorkflowSpec): a
 * pause inside a tool call cannot reach the caller (ADR 0028). As a dispatch
 * route or a workflow node, a workflow syndicate is still its orchestrator
 * alone.
 *
 * ── Approval gates (ADR 0098) ────────────────────────────────────────────
 * A tool in a node agent's `require_approval` pauses the node on ADK's
 * `adk_request_confirmation`, and the walk with it. Only the native walk
 * resumes it (lib/workflow/agentNode.ts): ADK's runLlmAgentAsNode reruns the
 * node from its input and never runs the pinned call, so runSyndicateTurn
 * refuses a gated workflow on ADK. The schema refuses a gate on an agent a
 * map runs (an item cannot pause the walk).
 *
 * ── Not in this version ───────────────────────────────────────────────────
 * Skill scripts (`skills.scripts: local`, an approval pause) and remote
 * `a2a_agent_url` subagents are refused inside a workflow by the schema; a
 * remote agent is reachable only as a tool. Both are open for a later
 * record.
 */

import type { BaseNode, BaseTool, EdgeItem, LlmAgent, Workflow } from '@google/adk';

import { requireAdk } from './adkPeer.ts';

import { compileWorkflowSpec } from './compile.ts';
import type { CompileOptions, WorkflowSpec } from './compile.ts';
import { compileAdk } from './compileAdk.ts';
import type { SyndicateYamlConfig } from './loadSyndicate.ts';
import { DEFAULT_ROUTE_KEY, ROUTE_STEP_SUFFIX, START_NAME, isWorkflowSyndicate, nodeKind, nodeSettings, routeOf } from './workflowConfig.ts';
export * from './workflowConfig.ts';

export interface CompiledWorkflow {
  workflow: Workflow;
  /** Every agent node by YAML name, compiled. */
  agents: Map<string, LlmAgent>;
  /** Every node by YAML name, hidden route steps excluded. */
  nodes: Map<string, BaseNode>;
}

/**
 * Compile a workflow syndicate: every agent through `compileSubagentSpec` (its
 * tools, skills and MCP server as in any mode), the declared nodes, the
 * hidden route steps, and the edge chains, into one ADK `Workflow` named
 * after the syndicate. Throws on a name the schema let through, a tool that
 * is not registered, or a graph ADK rejects (unreachable node, cycle).
 */
export async function compileWorkflow(
  config: SyndicateYamlConfig,
  opts: CompileOptions = {},
  transformAgent: (agent: LlmAgent) => LlmAgent = (a) => a,
): Promise<CompiledWorkflow> {
  if (!isWorkflowSyndicate(config)) throw new Error(`${config.syndicate_name}: no workflow block`);
  return assembleWorkflow(await compileWorkflowSpec(config, opts), opts, transformAgent);
}

/**
 * ADK's Workflow from a compiled workflow spec, synchronously: each agent
 * built by compileAdk with its node modifiers (retry, timeout) at
 * construction, then the declared nodes, route steps and edges. A nested
 * workflow (ADR 0098) is this Workflow under its subagent entry's name and
 * description, which lib/compileAdk.ts wraps in ADK's AgentTool.
 */
export function assembleWorkflow(
  spec: WorkflowSpec,
  opts: CompileOptions = {},
  transformAgent: (agent: LlmAgent) => LlmAgent = (a) => a,
): CompiledWorkflow {
  const config = spec.config;
  if (!isWorkflowSyndicate(config)) throw new Error(`${config.syndicate_name}: no workflow block`);
  // ADK's Workflow is the adk runtime's; the native walk (lib/workflow/turn.ts) needs none of this (ADR 0102).
  const { DEFAULT_ROUTE, FunctionNode, JoinNode, ParallelWorker, RequestInput, ToolNode, Workflow, createEvent } = requireAdk(
    "ADK's Workflow (a workflow syndicate on the adk runtime, compileWorkflow)",
  );
  const wf = config.workflow;
  const nodeYaml = wf.nodes ?? {};

  // Agents, with their node modifiers (retry, timeout) at construction; not on a nested syndicate's orchestrator.
  const agents = new Map<string, LlmAgent>();
  for (const { yaml, spec: agentSpec } of spec.agents) {
    const settings = yaml.yaml_reference ? {} : nodeSettings(nodeYaml[yaml.name]);
    agents.set(yaml.name, transformAgent(compileAdk(agentSpec, opts, settings)));
  }

  // Declared nodes.
  const nodes = new Map<string, BaseNode>(agents);
  for (const [name, entry] of Object.entries(nodeYaml)) {
    const kind = nodeKind(entry);
    if (!kind) continue; // modifiers on an agent
    const settings = nodeSettings(entry);
    if (kind === 'ask_user') {
      const message = entry.ask_user ?? '';
      const schema = entry.schema;
      // The node runs again on resume (rerunOnResume): ADK then hands it the
      // same input and the answers resolved so far, so its output can carry
      // BOTH the reply and what the person was asked about. A node fast-
      // forwarded by ADK would output the bare reply, and the next agent
      // would never see the draft it is meant to act on.
      nodes.set(
        name,
        new FunctionNode(
          name,
          (ctx, input) => {
            const replies = Object.values(ctx.resumeInputs);
            if (replies.length > 0) return { reply: replies[replies.length - 1], input };
            return new RequestInput({ message, payload: input, ...(schema ? { responseSchema: schema as any } : {}) });
          },
          { ...settings, rerunOnResume: true },
        ),
      );
    } else if (kind === 'join') {
      nodes.set(name, new JoinNode({ name, ...settings }));
    } else if (kind === 'map') {
      const inner = agents.get(entry.map!);
      if (!inner) throw new Error(`workflow node '${name}': map names '${entry.map}', which is not an agent of this syndicate`);
      const worker = new ParallelWorker(inner, entry.max_parallel !== undefined ? { maxParallelWorkers: entry.max_parallel } : {});
      // ADK names a worker after the agent it wraps; the YAML name is what
      // the edges, the events and the docs use.
      Object.defineProperty(worker, 'name', { value: name, enumerable: true });
      nodes.set(name, worker);
    } else if (kind === 'tool') {
      const tool = spec.resolveTool(entry.tool!);
      if (!tool) throw new Error(`workflow node '${name}': tool '${entry.tool}' is not registered`);
      nodes.set(name, new ToolNode(tool as BaseTool, { name, ...settings }));
    }
  }

  const nodeOf = (name: string): BaseNode => {
    const node = nodes.get(name);
    if (!node) throw new Error(`workflow: '${name}' is not an agent or a declared node of this syndicate`);
    return node;
  };
  const routeSteps = new Map<string, BaseNode>();
  const routeStepAfter = (name: string): BaseNode => {
    let step = routeSteps.get(name);
    if (step) return step;
    const routeKey = nodeYaml[name]?.route_key ?? 'route';
    const stepName = `${name}${ROUTE_STEP_SUFFIX}`;
    step = new FunctionNode(stepName, (ctx, input) =>
      createEvent({
        author: stepName,
        invocationId: ctx.invocationId,
        branch: ctx.branch,
        output: input,
        route: routeOf(input, routeKey),
      } as any),
    );
    routeSteps.set(name, step);
    return step;
  };

  const edges: EdgeItem[] = wf.edges.map((chain) => {
    const out: unknown[] = [];
    chain.forEach((element, i) => {
      if (typeof element === 'string') {
        out.push(element === START_NAME ? 'START' : nodeOf(element));
      } else if (Array.isArray(element)) {
        out.push(element.map(nodeOf));
      } else {
        const previous = chain[i - 1];
        if (typeof previous !== 'string' || previous === START_NAME) {
          throw new Error(`workflow: a routing map must follow the name of the node whose output it routes`);
        }
        out.push(routeStepAfter(previous));
        const map: Record<string, BaseNode | BaseNode[]> = {};
        for (const [key, target] of Object.entries(element)) {
          map[key === DEFAULT_ROUTE_KEY ? DEFAULT_ROUTE : key] = Array.isArray(target) ? target.map(nodeOf) : nodeOf(target);
        }
        out.push(map);
      }
    });
    return out as EdgeItem;
  });

  const workflow = new Workflow({
    name: spec.name,
    ...(spec.description ? { description: spec.description } : {}),
    edges,
    ...(wf.max_concurrency !== undefined ? { maxConcurrency: wf.max_concurrency } : {}),
  });
  return { workflow, agents, nodes };
}
