/**
 * lib/runtime/native/delegate.ts — delegation on the native loop: a
 * subagent runs as a tool, with its own child loop (WS2-6, ADR 0074).
 *
 * WHY this file exists:
 *   A DELEGATE syndicate (lib/compile.ts) lists each subagent on its
 *   orchestrator as ADK's AgentTool. The native loop (agentLoop.ts) runs
 *   the same delegation without ADK, and a session either runtime wrote must
 *   be one the other continues, so a delegated call stores what ADK's
 *   AgentTool stores, ids and times aside. tests/nativeDelegate.test.ts runs
 *   the boundary suite's delegation cases, a nested syndicate and the
 *   council example both ways and compares every session.
 *
 * ONE CALL, AS ADK'S AgentTool RUNS IT:
 *   1. The message: `{ role: 'user', parts: [{ text: args.request }] }`.
 *   2. The subagent's session: the one under the subagent's own name as the
 *      app name, with the caller's user id and session id. It is created on
 *      the first call, with the caller's state as it stands (the session's,
 *      then this call's writes; `temp:` keys dropped), and kept: a later
 *      call, in this turn or another, continues it. This is not a branch of
 *      the caller's session; ADK's AgentTool runs a Runner of its own.
 *   3. A turn already stopped answers an empty text, before or after the
 *      message is stored.
 *   4. The message is stored as a user event under a fresh invocation id
 *      (`e-<uuid>`), and the subagent runs on runAgentLoop as the root of
 *      its run: not streamed, under the turn's controls and signal (its
 *      calls count toward max_steps), with the caller's memory.
 *   5. Each event the child stores has its stateDelta, `temp:` keys aside,
 *      written into the call's own state delta, so it lands on the caller's
 *      response event. Once the turn has stopped, ADK's Runner yields no
 *      more events: the answer is read from the last one it yielded.
 *   6. The answer is the last event's text: its non-thought text parts
 *      joined by a newline, or '' when it has no parts. With an output
 *      schema it is parsed as JSON; text that does not parse fails the call
 *      with the parser's message, as on ADK.
 *
 * A PAUSE INSIDE A SUBAGENT (an ask_user call, an approval request) cannot
 * reach the caller, exactly as under ADK (ADR 0028): the child run ends
 * paused, its last event carries no text, the call answers '', and the gated
 * tool never runs. WS6-2a lifts this.
 *
 * Calls to subagents in one step run one after another, in call order, as
 * ADK runs them; running them concurrently is WS6.
 *
 * NESTED SYNDICATES: a `yaml_reference` subagent is the nested syndicate's
 * orchestrator, named as the entry, listing its own subagent tools. It runs
 * here like any subagent, and its own delegations open sessions under their
 * own names, as on ADK.
 *
 * A NESTED WORKFLOW (ADR 0098): a `yaml_reference` to a workflow syndicate
 * is a workflowSubagentTool, holding the whole graph as a WorkflowSubagent.
 * A call runs as steps 1 to 6 say, with the walk in place of the loop: the
 * graph's walk (lib/workflow/turn.ts, runNativeWorkflow, which
 * lib/compileNative.ts hands over) stores the message itself and yields the
 * events ADK's Runner yields for a Workflow root, node input turns aside;
 * the answer is the last of them's text, as ADK's AgentTool reads it from a
 * Workflow (never parsed: a Workflow has no output schema). A node that
 * gave up fails the call with its error. The walk is not imported here, so
 * this module stays below lib/workflow/ in the import graph.
 *
 * The DELEGATE relay fallback (an orchestrator that echoes a tool name or
 * says nothing) stays in lib/runtime/syndicateTurn.ts: it reads the drained
 * run, whichever runtime produced it.
 *
 * ADK stays out of this file: an ADK AgentTool is recognized by ADK's global
 * symbol only to refuse it, with a message naming what to list instead.
 */

import { randomUUID } from 'node:crypto';

