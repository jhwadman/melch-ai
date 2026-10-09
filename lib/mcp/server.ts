/**
 * lib/mcp/server.ts — syndicates served as MCP tools (ADR 0125).
 *
 * `createMcpServer(options)` makes each loaded syndicate one MCP tool, so an
 * MCP client (Claude Code, Codex, a custom connector) asks a syndicate the way
 * it calls any other tool: `{ message, session_id? }` in, the turn's answer
 * out, with the session id it can pass back to continue the conversation.
 * One more tool, `melch_resume`, answers a turn that paused: an approval
 * (`adk_request_confirmation`), a workflow question (`ask_user`), or an OAuth
 * consent.
 *
 * WHY it drives the A2A executor: every turn semantic the A2A server applies
 * (budgets, the concurrency caps, one turn at a time per conversation, the
 * approval answer read from the stored events, the deadline, cancellation,
 * guards and the ledger inside `runSyndicateTurn`, the task record and audit
 * event, memory ingestion after the reply) lives in `SyndicateExecutor`
 * (lib/a2a/executor.ts). This module hands it one task per tool call through
 * a collecting event bus and reads the final status back, so the MCP surface
 * cannot drift from the A2A one. Nothing here calls the turn runner itself.
 *
 * Transports: `serveMcpStdio` (one local client over stdin/stdout) and
 * `mcpHttpApp` (Streamable HTTP, stateful sessions, behind the bearer rule
 * the A2A server applies). `mcpBindProblem` is the refusal the bin applies
 * before listening: a bind beyond loopback without a secret never starts.
 *
 * Logging: the executor's lines (task ids by prefix, tool names, counts) and
 * this module's own (tool names, session ids by prefix). A user's message,
 * an answer, a secret or a model key is never logged here.
 */

