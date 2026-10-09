/**
 * lib/runtime/native/delegate.ts — delegation on the native loop: a
 * subagent runs as a tool, with its own child loop (WS2-6, ADR 0074).
 *
 * WHY this file exists:
 *   A DELEGATE syndicate (lib/compile.ts) lists each subagent on its
 *   orchestrator as a tool, as ADK's AgentTool did. The native loop
 *   (agentLoop.ts) runs the delegation, and a session ADK wrote must be one
 *   the loop continues, so a delegated call stores what ADK's AgentTool
 *   stored, ids and times aside. tests/nativeDelegate.test.ts runs the
 *   boundary suite's delegation cases, a nested syndicate and the council
 *   example and compares every session with ADK's recorded one.
 *
 * ONE CALL, AS ADK'S AgentTool RAN IT:
 *   1. The message: `{ role: 'user', parts: [{ text: args.request }] }`.
 *   2. The subagent's session: filed under the agent path (childAppName,
 *      ADR 0111), with the caller's user id and session id: the caller's
 *      app name, the caller's name and the subagent's at the top
 *      (`<app>/<caller>/<subagent>`), the caller's app name and the
 *      subagent's below it (`<app>/<caller>/<subagent>/<inner>`). It is
 *      created on the first call, with the caller's state as it stands (the
 *      session's, then this call's writes; `temp:` keys dropped), and kept:
 *      a later call, in this turn or another, continues it. This is not a
 *      branch of the caller's session; ADK's AgentTool runs a Runner of its
 *      own. ADK filed it under the subagent's name alone, so two syndicates
 *      with a same-named subagent on one conversation shared it. A session
 *      stored under that old key is still read (legacyChild): when no
 *      session exists under the path and the caller has called the
 *      subagent before (or is resuming a pause found there), the old one is
 *      continued, so a stored conversation resumes where it stopped.
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
 * A PAUSE INSIDE A SUBAGENT (an ask_user call, an approval request, or a
 * pause inside its own delegated call) reaches the caller (ADR 0110, which
 * lifts ADR 0028's refusal). The child run ends paused; the call resolves to
 * a SubagentPause naming the ids it waits on, and the caller stores no
 * response to it: the call stays open, and the caller's run ends paused too
 * (agentLoop.ts). The turn finds the pause by walking down the open calls
 * (interrupts.ts delegatedPauses) and reports it with the agent path. The
 * answer comes back as the caller's next user message; the caller resumes
 * the open call (resumeSubagent), which stores the same answer parts as
 * the child's next message, under a fresh invocation id, and runs the
 * child's loop on: it reads the answer from its own session as a top-level
 * agent reads it (an approval runs or refuses its pinned call, a question's
 * answer is the call's response), finishes, and its answer is the open
 * call's response. A child that pauses again leaves the call open again.
 *
 * CALLS TO SUBAGENTS IN ONE STEP RUN CONCURRENTLY (ADR 0116), under the
 * caller's `max_concurrency` (the syndicate's root key, default
 * DEFAULT_MAX_CONCURRENCY): agentLoop.ts runs each delegated call through
 * the step's DelegationGate, which starts them in call order as slots free
 * up, and runs two calls to the same subagent (one child session) one after
 * the other. The step's responses are stored once every call has answered,
 * in call order, whatever order the children finished in; a child that
 * pauses leaves its call open while the others finish and are stored. ADK
 * ran them one after another; `max_concurrency: 1` keeps that order.
 *
 * NESTED SYNDICATES: a `yaml_reference` subagent is the nested syndicate's
 * orchestrator, named as the entry, listing its own subagent tools. It runs
 * here like any subagent, and its own delegations open sessions under their
 * own names, as on ADK.
 *
 * A NESTED WORKFLOW (ADR 0098): a `yaml_reference` to a workflow syndicate
 * is a workflowSubagentTool, holding the whole graph as a WorkflowSubagent.
 * A walk that ends paused (an ask_user node's question, an agent node's
 * approval request) leaves the call open as a child loop's pause does
 * (ADR 0111): the call resolves to a SubagentPause naming the walk's open
 * interrupts, and resumeWorkflowSubagent walks the graph again on the
 * answer, which the walk's own resume (lib/workflow/resume.ts) reads as it
 * reads a top-level workflow's. An `ask_user` answer reaches the walk as
 * ADK's explicit reply to its `adk_request_input` call.
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
 * ADK stays out of this file: a delegated call runs only the agent a
 * subagent tool holds under SUBAGENT (subagentTool).
 */