import type { ModelAdapter, ToolDeclaration } from '../../models/contract.ts';
import { resolveAdapter } from '../../models/registry.ts';
import type { Tool, ToolContext } from '../../tools/tool.ts';
import type { TurnContent, TurnEvent } from '../events.ts';
import { createTurnEvent } from '../events.ts';
import { TEMP_STATE_PREFIX } from '../sessions.ts';
import type { Session, SessionService } from '../sessions.ts';
import type { AgentLoopContext, AgentLoopEnd } from './agentLoop.ts';
import type { NativeAgent } from './request.ts';
import { SelfCorrection } from './selfCorrection.ts';

// ── The subagent tool ────────────────────────────────────────────────────────

/** Where a subagent tool keeps the agent it runs. A global symbol, so a second copy of this module still finds it. */
export const SUBAGENT: unique symbol = Symbol.for('melchizedek.subagent');

/** ADK's own mark on an AgentTool (agent_tool.js). */
const ADK_AGENT_TOOL = Symbol.for('google.adk.agentTool');

/** Where a workflow subagent tool keeps the graph it runs. */
export const WORKFLOW_SUBAGENT: unique symbol = Symbol.for('melchizedek.workflowSubagent');

/** A subagent listed on its caller as a tool: the declaration ADK's AgentTool gives it, and the agent the call runs. */
export interface SubagentTool extends Tool {
  readonly [SUBAGENT]: NativeAgent;
}

/**
 * `agent` as a tool its caller lists, as lib/compile.ts lists a subagent as
 * an AgentTool: named for the agent, described by its description, taking
 * one string `request`. Only the native loop runs it.
 */
export function subagentTool(agent: NativeAgent): SubagentTool {
  return {
    name: agent.name,
    [SUBAGENT]: agent,
    declaration: (): ToolDeclaration => ({
      name: agent.name,
      description: agent.description ?? '',
      parameters: { type: 'object', properties: { request: { type: 'string' } }, required: ['request'] },
    }),
    execute: async () => {
      throw new Error(`${agent.name}: a subagent tool runs only on the native loop (lib/runtime/native/agentLoop.ts)`);
    },
  };
}

/** One call's walk of a nested workflow, on the child session (WorkflowSubagent.walk). */
export interface WorkflowSubagentRun {
  sessions: SessionService;
  appName: string;
  userId: string;
  sessionId: string;
  /** The message's parts: the call's request as one text part. */
  userParts: unknown[];
  signal?: AbortSignal;
  adapterFor: (model: string) => ModelAdapter;
  memory?: AgentLoopContext['memory'];
  log?: (message: string) => void;
  selfCorrection: SelfCorrection;
  credentials?: AgentLoopContext['credentials'];
}

/** A workflow syndicate delegated to as a subagent (ADR 0098): its name and description, and the walk one call runs. */
export interface WorkflowSubagent {
  name: string;
  description?: string;
  /** Stores the message on the child session and walks the whole graph, yielding each event ADK's Runner yields. Throws what a node gave up with. */
  walk(run: WorkflowSubagentRun): AsyncGenerator<TurnEvent, unknown>;
}

/** A nested workflow listed on its caller as a tool: the declaration ADK's AgentTool gives a Workflow, and the graph the call walks. */
export interface WorkflowSubagentTool extends Tool {
  readonly [WORKFLOW_SUBAGENT]: WorkflowSubagent;
}

/** `workflow` as a tool its caller lists, as lib/compileAdk.ts lists a nested Workflow as an AgentTool: one string `request`. Only the native loop runs it. */
export function workflowSubagentTool(workflow: WorkflowSubagent): WorkflowSubagentTool {
  return {
    name: workflow.name,
    [WORKFLOW_SUBAGENT]: workflow,
    declaration: (): ToolDeclaration => ({
      name: workflow.name,
      description: workflow.description ?? '',
      parameters: { type: 'object', properties: { request: { type: 'string' } }, required: ['request'] },
    }),
    execute: async () => {
      throw new Error(`${workflow.name}: a workflow subagent tool runs only on the native loop (lib/runtime/native/agentLoop.ts)`);
    },
  };
}