import { randomUUID, timingSafeEqual } from 'node:crypto';
import type { Readable, Writable } from 'node:stream';
import express from 'express';
import type { Express, Request, Response } from 'express';
import rateLimit from 'express-rate-limit';
import { TaskState } from '@a2a-js/sdk';
import type { ExecutionEventBus, RequestContext } from '@a2a-js/sdk/server';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { hostHeaderValidation } from '@modelcontextprotocol/sdk/server/middleware/hostHeaderValidation.js';
import { CallToolRequestSchema, ListToolsRequestSchema, isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js';

import type { CompileOptions } from '../compile.ts';
import type { SyndicateYamlConfig } from '../loadSyndicate.ts';
import { resolveModel } from '../models/registry.ts';
import { InProcessSessionService } from '../runtime/sessions.ts';
import type { SessionService } from '../runtime/sessions.ts';
import type { MemoryService } from '../runtime/memoryService.ts';
import { namespacedMemoryService } from '../memory/namespace.ts';
import { A2A_APP_NAME, SyndicateExecutor, TaskLimiter, requestContextStorage } from '../a2a/executor.ts';
import type { A2AContext } from '../a2a/executor.ts';
import { HEADER_VALUE_PATTERN } from '../a2a/identity.ts';
import { inProcessTurnLock } from '../a2a/turnLock.ts';
import type { TurnLock } from '../a2a/turnLock.ts';
import type { Policy } from '../a2a/policy.ts';
import type { TaskRecord } from '../observability/metrics.ts';
import type { AuditSink } from '../observability/audit.ts';
import type { ToolCredentials } from '../tools/oauthConsent.ts';

/** The tool that answers a paused turn. Never a syndicate's tool name. */
export const RESUME_TOOL = 'melch_resume';

/** MCP tool names (Claude Code and Codex accept these): letters, digits, `_` and `-`, at most 64. */
const TOOL_NAME_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
/** A session id a caller hands back: what this server issues, and A2A context ids. Linear, no nesting. */
export const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
/** The longest message a tool call carries. */
const MAX_MESSAGE_CHARS = 100_000;
/** A tool description is prompt text for the calling model: kept short. */
const MAX_DESCRIPTION_CHARS = 1_000;
/** Sessions whose pause and syndicate this process remembers. */
const MAX_REMEMBERED_SESSIONS = 10_000;

/** One syndicate this server exposes. */
export interface McpSyndicate {
  /** The tool name: the file id (`research_desk` for research_desk.yaml), [A-Za-z0-9_-]{1,64}. */
  id: string;
  config: SyndicateYamlConfig;
}

/** Who is calling: what the A2A identity middleware would have resolved. */
export interface McpCaller {
  /** The scope the caller's sessions and memory are stored under. */
  scopeKey: string;
  /** The caller's name for logs, budgets and the per-caller cap ('local', 'shared-secret', …). */
  caller: string;
  /** The request's source address, for the audit trail only. */
  sourceIp?: string;
}

/** The stdio caller: this machine's own user. */
export const LOCAL_CALLER: McpCaller = { scopeKey: 'default', caller: 'local' };

export interface McpServerOptions {
  /** THE DELIBERATE ACT OF EXPOSURE: only these syndicates are tools. */
  syndicates: McpSyndicate[];
  /** The MCP server name in the handshake. Default `melchizedek`. */
  name?: string;
  /** The version in the handshake. */
  version?: string;
  /** The conversation store. Default: in process (lost on exit). */
  sessionService?: SessionService;
  /** Long-term memory, for syndicates whose memory_system is long-term. */
  memoryService?: MemoryService;
  /** Model resolution; default the registry on the server's own environment. */
  resolveModel?: CompileOptions['resolveModel'];
  /** Wall-clock budget per turn, ms. 0 or undefined = none. */
  taskTimeoutMs?: number;
  /** Concurrent turns across every syndicate. 0 = unlimited. */
  maxConcurrentTasks?: number;
  /** Concurrent turns for one scope. Default 4 (the A2A default); 0 = unlimited. */
  maxConcurrentPerScope?: number;
  /** Concurrent turns for one caller. Default 0 (unlimited). */
  maxConcurrentPerCaller?: number;
  /** Budgets: admit each turn, record what it spent (lib/a2a/policy.ts). */
  policy?: Policy;
  /** One turn at a time per conversation. Default: a lock in this process. */
  turnLock?: TurnLock;
  turnLockWaitMs?: number;
  /** The sealed per-user tool credentials and the consent step (ADR 0072, ADR 0085). */
  toolCredentials?: ToolCredentials;
  onTaskEnd?: (record: TaskRecord) => void;
  audit?: AuditSink;
  log?: (message: string) => void;
  warn?: (message: string) => void;
}

/** What one paused turn waits for, as the executor published it. */
export type McpPause =
  | { kind: 'approval'; id: string; agent: string; tool: string; args: Record<string, unknown>; path?: string[] }
  | { kind: 'input'; id: string; node: string; message: string; options?: unknown[] }
  | { kind: 'consent'; id: string; agent: string; provider: string; authorizationUrl: string; scopes?: unknown };

/** The outcome of one tool call, before it becomes an MCP result. */
export interface McpTurnOutcome {
  status: 'completed' | 'input-required' | 'failed' | 'canceled' | 'rejected';
  sessionId: string;
  text: string;
  pause?: McpPause;
}

export interface MelchMcpServer {
  /** The tools/list entries: one per syndicate, then melch_resume. */
  tools(): Tool[];
  /** A low-level MCP Server for one connection, bound to its caller. */
  connect(caller: McpCaller): Server;
  /** Answers one tools/call; the transports go through `connect`, tests may call it directly. */
  call(
    caller: McpCaller,
    name: string,
    args: unknown,
    extra?: { signal?: AbortSignal; onProgress?: (message: string) => void },
  ): Promise<CallToolResult>;
  /** Stop admitting turns; resolve when running ones finish or graceMs passes. Returns how many were canceled. */
  shutdown(graceMs: number): Promise<number>;
  /** Turns running now. */
  readonly inFlight: number;
}

/** A syndicate's tool name from its file id: anything outside [A-Za-z0-9_-] becomes `_`. */
export function toolNameFor(fileId: string): string {
  const base = fileId.replace(/\.ya?ml$/i, '');
  const name = base.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64);
  return name || 'syndicate';
}

/** The text after a tool's answer that hands its session back. */
function sessionLine(sessionId: string): string {
  return `[session_id: ${sessionId}] Pass this session_id to continue this conversation.`;
}