import { randomUUID } from 'node:crypto';

import type { ModelAdapter, ToolDeclaration } from '../../models/contract.ts';
import { resolveAdapter } from '../../models/registry.ts';
import type { Tool, ToolContext } from '../../tools/tool.ts';
import type { TurnContent, TurnEvent, TurnPart } from '../events.ts';
import { createTurnEvent } from '../events.ts';
import { TEMP_STATE_PREFIX } from '../sessions.ts';
import type { Session, SessionService } from '../sessions.ts';
import type { AgentLoopContext, AgentLoopEnd } from './agentLoop.ts';
import { REQUEST_INPUT_CALL } from './history.ts';
import type { NativeAgent } from './request.ts';
import { SelfCorrection } from './selfCorrection.ts';

// ── The subagent tool ────────────────────────────────────────────────────────

/** Where a subagent tool keeps the agent it runs. A global symbol, so a second copy of this module still finds it. */
export const SUBAGENT: unique symbol = Symbol.for('melchizedek.subagent');

/** Where a workflow subagent tool keeps the graph it runs. */
export const WORKFLOW_SUBAGENT: unique symbol = Symbol.for('melchizedek.workflowSubagent');

/** A subagent listed on its caller as a tool: the declaration ADK's AgentTool gave it, and the agent the call runs. */
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

/** How a nested workflow's walk ended, as far as a delegated call reads it (lib/workflow/turn.ts NativeWorkflowEnd). */
export interface WorkflowSubagentEnd {
  /** The walk's result; `interruptIds` holds what it paused on. */
  run?: { interruptIds: readonly string[] };
  stopped?: boolean;
}

/** A workflow syndicate delegated to as a subagent (ADR 0098): its name and description, and the walk one call runs. */
export interface WorkflowSubagent {
  name: string;
  description?: string;
  /** Stores the message on the child session and walks the whole graph (a resume when it holds a paused walk), yielding each event ADK's Runner yields. Throws what a node gave up with. */
  walk(run: WorkflowSubagentRun): AsyncGenerator<TurnEvent, WorkflowSubagentEnd | undefined>;
}

/** A nested workflow listed on its caller as a tool: the declaration ADK's AgentTool gave a Workflow, and the graph the call walks. */
export interface WorkflowSubagentTool extends Tool {
  readonly [WORKFLOW_SUBAGENT]: WorkflowSubagent;
}

/** `workflow` as a tool its caller lists, declared as ADK's AgentTool declared a nested Workflow: one string `request`. */
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
 * carrying SUBAGENT) holds, else undefined.
 */
export function subagentOf(tool: unknown): NativeAgent | undefined {
  if (!tool || typeof tool !== 'object') return undefined;
  const agent = (tool as Record<PropertyKey, unknown>)[SUBAGENT];
  if (agent && typeof agent === 'object') return agent as NativeAgent;
  return undefined;
}

// ── Running one call ─────────────────────────────────────────────────────────

/**
 * A delegated call whose child run ended paused (ADR 0110): the ids the
 * child waits on. The caller stores no response to the call and ends its
 * own run paused.
 */
export class SubagentPause {
  readonly pending: readonly string[];
  constructor(pending: readonly string[]) {
    this.pending = pending;
  }
}

/** What a delegated call needs from its caller's step. */
export interface DelegationScope {
  /** The caller's loop context: its session, store, adapters, memory, signal. */
  ctx: AgentLoopContext;
  /** The caller's name: a segment of the path a top-level caller's subagents are filed under (childAppName). */
  caller: string;
  /** The caller's session state as the step left it. */
  stateBase: Readonly<Record<string, unknown>>;
  /** The turn's signal, as the step sent it. */
  signal?: AbortSignal;
  /** The loop the child runs on (agentLoop.ts passes its own runAgentLoop). */
  runLoop: (agent: NativeAgent, ctx: AgentLoopContext) => AsyncGenerator<TurnEvent, AgentLoopEnd>;
}