/** The nested workflow a delegated call walks: the one a workflow subagent tool holds, else undefined. */
export function workflowSubagentOf(tool: unknown): WorkflowSubagent | undefined {
  if (!tool || typeof tool !== 'object') return undefined;
  const workflow = (tool as Record<PropertyKey, unknown>)[WORKFLOW_SUBAGENT];
  return workflow && typeof workflow === 'object' ? (workflow as WorkflowSubagent) : undefined;
}

/**
 * The agent a delegated call runs: the one a subagent tool (or anything
 * carrying SUBAGENT) holds, else undefined. Throws for an ADK AgentTool that
 * carries none: its LlmAgent cannot run on the native loop.
 */
export function subagentOf(tool: unknown): NativeAgent | undefined {
  if (!tool || typeof tool !== 'object') return undefined;
  const agent = (tool as Record<PropertyKey, unknown>)[SUBAGENT];
  if (agent && typeof agent === 'object') return agent as NativeAgent;
  if ((tool as Record<PropertyKey, unknown>)[ADK_AGENT_TOOL] === true) {
    const name = (tool as { name?: unknown }).name;
    throw new Error(`${String(name)}: an ADK AgentTool cannot run on the native loop; list subagentTool(agent) (lib/runtime/native/delegate.ts)`);
  }
  return undefined;
}

// ── Running one call ─────────────────────────────────────────────────────────

/** What a delegated call needs from its caller's step. */
export interface DelegationScope {
  /** The caller's loop context: its session, store, adapters, memory, signal. */
  ctx: AgentLoopContext;
  /** The caller's session state as the step left it. */
  stateBase: Readonly<Record<string, unknown>>;
  /** The turn's signal, as the step sent it. */
  signal?: AbortSignal;
  /** The loop the child runs on (agentLoop.ts passes its own runAgentLoop). */
  runLoop: (agent: NativeAgent, ctx: AgentLoopContext) => AsyncGenerator<TurnEvent, AgentLoopEnd>;
  /** Calls sharing this key run one after another (agentLoop.ts passes the step's scope). */
  queue: object;
}

const queues = new WeakMap<object, Promise<unknown>>();

/** Runs `run` after every earlier call queued under `key`, whether it succeeded or not. */
function inTurn<T>(key: object, run: () => Promise<T>): Promise<T> {
  const before = queues.get(key) ?? Promise.resolve();
  const mine = before.then(run, run);
  queues.set(
    key,
    mine.then(
      () => undefined,
      () => undefined,
    ),
  );
  return mine;
}

/** ADK's AgentTool answer: the last event's non-thought text, joined by a newline; parsed under an output schema. */
function answerOf(agent: Pick<NativeAgent, 'outputSchema'>, last: TurnEvent | undefined): unknown {
  const parts = last?.content?.parts;
  if (!parts?.length) return '';
  const text = parts
    .filter((p) => !p.thought)
    .map((p) => p.text)
    .filter((t) => t)
    .join('\n');
  return agent.outputSchema ? JSON.parse(text) : text;
}

/** The child's session, as ADK's AgentTool gets or creates it: under the subagent's name, from the caller's state the first time. */
async function childSession(name: string, context: ToolContext, scope: DelegationScope): Promise<Session> {
  const { sessions, session: parent } = scope.ctx;
  const key = { appName: name, userId: parent.userId, sessionId: parent.id };
  return (await sessions.get(key)) ?? (await sessions.create({ ...key, state: { ...scope.stateBase, ...context.stateDelta } }));
}

/** Step 5: an event's state writes, `temp:` keys aside, into the call's state delta. */
function recordState(event: TurnEvent, context: ToolContext): void {
  for (const [k, v] of Object.entries(event.actions?.stateDelta ?? {})) {
    if (!k.startsWith(TEMP_STATE_PREFIX)) context.state.set(k, v);
  }
}