function describePause(p: McpPause, sessionId: string): string {
  switch (p.kind) {
    case 'approval': {
      const args = JSON.stringify(p.args ?? {});
      const summary = args.length > 600 ? `${args.slice(0, 600)}…` : args;
      const via = p.path?.length ? ` (inside ${p.path.join(' → ')})` : '';
      return `Approval needed: ${p.agent}${via} wants to run ${p.tool}(${summary}). Nothing has run. `
        + `Ask the person, then call ${RESUME_TOOL} with session_id "${sessionId}" and approve: true to run it or false to refuse it.`;
    }
    case 'input': {
      const choices = Array.isArray(p.options) && p.options.length ? ` (${p.options.join(' / ')})` : '';
      return `Input needed: ${p.node} asks: ${p.message || '(no question text)'}${choices}. `
        + `Call ${RESUME_TOOL} with session_id "${sessionId}" and answer: "<the person's answer>".`;
    }
    case 'consent':
      return `Authorization needed: ${p.agent} needs access to the person's ${p.provider} account. `
        + `The person opens ${p.authorizationUrl} to authorize; then call ${RESUME_TOOL} with session_id "${sessionId}" to continue.`;
  }
}

/** Reads the executor's events: the last final status, and the pause its data part names. */
function collectingBus(onWorking: (text: string) => void): { bus: ExecutionEventBus; result: () => { state?: TaskState; text: string; data?: Record<string, any> } } {
  let state: TaskState | undefined;
  let text = '';
  let data: Record<string, any> | undefined;
  const bus = {
    publish(event: any) {
      if (event?.kind !== 'statusUpdate') return;
      const status = event.data?.status;
      const parts: any[] = status?.message?.parts ?? [];
      const message = parts
        .filter((p) => p?.content?.$case === 'text')
        .map((p) => String(p.content.value))
        .join('');
      if (status?.state === TaskState.TASK_STATE_WORKING) {
        if (message) onWorking(message.replace(/^\[STATUS\] /, ''));
        return;
      }
      state = status?.state;
      text = message;
      data = parts.find((p) => p?.content?.$case === 'data')?.content?.value;
    },
    on() { return bus; },
    off() { return bus; },
    once() { return bus; },
    removeAllListeners() { return bus; },
    finished() {},
  };
  return { bus: bus as unknown as ExecutionEventBus, result: () => ({ state, text, ...(data ? { data } : {}) }) };
}

function pauseFrom(data: Record<string, any> | undefined): McpPause | undefined {
  if (!data || typeof data !== 'object') return undefined;
  if (data.type === 'approval_request') {
    return { kind: 'approval', id: String(data.approval_id), agent: String(data.agent ?? ''), tool: String(data.tool ?? ''), args: data.args ?? {}, ...(Array.isArray(data.path) ? { path: data.path.map(String) } : {}) };
  }
  if (data.type === 'input_request') {
    const options = (data.payload as { options?: unknown } | undefined)?.options;
    return { kind: 'input', id: String(data.interrupt_id), node: String(data.node ?? ''), message: String(data.message ?? ''), ...(Array.isArray(options) ? { options } : {}) };
  }
  if (data.type === 'consent_request') {
    return { kind: 'consent', id: String(data.consent_id), agent: String(data.agent ?? ''), provider: String(data.provider ?? ''), authorizationUrl: String(data.authorization_url ?? ''), ...(data.scopes !== undefined ? { scopes: data.scopes } : {}) };
  }
  return undefined;
}

/** Whether the syndicate's answer is one JSON object by declaration (an output schema or JSON mode). */
function declaresStructuredOutput(cfg: SyndicateYamlConfig): boolean {
  const o = cfg.orchestrator as unknown as Record<string, any> | undefined;
  return !!(o?.output?.schema || o?.output?.mime === 'application/json' || o?.outputSchema);
}

const textResult = (text: string, isError = false): CallToolResult => ({ content: [{ type: 'text', text }], ...(isError ? { isError: true } : {}) });