/** Delegated calls one step runs at once when the syndicate sets no `max_concurrency` (ADR 0116). */
export const DEFAULT_MAX_CONCURRENCY = 4;

/** One delegated call's place in its step's DelegationGate. */
export interface DelegationTicket {
  /** Resolves once the call may start: a slot is free, and every earlier call under its key has released. */
  readonly ready: Promise<void>;
  /** Frees the slot and the key's lane. Idempotent; call it whether the call ran, failed or never started. */
  release(): void;
}

/**
 * The delegated calls of one step (ADR 0116): at most `limit` run at once,
 * started in the order they entered (agentLoop.ts enters them in call
 * order, synchronously, before any of them runs), and calls sharing a key
 * (the subagent's name, so one child session) run one after another in
 * that order. A slot is held from the call's start to its release, which
 * comes as soon as the child's run ends: what the step does after (self-
 * correction's bookkeeping, which waits on earlier calls) holds no slot. A
 * call waiting on an earlier same-key call holds its slot meanwhile: the
 * earlier call already holds one, so the wait always ends.
 */
export class DelegationGate {
  readonly limit: number;
  private active = 0;
  private readonly waiting: Array<() => void> = [];
  private readonly lanes = new Map<string, Promise<void>>();

  constructor(limit: number = DEFAULT_MAX_CONCURRENCY) {
    this.limit = Number.isInteger(limit) && limit > 0 ? limit : DEFAULT_MAX_CONCURRENCY;
  }

  /** Enters one call under `key`, behind every call entered before it. */
  enter(key: string): DelegationTicket {
    let granted = false;
    let released = false;
    let freeLane!: () => void;
    const laneDone = new Promise<void>((resolve) => (freeLane = resolve));
    const slot = new Promise<void>((resolve) => {
      this.waiting.push(() => {
        granted = true;
        resolve();
      });
      this.pump();
    });
    const before = this.lanes.get(key);
    this.lanes.set(key, laneDone);
    const ready = Promise.all([slot, before]).then(() => undefined);
    const release = (): void => {
      if (released) return;
      released = true;
      freeLane();
      if (granted) {
        this.active -= 1;
        this.pump();
      } else {
        // Never started (a step that failed before reaching the child): the slot it would have taken is not held, and it never will be.
        void slot.then(() => {
          this.active -= 1;
          this.pump();
        });
      }
    };
    return { ready, release };
  }

  /** Runs `run` under a ticket for `key`: once ready, the ticket released when it settles. */
  async run<T>(key: string, run: () => Promise<T>): Promise<T> {
    const ticket = this.enter(key);
    try {
      await ticket.ready;
      return await run();
    } finally {
      ticket.release();
    }
  }