/**
 * Runs one delegated call: `agent` on its own session with the call's
 * `request` as its message, the child's state writes recorded in `context`.
 * Resolves to the call's result: the subagent's answer, '' for none. Throws what the child run
 * throws, and for an output-schema answer that does not parse.
 */
export function runSubagent(agent: NativeAgent, args: Record<string, unknown>, context: ToolContext, scope: DelegationScope): Promise<unknown> {
  return inTurn(scope.queue, () => runChild(agent, args, context, scope));
}

async function runChild(agent: NativeAgent, args: Record<string, unknown>, context: ToolContext, scope: DelegationScope): Promise<unknown> {
  const { ctx, signal } = scope;
  const { sessions } = ctx;
  const content: TurnContent = { role: 'user', parts: [{ text: args.request as string }] };

  const session = await childSession(agent.name, context, scope);
  if (signal?.aborted) return '';

  const invocationId = `e-${randomUUID()}`;
  await sessions.append(session, createTurnEvent({ invocationId, author: 'user', content }));
  if (signal?.aborted) return '';

  const loop = scope.runLoop(agent, {
    session,
    sessions,
    invocationId,
    userContent: content,
    stream: false,
    // ADK's AgentTool builds its sub-runner without the reflect-and-retry
    // plugins, so a subagent's own errors are not retried (ADR 0075).
    selfCorrection: new SelfCorrection({ model_errors: 0, tool_errors: 0 }),
    ...(ctx.memory ? { memory: ctx.memory } : {}),
    // The parent's grants, pinned to the root's app (ADR 0072). Not its consent step: a subagent's
    // pause would end inside the call, as ADK's AgentTool swallows it (ADR 0085).
    ...(ctx.credentials ? { credentials: ctx.credentials } : {}),
    ...(ctx.signal ? { signal: ctx.signal } : {}),
    ...(ctx.adapterFor ? { adapterFor: ctx.adapterFor } : {}),
    ...(ctx.log ? { log: ctx.log } : {}),
  });
  let last: TurnEvent | undefined;
  for await (const event of loop) {
    // ADK's Runner stops yielding once the turn stopped: the answer is the last event it yielded.
    if (signal?.aborted) break;
    recordState(event, context);
    last = event;
  }
  return answerOf(agent, last);
}

/**
 * Runs one delegated call to a nested workflow (ADR 0098): the whole graph
 * walked on the child session with the call's `request` as its message,
 * the walk's state writes recorded in `context`. Resolves to the last
 * yielded event's text, '' for none. Throws what the walk throws.
 */
export function runWorkflowSubagent(workflow: WorkflowSubagent, args: Record<string, unknown>, context: ToolContext, scope: DelegationScope): Promise<unknown> {
  return inTurn(scope.queue, () => walkChild(workflow, args, context, scope));
}

async function walkChild(workflow: WorkflowSubagent, args: Record<string, unknown>, context: ToolContext, scope: DelegationScope): Promise<unknown> {
  const { ctx, signal } = scope;
  const session = await childSession(workflow.name, context, scope);
  if (signal?.aborted) return '';
  const walk = workflow.walk({
    sessions: ctx.sessions,
    appName: session.appName,
    userId: session.userId,
    sessionId: session.id,
    userParts: [{ text: args.request as string }],
    adapterFor: ctx.adapterFor ?? resolveAdapter,
    // As runChild: ADK's AgentTool runs its sub-runner without the reflect-and-retry plugins (ADR 0075).
    selfCorrection: new SelfCorrection({ model_errors: 0, tool_errors: 0 }),
    ...(ctx.signal ? { signal: ctx.signal } : {}),
    ...(ctx.memory ? { memory: ctx.memory } : {}),
    ...(ctx.log ? { log: ctx.log } : {}),
    ...(ctx.credentials ? { credentials: ctx.credentials } : {}),
  });
  let last: TurnEvent | undefined;
  for await (const event of walk) {
    if (signal?.aborted) break;
    if (event.partial) continue;
    recordState(event, context);
    last = event;
  }
  return answerOf({}, last);
}