export function createMcpServer(options: McpServerOptions): MelchMcpServer {
  const log = options.log ?? ((m: string) => console.error(`[MCP] ${m}`));
  const warn = options.warn ?? ((m: string) => console.error(`[MCP] ⚠ ${m}`));
  const name = options.name ?? 'melchizedek';
  const version = options.version ?? '1.0.0';

  // ── The exposure: validated once, at construction ──────────────────────────
  const byName = new Map<string, McpSyndicate>();
  for (const s of options.syndicates) {
    if (!TOOL_NAME_PATTERN.test(s.id)) throw new Error(`MCP tool name '${s.id}' must match [A-Za-z0-9_-]{1,64}.`);
    if (s.id === RESUME_TOOL) throw new Error(`'${RESUME_TOOL}' is reserved for resuming a paused turn; rename the syndicate file.`);
    if (byName.has(s.id)) throw new Error(`Two syndicates would both be the MCP tool '${s.id}'.`);
    byName.set(s.id, s);
  }

  // ── The executor's collaborators, as createA2AApp builds them ──────────────
  const internalSessions = new InProcessSessionService();
  const durableSessions = options.sessionService;
  const limiter = new TaskLimiter(options.maxConcurrentTasks ?? 0, {
    perScope: options.maxConcurrentPerScope ?? 4,
    perCaller: options.maxConcurrentPerCaller ?? 0,
  });
  const turnLock = options.turnLock ?? inProcessTurnLock();
  const resolver = options.resolveModel ?? ((modelName?: string) => resolveModel(modelName));
  const compileFor = (_ctx: A2AContext): CompileOptions => ({
    resolveModel: resolver,
    onUnknownTool: (tool: string) => warn(`Unknown tool '${tool}' — skipping.`),
    log,
  });
  const executors = new Map<string, SyndicateExecutor>();
  const executorFor = (s: McpSyndicate): SyndicateExecutor => {
    let ex = executors.get(s.id);
    if (ex) return ex;
    const cfg = s.config;
    const mode = cfg.memory_system;
    const sessionService = mode === 'internal-only' || !durableSessions ? internalSessions : durableSessions;
    const memoryService = mode === 'long-term' && options.memoryService
      ? namespacedMemoryService(options.memoryService, cfg.memory_namespace || A2A_APP_NAME)
      : undefined;
    ex = new SyndicateExecutor({
      config: cfg,
      sessionService,
      ...(memoryService ? { memoryService } : {}),
      compileFor,
      taskTimeoutMs: options.taskTimeoutMs,
      limiter,
      agentId: s.id,
      turnLock,
      turnLockWaitMs: options.turnLockWaitMs,
      ...(options.toolCredentials ? { toolCredentials: options.toolCredentials } : {}),
      ...(options.policy ? { policy: options.policy } : {}),
      ...(options.onTaskEnd ? { onTaskEnd: options.onTaskEnd } : {}),
      ...(options.audit ? { onAudit: options.audit } : {}),
      log,
      warn,
    });
    executors.set(s.id, ex);
    return ex;
  };

  // ── What this process remembers of a session: its syndicate and open pause ─
  const sessions = new Map<string, { syndicate: string; pause?: McpPause }>();
  const sessionKey = (caller: McpCaller, sessionId: string) => `${caller.scopeKey}\u0000${sessionId}`;
  const remember = (key: string, value: { syndicate: string; pause?: McpPause }) => {
    sessions.delete(key);
    sessions.set(key, value);
    while (sessions.size > MAX_REMEMBERED_SESSIONS) sessions.delete(sessions.keys().next().value as string);
  };

  /** One task through the executor: what A2A's message/send does, minus the HTTP. */
  const runTask = async (
    caller: McpCaller,
    syndicate: McpSyndicate,
    sessionId: string,
    parts: unknown[],
    extra: { signal?: AbortSignal; onProgress?: (message: string) => void },
  ): Promise<McpTurnOutcome> => {
    const executor = executorFor(syndicate);
    const taskId = randomUUID();
    const { bus, result } = collectingBus((t) => extra.onProgress?.(t));
    const requestContext = {
      taskId,
      contextId: sessionId,
      userMessage: { kind: 'message', messageId: randomUUID(), role: 'user', parts, contextId: sessionId, taskId },
    } as unknown as RequestContext;
    const ctx: A2AContext = {
      apiKey: '',
      provider: 'google',
      scopeKey: caller.scopeKey,
      caller: caller.caller,
      operator: caller.caller !== 'local',
      ...(caller.sourceIp ? { sourceIp: caller.sourceIp } : {}),
      surface: { name: 'mcp' },
    };
    // MCP's notifications/cancelled aborts the request's signal: that is the task's cancel.
    const onAbort = () => void executor.cancelTask(taskId);
    if (extra.signal?.aborted) onAbort();
    extra.signal?.addEventListener('abort', onAbort, { once: true });
    try {
      await requestContextStorage.run(ctx, () => executor.execute(requestContext, bus));
    } finally {
      extra.signal?.removeEventListener('abort', onAbort);
    }
    const r = result();
    const pause = r.state === TaskState.TASK_STATE_INPUT_REQUIRED ? pauseFrom(r.data) : undefined;
    const status: McpTurnOutcome['status'] =
      r.state === TaskState.TASK_STATE_COMPLETED ? 'completed'
        : r.state === TaskState.TASK_STATE_INPUT_REQUIRED ? 'input-required'
          : r.state === TaskState.TASK_STATE_CANCELED ? 'canceled'
            : r.state === TaskState.TASK_STATE_REJECTED ? 'rejected'
              : 'failed';
    remember(sessionKey(caller, sessionId), { syndicate: syndicate.id, ...(pause ? { pause } : {}) });
    return { status, sessionId, text: r.text, ...(pause ? { pause } : {}) };
  };

  const toResult = (syndicate: McpSyndicate, o: McpTurnOutcome): CallToolResult => {
    const structured: Record<string, unknown> = { session_id: o.sessionId, status: o.status };
    if (o.pause) {
      const { kind, ...rest } = o.pause;
      structured.waiting_for = { kind, ...rest };
      const text = describePause(o.pause, o.sessionId);
      return { content: [{ type: 'text', text }, { type: 'text', text: sessionLine(o.sessionId) }], structuredContent: structured };
    }
    if (o.status !== 'completed') {
      const text = o.text || (o.status === 'canceled' ? 'The task was canceled.' : 'The turn did not complete.');
      return { content: [{ type: 'text', text }, { type: 'text', text: sessionLine(o.sessionId) }], structuredContent: structured, isError: true };
    }
    if (declaresStructuredOutput(syndicate.config)) {
      try {
        const parsed = JSON.parse(o.text);
        if (parsed && typeof parsed === 'object') structured.output = parsed;
      } catch {
        /* the text stands as the answer */
      }
    }
    return { content: [{ type: 'text', text: o.text }, { type: 'text', text: sessionLine(o.sessionId) }], structuredContent: structured };
  };

  const syndicateTool = (s: McpSyndicate): Tool => {
    const declared = (s.config.orchestrator?.description ?? '').trim();
    const about = declared || `Ask the ${s.config.syndicate_name} syndicate.`;
    const description = `${about.length > MAX_DESCRIPTION_CHARS ? `${about.slice(0, MAX_DESCRIPTION_CHARS)}…` : about}\n\n`
      + 'Runs one turn of this melch syndicate and returns its answer. Omit session_id to start a new conversation; '
      + 'the result carries the session_id to pass back to continue it. A turn may pause for a person '
      + `(an approval, a question, an authorization): answer it with ${RESUME_TOOL}.`;
    return {
      name: s.id,
      title: s.config.syndicate_name,
      description,
      inputSchema: {
        type: 'object',
        properties: {
          message: { type: 'string', description: 'What to ask the syndicate.' },
          session_id: { type: 'string', description: 'A session_id from an earlier result, to continue that conversation.' },
        },
        required: ['message'],
        additionalProperties: false,
      },
    };
  };

  const resumeTool: Tool = {
    name: RESUME_TOOL,
    title: 'Resume a paused melch turn',
    description:
      'Answers a melch turn that paused for a person, on the session_id its result named. For an approval pass approve '
      + '(true runs the call, false refuses it) and only after the person decided: never approve on your own. For a question pass answer '
      + '(the person\'s words). For an authorization, call it once the person has opened the link and granted access.',
    inputSchema: {
      type: 'object',
      properties: {
        session_id: { type: 'string', description: 'The session_id of the paused turn.' },
        approve: { type: 'boolean', description: 'The person\'s decision on a waiting approval.' },
        answer: { type: 'string', description: 'The person\'s answer to a waiting question.' },
      },
      required: ['session_id'],
      additionalProperties: false,
    },
  };

  const tools = (): Tool[] => [...[...byName.values()].map(syndicateTool), resumeTool];

  const readSessionId = (raw: unknown): string | { error: string } => {
    if (raw === undefined || raw === null || raw === '') return randomUUID();
    if (typeof raw !== 'string' || !SESSION_ID_PATTERN.test(raw)) {
      return { error: 'session_id must be a session_id an earlier result returned ([A-Za-z0-9_.:-], at most 128 characters).' };
    }
    return raw;
  };

  const call: MelchMcpServer['call'] = async (caller, toolName, rawArgs, extra = {}) => {
    const args = (rawArgs && typeof rawArgs === 'object' ? rawArgs : {}) as Record<string, unknown>;
    try {
      if (toolName === RESUME_TOOL) {
        const sid = args.session_id;
        if (typeof sid !== 'string' || !SESSION_ID_PATTERN.test(sid)) return textResult('session_id is required: the session_id of the paused turn.', true);
        const known = sessions.get(sessionKey(caller, sid));
        if (!known) {
          return textResult(
            `No paused turn is known on session ${sid}. Call the syndicate's own tool with this session_id and a message to continue it (a waiting approval is repeated, not answered).`,
            true,
          );
        }
        const syndicate = byName.get(known.syndicate);
        if (!syndicate) return textResult(`Session ${sid} belongs to a syndicate this server no longer serves.`, true);
        const pause = known.pause;
        if (!pause) return textResult(`Nothing is waiting on session ${sid}; call ${syndicate.id} with this session_id to continue the conversation.`, true);
        let parts: unknown[];
        if (pause.kind === 'approval') {
          if (typeof args.approve !== 'boolean') return textResult(`${describePause(pause, sid)}\n(approve is required: true or false.)`, true);
          parts = [{ kind: 'data', data: { approval: { id: pause.id, approved: args.approve } } }];
          log(`${RESUME_TOOL}: approval ${pause.id.slice(0, 12)} answered on session ${sid.slice(0, 8)}`);
        } else if (pause.kind === 'input') {
          if (typeof args.answer !== 'string' || !args.answer.trim()) return textResult(`${describePause(pause, sid)}\n(answer is required.)`, true);
          if (args.answer.length > MAX_MESSAGE_CHARS) return textResult(`answer is longer than ${MAX_MESSAGE_CHARS} characters.`, true);
          parts = [{ kind: 'text', text: args.answer }];
        } else {
          parts = [{ kind: 'text', text: typeof args.answer === 'string' && args.answer.trim() ? args.answer.slice(0, MAX_MESSAGE_CHARS) : 'continue' }];
        }
        return toResult(syndicate, await runTask(caller, syndicate, sid, parts, extra));
      }

      const syndicate = byName.get(toolName);
      if (!syndicate) return textResult(`Unknown tool: ${toolName}`, true);
      const message = args.message;
      if (typeof message !== 'string' || !message.trim()) return textResult('message is required: what to ask the syndicate.', true);
      if (message.length > MAX_MESSAGE_CHARS) return textResult(`message is longer than ${MAX_MESSAGE_CHARS} characters.`, true);
      const sid = readSessionId(args.session_id);
      if (typeof sid !== 'string') return textResult(sid.error, true);
      const known = sessions.get(sessionKey(caller, sid));
      if (known && known.syndicate !== syndicate.id) {
        return textResult(`Session ${sid} is a conversation with ${known.syndicate}; call that tool, or omit session_id for a new one.`, true);
      }
      // A waiting approval is answered only through melch_resume's explicit
      // approve, never by a message that happens to read "approve".
      if (known?.pause?.kind === 'approval') {
        return toResult(syndicate, { status: 'input-required', sessionId: sid, text: '', pause: known.pause });
      }
      return toResult(syndicate, await runTask(caller, syndicate, sid, [{ kind: 'text', text: message }], extra));
    } catch (err: unknown) {
      warn(`${toolName} failed: ${err instanceof Error ? err.message.split('\n')[0] : 'unknown error'}`);
      return textResult('Internal Error: the request could not be completed. See server logs for details.', true);
    }
  };

  const connect = (caller: McpCaller): Server => {
    const server = new Server({ name, version }, { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: tools() }));
    server.setRequestHandler(CallToolRequestSchema, async (req, extra) => {
      const progressToken = req.params._meta?.progressToken;
      let progress = 0;
      const onProgress = progressToken === undefined
        ? undefined
        : (message: string) => {
            progress += 1;
            void extra.sendNotification({ method: 'notifications/progress', params: { progressToken, progress, message } }).catch(() => {});
          };
      return call(caller, req.params.name, req.params.arguments ?? {}, { signal: extra.signal, ...(onProgress ? { onProgress } : {}) });
    });
    return server;
  };

  return {
    tools,
    connect,
    call,
    shutdown: (graceMs) => limiter.drain(graceMs),
    get inFlight() {
      return limiter.inFlight;
    },
  };
}