  private pump(): void {
    while (this.active < this.limit && this.waiting.length > 0) {
      this.active += 1;
      (this.waiting.shift() as () => void)();
    }
  }
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

/**
 * The app name a delegated call's child session is filed under (ADR 0111):
 * the agent path. Below a top-level agent, its app name, its name and the
 * subagent's (`<app>/<caller>/<subagent>`); below a delegated subagent,
 * whose own session is already filed under its path, that app name and the
 * subagent's. Agent names are identifiers (lib/syndicateSchema.ts), so
 * never hold a `/`.
 */
export function childAppName(parent: { appName: string; delegated?: boolean }, caller: string, name: string): string {
  return parent.delegated ? entryAppName(parent.appName, name) : `${parent.appName}/${caller}/${name}`;
}

/**
 * The app name a nested workflow run as a dispatch route or a workflow node
 * walks under (ADR 0119): the session that runs it, and the entry's name
 * (`<app>/<route>`, `<walk's app>/<node>`). A route answers in the
 * conversation itself and a node's walk is one session, so the entry's name
 * is unique below either; ADR 0106 filed it under the entry's name alone,
 * which legacyChild still reads.
 */
export function entryAppName(parentAppName: string, name: string): string {
  return `${parentAppName}/${name}`;
}

/**
 * The session a delegated call ran in before ADR 0111, filed under the
 * subagent's name alone, when it is the one to continue (`continues`): the
 * caller of a stored conversation called the subagent there before, or a
 * pause was found waiting in it. Read only when no session exists under the
 * agent path.
 */
export async function legacyChild(
  sessions: Pick<SessionService, 'get'>,
  key: { userId: string; sessionId: string },
  name: string,
  continues: boolean,
): Promise<Session | undefined> {
  if (!continues) return undefined;
  return sessions.get({ appName: name, userId: key.userId, sessionId: key.sessionId });
}

/**
 * The child session a nested workflow run as a dispatch route or a workflow
 * node walks on (ADR 0119): the one filed under entryAppName, else, when
 * the entry ran in `parent` before (an event it authored there) or a pause
 * was found waiting below it (`resuming`), the one ADR 0106 filed under its
 * name alone (legacyChild), else a new one from `state`.
 */
export async function entrySession(
  sessions: Pick<SessionService, 'get' | 'create'>,
  parent: { appName: string; userId: string; sessionId: string; events: readonly TurnEvent[] },
  name: string,
  state: Record<string, unknown>,
  resuming = false,
): Promise<Session> {
  const key = { appName: entryAppName(parent.appName, name), userId: parent.userId, sessionId: parent.sessionId };
  const own = await sessions.get(key);
  if (own) return own;
  const legacy = await legacyChild(sessions, key, name, resuming || parent.events.some((e) => e.author === name));
  return legacy ?? (await sessions.create({ ...key, state }));
}

/** Whether `caller` called `name` in `events` in a call other than `callId`: the subagent ran for it before. */
function calledBefore(events: readonly TurnEvent[], caller: string, name: string, callId: string | undefined): boolean {
  return events.some((e) => e.author === caller && (e.content?.parts ?? []).some((p) => p.functionCall?.name === name && p.functionCall.id !== callId));
}

/**
 * The child's session, as ADK's AgentTool gets or creates it: filed under
 * the agent path (childAppName), from the caller's state the first time. A
 * session under the old key is continued when the caller called the
 * subagent before, or when `resuming` a pause found there (legacyChild):
 * a syndicate that never called it, another syndicate's caller included,
 * starts its own.
 */
async function childSession(name: string, context: ToolContext, scope: DelegationScope, resuming: boolean): Promise<Session> {
  const { sessions, session: parent } = scope.ctx;
  const key = { appName: childAppName({ appName: parent.appName, delegated: scope.ctx.delegated === true }, scope.caller, name), userId: parent.userId, sessionId: parent.id };
  const own = await sessions.get(key);
  if (own) return own;
  const legacy = await legacyChild(sessions, key, name, resuming || calledBefore(parent.events, scope.caller, name, context.functionCallId));
  return legacy ?? (await sessions.create({ ...key, state: { ...scope.stateBase, ...context.stateDelta } }));
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
  return runChild(agent, { role: 'user', parts: [{ text: args.request as string }] }, context, scope, false);
}

/**
 * Resumes a delegated call the child left paused (ADR 0110): `answer` (the
 * caller's user message parts that answer what waits below the call) is
 * stored as the child's next message and the child's loop runs on, as
 * runSubagent runs it. Resolves as runSubagent does, a SubagentPause again
 * when the child pauses again.
 */
export function resumeSubagent(agent: NativeAgent, answer: TurnPart[], context: ToolContext, scope: DelegationScope): Promise<unknown> {
  return runChild(agent, { role: 'user', parts: answer }, context, scope, true);
}

async function runChild(agent: NativeAgent, content: TurnContent, context: ToolContext, scope: DelegationScope, resuming: boolean): Promise<unknown> {
  const { ctx, signal } = scope;
  const { sessions } = ctx;

  const session = await childSession(agent.name, context, scope, resuming);
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
    // Its own delegations are filed below its path (childAppName, ADR 0111).
    delegated: true,
    // ADK's AgentTool builds its sub-runner without the reflect-and-retry
    // plugins, so a subagent's own errors are not retried (ADR 0075).
    selfCorrection: new SelfCorrection({ model_errors: 0, tool_errors: 0 }),
    ...(ctx.memory ? { memory: ctx.memory } : {}),
    // The parent's grants, pinned to the root's app (ADR 0072). Not its consent step: an OAuth
    // consent inside a subagent is not carried to the caller (ADR 0085, ADR 0110).
    ...(ctx.credentials ? { credentials: ctx.credentials } : {}),
    ...(ctx.signal ? { signal: ctx.signal } : {}),
    ...(ctx.adapterFor ? { adapterFor: ctx.adapterFor } : {}),
    ...(ctx.log ? { log: ctx.log } : {}),
  });
  let last: TurnEvent | undefined;
  for (;;) {
    const next = await loop.next();
    if (next.done) {
      // A child that ended waiting on a person leaves the call open (ADR 0110).
      if (next.value.reason === 'paused' && !signal?.aborted) return new SubagentPause(next.value.pending ?? []);
      break;
    }
    // ADK's Runner stops yielding once the turn stopped: the answer is the last event it yielded.
    if (signal?.aborted) {
      await loop.return(undefined as never);
      break;
    }
    recordState(next.value, context);
    last = next.value;
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
  return walkChild(workflow, [{ text: args.request as string }], context, scope, false);
}

/** The engine's ask_user tool name (lib/runtime/questions.ts ASK_USER). */
const ASK_USER_CALL = 'ask_user';

/**
 * Resumes a delegated call whose nested workflow ended paused (ADR 0111):
 * the graph is walked again on `answer` (the caller's user message parts
 * that answer the walk's open interrupt), which the walk's resume reads as
 * it reads a top-level workflow's. An approval decision goes as it came; an
 * `ask_user` answer goes as ADK's explicit reply to the `adk_request_input`
 * call it answers, under that call's name. Resolves as runWorkflowSubagent
 * does, a SubagentPause again when the walk pauses again.
 */
export function resumeWorkflowSubagent(workflow: WorkflowSubagent, answer: TurnPart[], context: ToolContext, scope: DelegationScope): Promise<unknown> {
  const parts = answer.map((p) => (p.functionResponse?.name === ASK_USER_CALL ? { functionResponse: { ...p.functionResponse, name: REQUEST_INPUT_CALL } } : p));
  return walkChild(workflow, parts, context, scope, true);
}

async function walkChild(workflow: WorkflowSubagent, userParts: unknown[], context: ToolContext, scope: DelegationScope, resuming: boolean): Promise<unknown> {
  const { ctx, signal } = scope;
  const session = await childSession(workflow.name, context, scope, resuming);
  if (signal?.aborted) return '';
  const walk = workflow.walk({
    sessions: ctx.sessions,
    appName: session.appName,
    userId: session.userId,
    sessionId: session.id,
    userParts,
    adapterFor: ctx.adapterFor ?? resolveAdapter,
    // As runChild: ADK's AgentTool runs its sub-runner without the reflect-and-retry plugins (ADR 0075).
    selfCorrection: new SelfCorrection({ model_errors: 0, tool_errors: 0 }),
    ...(ctx.signal ? { signal: ctx.signal } : {}),
    ...(ctx.memory ? { memory: ctx.memory } : {}),
    ...(ctx.log ? { log: ctx.log } : {}),
    ...(ctx.credentials ? { credentials: ctx.credentials } : {}),
  });
  let last: TurnEvent | undefined;
  for (;;) {
    const next = await walk.next();
    if (next.done) {
      // A walk that ended waiting on a person leaves the call open (ADR 0111).
      const paused = next.value?.run?.interruptIds ?? [];
      if (paused.length > 0 && !signal?.aborted) return new SubagentPause(paused);
      break;
    }
    if (signal?.aborted) {
      await walk.return(undefined);
      break;
    }
    const event = next.value;
    if (event.partial) continue;
    recordState(event, context);
    last = event;
  }
  return answerOf({}, last);
}