// ── Transports ───────────────────────────────────────────────────────────────

/**
 * Serve one local client over stdio. stdout carries the protocol and nothing
 * else: the bin sends every console line to stderr before anything loads.
 */
export async function serveMcpStdio(
  mcp: MelchMcpServer,
  opts: { caller?: McpCaller; stdin?: Readable; stdout?: Writable } = {},
): Promise<Server> {
  const server = mcp.connect(opts.caller ?? LOCAL_CALLER);
  await server.connect(new StdioServerTransport(opts.stdin, opts.stdout));
  return server;
}

const isLoopbackHost = (host: string) => host === '127.0.0.1' || host === '::1' || host === 'localhost';

/**
 * Why a Streamable HTTP bind must not start, or undefined. The A2A server's
 * rule (ADR 0039), without its opt-out: beyond loopback a secret is required.
 */
export function mcpBindProblem(opts: { host: string; secret?: string; minSecretLength?: number }): string | undefined {
  if (isLoopbackHost(opts.host)) return undefined;
  if (!opts.secret) {
    return `MCP_HOST=${opts.host} would expose the syndicates' tools unauthenticated. Set MCP_SERVER_SECRET (openssl rand -hex 32), or bind 127.0.0.1.`;
  }
  const min = opts.minSecretLength ?? 32;
  if (opts.secret.length < min) return `MCP_SERVER_SECRET must be at least ${min} characters on a bind beyond loopback (openssl rand -hex 32).`;
  return undefined;
}

export interface McpHttpOptions {
  /** The bind address; decides the Host-header check. Default 127.0.0.1. */
  host?: string;
  /** The bound port, for the loopback Host-header check. */
  port?: number;
  /** The bearer every request must present. Required beyond loopback (mcpBindProblem). */
  secret?: string;
  /** Host names a non-loopback bind answers to (the Host header), e.g. ['mcp.example.com']. */
  allowedHosts?: string[];
  /** Requests per minute per client IP (240, as the contract servers). */
  rateLimitPerMinute?: number;
  /** Failed authentications per 15 minutes per IP before the IP is blocked (30, as A2A). */
  authFailureMax?: number;
  /** Express trust proxy (false). */
  trustProxy?: number | boolean | string;
  /** JSON body limit ("1mb"). */
  bodyLimit?: string;
  /** Open MCP sessions at once (256); a new one past it is refused. */
  maxSessions?: number;
  /** A session idle this long is closed (30 minutes). */
  sessionIdleMs?: number;
  /** Mounted before the bearer check (the OAuth consent callback, which a browser reaches). */
  beforeAuth?: (app: Express) => void;
  warn?: (message: string) => void;
}

/**
 * Streamable HTTP at POST/GET/DELETE /mcp, stateful (Mcp-Session-Id), so a
 * cancellation reaches the request it names. Order: the Host check (DNS
 * rebinding on loopback), the request rate limit, the failed-auth limiter,
 * the constant-time bearer check, the body parser, then the transport.
 */
export function mcpHttpApp(mcp: MelchMcpServer, opts: McpHttpOptions = {}): Express & { closeSessions: () => Promise<void> } {
  const host = opts.host ?? '127.0.0.1';
  const problem = mcpBindProblem({ host, ...(opts.secret ? { secret: opts.secret } : {}) });
  if (problem) throw new Error(problem);
  const warn = opts.warn ?? ((m: string) => console.error(`[MCP] ⚠ ${m.replace(/[\r\n]/g, ' ')}`));
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', opts.trustProxy ?? false);

  if (opts.allowedHosts?.length) app.use(hostHeaderValidation(opts.allowedHosts));
  else if (isLoopbackHost(host)) app.use(hostHeaderValidation(['127.0.0.1', 'localhost', '[::1]']));

  app.get('/healthz', (_req, res) => {
    res.json({ status: 'ok' });
  });

  app.use(rateLimit({ windowMs: 60_000, limit: opts.rateLimitPerMinute ?? 240, standardHeaders: true, legacyHeaders: false }));
  opts.beforeAuth?.(app);

  app.use(
    rateLimit({
      windowMs: 15 * 60 * 1000,
      limit: opts.authFailureMax ?? 30,
      standardHeaders: true,
      legacyHeaders: false,
      skipSuccessfulRequests: true,
      requestWasSuccessful: (_req: Request, res: Response) => res.statusCode !== 401,
      message: { error: 'Too many failed authentication attempts; try again later.' },
    }),
  );
  if (opts.secret) {
    const expected = Buffer.from(opts.secret);
    app.use((req, res, next) => {
      const header = req.headers.authorization;
      const token = header?.startsWith('Bearer ') ? Buffer.from(header.substring(7)) : undefined;
      if (!token || token.length !== expected.length || !timingSafeEqual(token, expected)) {
        warn(`401 ${req.method} ${req.path.replace(/[\r\n]/g, '')} from ${String(req.ip).replace(/[\r\n]/g, '')}`);
        res.status(401).json({ error: 'Unauthorized: missing or invalid Authorization Bearer token' });
        return;
      }
      next();
    });
  }
  app.use(express.json({ limit: opts.bodyLimit ?? '1mb' }));

  const maxSessions = opts.maxSessions ?? 256;
  const idleMs = opts.sessionIdleMs ?? 30 * 60 * 1000;
  const open = new Map<string, { transport: StreamableHTTPServerTransport; server: Server; seen: number; scopeKey: string }>();
  const sweep = setInterval(() => {
    const now = Date.now();
    for (const [id, s] of open) if (now - s.seen > idleMs) void s.transport.close().catch(() => {});
  }, Math.min(idleMs, 60_000));
  sweep.unref();

  const callerOf = (req: Request): McpCaller | { error: string } => {
    const raw = req.headers['x-user-id'];
    if (raw !== undefined && raw !== '') {
      if (typeof raw !== 'string' || !HEADER_VALUE_PATTERN.test(raw)) return { error: 'Invalid X-User-Id: must match [A-Za-z0-9._-]{1,64}' };
    }
    const scopeKey = typeof raw === 'string' && raw ? raw : 'default';
    return { scopeKey, caller: opts.secret ? 'shared-secret' : 'local', ...(req.ip ? { sourceIp: req.ip } : {}) };
  };

  const handle = async (req: Request, res: Response) => {
    const id = req.headers['mcp-session-id'];
    const caller = callerOf(req);
    if ('error' in caller) {
      res.status(400).json({ error: caller.error });
      return;
    }
    if (typeof id === 'string' && id) {
      const s = open.get(id);
      if (!s) {
        res.status(404).json({ jsonrpc: '2.0', error: { code: -32001, message: 'Session not found' }, id: null });
        return;
      }
      // A session is bound to the scope that opened it.
      if (s.scopeKey !== caller.scopeKey) {
        res.status(403).json({ jsonrpc: '2.0', error: { code: -32003, message: 'This session belongs to another user' }, id: null });
        return;
      }
      s.seen = Date.now();
      await s.transport.handleRequest(req, res, req.body);
      return;
    }
    if (req.method !== 'POST' || !isInitializeRequest(req.body)) {
      res.status(400).json({ jsonrpc: '2.0', error: { code: -32000, message: 'Bad Request: no valid session id' }, id: null });
      return;
    }
    if (open.size >= maxSessions) {
      res.status(503).json({ jsonrpc: '2.0', error: { code: -32000, message: 'Too many open sessions; retry shortly' }, id: null });
      return;
    }
    const server = mcp.connect(caller);
    const transport: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (sid) => {
        open.set(sid, { transport, server, seen: Date.now(), scopeKey: caller.scopeKey });
      },
    });
    transport.onclose = () => {
      if (transport.sessionId) open.delete(transport.sessionId);
      void server.close().catch(() => {});
    };
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  };
  const safe = (req: Request, res: Response) =>
    handle(req, res).catch((err: unknown) => {
      warn(`MCP request failed: ${err instanceof Error ? err.message.split('\n')[0] : 'unknown error'}`);
      if (!res.headersSent) res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal error' }, id: null });
    });
  app.post('/mcp', safe);
  app.get('/mcp', safe);
  app.delete('/mcp', safe);

  return Object.assign(app, {
    closeSessions: async () => {
      clearInterval(sweep);
      await Promise.all([...open.values()].map((s) => s.transport.close().catch(() => {})));
      open.clear();
    },
  });
}
