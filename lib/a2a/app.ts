/**
 * lib/a2a/app.ts — the A2A server as a library: `createA2AApp(options)`
 * returns an Express app (mount it, or listen on it) plus a `shutdown()`
 * that drains in-flight tasks. `scripts/a2a_server.ts` (the
 * `melchizedek-serve` bin) is a thin wrapper that reads the environment,
 * listens, and handles signals.
 *
 * Middleware order, and why:
 *   1. /healthz, /readyz — unauthenticated, so a load balancer or
 *      Kubernetes probe needs no secret. They reveal nothing but liveness.
 *   1b. The OAuth consent callback, when `toolCredentials.consent` is set
 *      (ADR 0085): a provider redirects the person's browser to it, so it
 *      cannot carry the bearer. Its own rate limit; the single-use state
 *      nonce admits it.
 *   2. Failed-auth limiter — counts only 401s per IP, so the shared secret
 *      cannot be guessed online at whatever rate the host allows.
 *   3. Bearer check (when a secret is configured), constant-time.
 *   4. JSON body parser (configurable limit).
 *   5. BYOK headers → per-request AsyncLocalStorage context. Agent-card GETs
 *      are exempt from X-API-Key: discovery must not require a model key.
 *   6. Task rate limiter (POSTs only; polling GETs are exempt).
 *   7. Routes: the adopter's own (`routes`), DELETE /memory, the default
 *      syndicate at /a2a/*, and every other syndicate at /:agentId/a2a/*.
 *
 * State that is per-process (documented, not hidden): the A2A task store,
 * the handler cache, the rate-limiter counters. Sessions and memory are
 * durable when Supabase is configured. Run one replica, or put sticky
 * routing in front, until the task store is durable.
 *
 * Stores (ADR 0080, ADR 0107): `storage` takes the engine's SessionService
 * and MemoryService. In-process sessions are the engine's
 * InProcessSessionService. A `resolveModel` returns a model id or a
 * ModelAdapter: its type is CompileOptions'.
 *
 * MELCHIZEDEK_RUNTIME and GEMINI_ADAPTER are read before anything else:
 * `adk`, the runtime 1.0.0 removed, stops the server at startup
 * (RuntimeRemovedError), and so does GEMINI_ADAPTER=adk, the removed ADK
 * Gemini adapter (geminiAdapterSetting, lib/models/adapterResolver.ts).
 */

import express from 'express';
import type { Express, Request, Response, NextFunction, RequestHandler } from 'express';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import type { Store } from 'express-rate-limit';
import { createHash, timingSafeEqual } from 'node:crypto';
import { AGENT_CARD_PATH } from '@a2a-js/sdk';
import type { AgentCard } from '@a2a-js/sdk';
import { DefaultRequestHandler, InMemoryTaskStore } from '@a2a-js/sdk/server';
import { duplicateInterfacesForLegacy } from '@a2a-js/sdk/compat/v0_3';
import type { TaskStore } from '@a2a-js/sdk/server';
import { agentCardHandler, jsonRpcHandler, restHandler } from '@a2a-js/sdk/server/express';
import type { CompileOptions } from '../compile.ts';
import type { SessionService } from '../runtime/sessions.ts';
import type { MemoryService } from '../runtime/memoryService.ts';
import { InProcessSessionService } from '../runtime/sessions.ts';
import { runtimeSetting } from '../runtime/runtimeFlag.ts';
import { geminiAdapterSetting } from '../models/adapterResolver.ts';

import { loadSyndicate, loadSyndicateFromRegistry } from '../loadSyndicate.ts';
import type { SyndicateYamlConfig } from '../loadSyndicate.ts';
import { providerForModel, resolveModel } from '../models/registry.ts';
import type { ProviderEndpoint, ProviderId } from '../models/registry.ts';
import { createSupabaseServices, hasSupabaseCredentials } from '../persistence/supabaseProvider.ts';
import { inProcessTurnLock } from './turnLock.ts';
import type { TurnLock } from './turnLock.ts';
import { compareSchema, schemaBehindMessage, shippedSchemaVersion } from '../storage/schemaVersion.ts';
import type { RlsHardeningStatus } from '../storage/rlsStatus.ts';
import { scopeHashOf } from '../observability/audit.ts';
import { validTraceparent } from '../observability/tracer.ts';
import type { AuditSink } from '../observability/audit.ts';

/** One end user's concurrent tasks, unless maxConcurrentPerScope says otherwise (ADR 0039). */
export const DEFAULT_MAX_CONCURRENT_PER_SCOPE = 4;
import { eraseScope } from '../memory/erase.ts';
import type { EraseCounts } from '../memory/erase.ts';
import { namespacedMemoryService } from '../memory/namespace.ts';
import type { Embedder, MemoryExtractor } from '../memory/providers.ts';
import { memoryCrossesProviders, memoryDestinations } from '../memory/providers.ts';
import {
  A2A_APP_NAME,
  SyndicateExecutor,
  TaskLimiter,
  deriveUserId,
  requestContextStorage,
} from './executor.ts';
import type { A2AContext, SurfaceContext } from './executor.ts';
import { HEADER_VALUE_PATTERN, SCOPE_KEY_PATTERN } from './identity.ts';
import type { IdentityScheme } from './identity.ts';
import type { Policy } from './policy.ts';
import { createMetrics } from '../observability/metrics.ts';
import type { TaskRecord } from '../observability/metrics.ts';
import { ConsentError } from '../tools/oauthConsent.ts';
import type { OAuthConsent, ToolCredentials } from '../tools/oauthConsent.ts';
const SURFACE_HEADERS = [
  ['x-surface', 'name'],
  ['x-surface-guild', 'guild'],
  ['x-surface-channel', 'channel'],
  ['x-surface-user', 'user'],
] as const;

/** Agent ids address a config (file or "registry:<id>"): a safe charset only. */
export function isValidAgentId(agentId: string): boolean {
  return /^[A-Za-z0-9_.:-]+$/.test(agentId) && !agentId.includes('..');
}

const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);

/** True when the request's bearer is `secret` (constant-time). */
function bearerMatches(req: Request, secret: string): boolean {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) return false;
  const given = createHash('sha256').update(header.substring(7)).digest();
  return timingSafeEqual(given, createHash('sha256').update(secret).digest());
}

/** The page the person's browser lands on: what happened, and nothing else (no code, state or token). */
function consentPage(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(title)}</title></head>`
    + `<body style="font-family:system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem;line-height:1.5"><h1 style="font-size:1.25rem">${escapeHtml(title)}</h1><p>${escapeHtml(body)}</p></body></html>`;
}

/**
 * The consent callback (ADR 0085): the provider's redirect, carrying `code`
 * and `state` (or `error`). It never reads a redirect URI from the request,
 * never logs the query, and answers a page that carries no value. The
 * response is never cached and sends no referrer, since its URL holds the
 * code.
 */
export function consentCallback(
  consent: Pick<OAuthConsent, 'complete'>,
  opts: {
    resolveRequest?: A2AAppOptions['resolveRequest'];
    /** The server's bearer secret, when it has one: the authenticator is consulted only behind it. */
    serverSecret?: string;
    /** Refuse a callback whose request the authenticator does not accept. Default true (ADR 0085). */
    requireCallerIdentity?: boolean;
    log?: (m: string) => void;
    warn?: (m: string) => void;
  } = {},
): RequestHandler {
  return async (req: Request, res: Response) => {
    res.set({
      'Cache-Control': 'no-store',
      Pragma: 'no-cache',
      'Referrer-Policy': 'no-referrer',
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'",
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
    });
    // When the browser carries a credential the authenticator accepts, the caller must be the flow's user.
    // Behind a server secret the authenticator is asked only once the secret matched, as on every other
    // route: a trusted-header authenticator believes whoever reached it.
    let callerUserId: string | undefined;
    const gated = opts.serverSecret === undefined || bearerMatches(req, opts.serverSecret);
    if (opts.resolveRequest && gated) {
      try {
        callerUserId = (await opts.resolveRequest(req))?.scopeKey;
      } catch {
        callerUserId = undefined;
      }
    }
    if (opts.requireCallerIdentity !== false && callerUserId === undefined) {
      opts.warn?.('Consent callback refused: no authenticated caller.');
      res.status(401).type('html').send(consentPage('Authorization not completed', 'Sign in, then open the authorization link again.'));
      return;
    }
    try {
      const done = await consent.complete({
        state: req.query.state,
        code: req.query.code,
        error: req.query.error,
        ...(callerUserId !== undefined ? { callerUserId } : {}),
      });
      opts.log?.(`✓ Consent callback: ${done.provider} granted (scope ${scopeHashOf(done.userId)})`);
      res.status(200).type('html').send(consentPage('Authorization complete', 'You can close this window and send a message in your conversation to continue.'));
    } catch (err: unknown) {
      if (err instanceof ConsentError) {
        opts.warn?.(`Consent callback refused: ${err.code}${err.provider ? ` (${err.provider})` : ''}`);
        const status = err.code === 'exchange_failed' ? 502 : err.code === 'store_failed' ? 500 : err.code === 'wrong_user' ? 403 : 400;
        res.status(status).type('html').send(consentPage('Authorization not completed', err.message));
        return;
      }
      // Nothing from an unexpected error reaches the page or the log: it may carry a value.
      opts.warn?.('Consent callback failed unexpectedly.');
      res.status(500).type('html').send(consentPage('Authorization not completed', 'The authorization could not be completed. Ask the agent again for a new link.'));
    }
  };
}

/** What a model resolver returns, as the compiler takes it. */
type ResolvedModel = ReturnType<NonNullable<CompileOptions['resolveModel']>>;

export interface A2AAppOptions {
  /** The syndicate served at /a2a/*: a YAML name or "registry:<id>". */
  defaultSyndicate: string;
  /** Externally reachable base URL, used in agent cards. Default: http://localhost:<port>. */
  publicUrl?: string;
  /** Port the caller will listen on; used only for the default card URL. */
  port?: number;
  /** Bearer secret every request must present. Undefined = no bearer check. */
  serverSecret?: string;
  /**
   * Storage plug point (ADR 0017/0021). Default: Supabase when credentials
   * exist, else in-memory. `taskStore` builds the A2A task store for one
   * agent id (default: in-process).
   */
  storage?: {
    /** The engine's SessionService (ADR 0080, ADR 0107). */
    sessionService: SessionService;
    /** The engine's MemoryService. */
    memoryService?: MemoryService;
    taskStore?: (agentId: string) => TaskStore;
    /** Erase everything stored for a scope (DELETE /memory). Without it the route answers 501. */
    erase?: (scopeKey: string, options: { namespace?: string; includeNested?: boolean }) => Promise<EraseCounts>;
    /**
     * The database's recorded schema version (melchizedek_schema_version).
     * When given, the server refuses to start on a database behind the
     * migrations this package ships (ADR 0021).
     */
    schemaVersion?: () => Promise<number | null>;
    /**
     * Whether db/hardening.sql is in force (postgresStorage supplies it).
     * When given, the server checks it at boot like the supabase-js path:
     * fatal with `requireHardenedDb`, a warning otherwise.
     */
    rlsHardening?: () => Promise<RlsHardeningStatus>;
    /** Appends audit events (postgresStorage supplies one; ADR 0042). */
    audit?: AuditSink;
    /**
     * One turn at a time per conversation across instances (postgresStorage
     * supplies an advisory lock). Default: a lock in this process.
     */
    turnLock?: TurnLock;
    /**
     * Task leases (postgresStorage): renewed on a heartbeat while this
     * instance runs, and expired ones from dead instances marked failed.
     * `cancelRequested`, when given, lists this instance's running tasks a
     * caller asked another instance to cancel; the same heartbeat aborts
     * each, and the task ends `canceled` as an in-process cancel does.
     */
    leases?: {
      ttlMs: number;
      renew: () => Promise<number>;
      reap: () => Promise<number>;
      cancelRequested?: () => Promise<string[]>;
    };
  };
  /** How long a second turn on a busy conversation waits before it is refused, ms. Default 30 000. */
  turnLockWaitMs?: number;
  /** Start even when the database is behind the shipped migrations (the bin: ALLOW_SCHEMA_MISMATCH=true). */
  allowSchemaMismatch?: boolean;
  /**
   * Who pays for models, and how a caller's data is scoped (ADR 0017).
   *  - 'server' (default): models run on the server's credentials (env, or
   *    the `credentials` plug point); X-API-Key is not used; data is scoped by
   *    X-User-Id, else 'default'.
   *  - 'byok': the caller's X-API-Key funds its X-Provider (required on every
   *    task request), and its hash prefixes the scope so key holders stay
   *    isolated from one another. This is the pre-0.16 behaviour: a
   *    deployment with data stored under key-hash silos keeps reaching it
   *    only in this mode.
   */
  keyMode?: 'server' | 'byok';
  /**
   * Identity plug point (ADR 0017): authenticate the request your way (a JWT,
   * a gateway header, mTLS) and return the opaque scope key data is stored
   * under. Return undefined (or throw) to refuse with 401. Runs after the
   * bearer check, when one is configured. Replaces `keyMode`'s scoping but
   * not its billing: under 'byok' the caller's X-API-Key still pays unless
   * the identity supplies a key. Built-in authenticators: lib/a2a/identity.ts.
   */
  resolveRequest?: (req: Request) => RequestIdentity | undefined | Promise<RequestIdentity | undefined>;
  /** What the agent card declares for `resolveRequest` (the built-in
   *  authenticators supply it). A 'header' scheme requires `serverSecret`. */
  identityScheme?: IdentityScheme;
  /**
   * Policy plug point (ADR 0017, ADR 0026): admit or refuse each task before
   * it runs, and record what it spent. Built-in: `budgets()` in
   * lib/a2a/policy.ts. A refused task ends `rejected` with the reason.
   */
  policy?: Policy;
  /** Bearer token for GET /metrics (Prometheus). Unset = no metrics route. */
  metricsToken?: string;
  /** One record per task, however it ended (structured logs, your own metrics). */
  onTaskEnd?: (record: TaskRecord) => void;
  /**
   * Credentials plug point (ADR 0017/0023): how a provider is reached for
   * this request — from a secret manager, per tenant, anywhere. Return an
   * API key, or a partial endpoint (`baseURL`, `apiKey`, a `token` source,
   * Vertex `project`/`location`, Bedrock `region`, a `models` map) merged
   * over the environment's (lib/models/endpoints.ts). Undefined falls back to
   * the server environment. Ignored when `resolveModel` is set.
   */
  credentials?: (provider: ProviderId, ctx: A2AContext) => string | Partial<ProviderEndpoint> | undefined;
  /** Bare agent ids that resolve from the registry (ADR 0018). Others are files only. */
  registryAgents?: string[];
  /**
   * Memory plug point (ADR 0020): the fact extractor and embedder the
   * default Supabase memory service uses. Ignored when `storage` supplies a
   * memoryService. Default: from MEMORY_* environment variables (Gemini).
   */
  memory?: { extractor?: MemoryExtractor; embedder?: Embedder };
  /** Adopter routes, mounted after authentication and before the A2A routes. */
  routes?: (app: Express) => void;
  /**
   * Tool credentials for every turn (ADR 0072): the sealed per-user store,
   * and the OAuth consent step (ADR 0085, lib/tools/oauthConsent.ts). With
   * `consent`, a call whose provider the user has not granted ends its task
   * input-required with a `consent_request` data part, and the server mounts
   * the consent callback (GET at the path of the consent's configured
   * redirect URI): it completes the authorization-code flow with PKCE and
   * stores the grant. The callback is reached by the person's browser, so it
   * sits before the bearer check; it has its own rate limit, and when the
   * request carries a credential the authenticator accepts, the caller must
   * be the user the flow is for.
   */
  toolCredentials?: ToolCredentials & {
    /** Callback requests per window per client IP. Default 30 per 15 minutes. */
    callbackLimit?: { windowMs: number; max: number };
    /**
     * Refuse a callback whose request the authenticator does not accept.
     * Default true: the browser that completes the grant must carry the
     * flow's user's identity (a session cookie or a gateway header that
     * resolveRequest reads), so a forwarded authorization link cannot link
     * someone else's account (ADR 0085). false lets the state nonce alone
     * bind the flow to its user, for a deployment whose browsers carry no
     * identity and that accepts that risk.
     */
    requireCallerIdentity?: boolean;
  };
  /** Refuse to start when Supabase hardening is missing (public deployments). */
  requireHardenedDb?: boolean;
  /** Wall-clock budget per task, ms. 0 = none. */
  taskTimeoutMs?: number;
  /**
   * Stream each answer as the model writes it, as chunks of an `answer`
   * artifact on message/stream (the bin: A2A_STREAM_TEXT=true). A syndicate
   * with guards never streams. The final status message is unchanged.
   */
  streamText?: boolean;
  /** Concurrent tasks across all agents. 0 = unlimited. */
  maxConcurrentTasks?: number;
  /**
   * Where audit events go: failed authentications, task outcomes, erasures
   * (ADR 0042). Default: the storage's sink when it has one, else none.
   */
  audit?: AuditSink;
  /** Concurrent tasks for one scope (one end user). Default 4; 0 = unlimited. */
  maxConcurrentPerScope?: number;
  /** Concurrent tasks for one authenticated caller. Default 0 (unlimited). */
  maxConcurrentPerCaller?: number;
  /** Task submissions (POST) per window per client IP. */
  rateLimit?: { windowMs: number; max: number };
  /**
   * Where the limiters count (ADR 0021 item 5). Default: in this process, so
   * each replica has its own window. A shared store (redisRateLimitStore)
   * makes the limits hold across replicas. Called once per limiter.
   */
  limitStore?: (limiter: 'task' | 'auth-failure') => Store;
  /** Failed authentications per window per client IP before the IP is blocked. */
  authFailureLimit?: { windowMs: number; max: number };
  /** Express `trust proxy` setting (hop count, boolean, or subnet list). */
  trustProxy?: number | boolean | string;
  /** JSON body size limit, e.g. "1mb". */
  bodyLimit?: string;
  /**
   * Allowlist of agent ids reachable at /:agentId/*. Undefined = any id with
   * a file in the deployment's own agents directory. Ids listed here may also
   * resolve to the shipped examples/ and templates/; unlisted ids never do,
   * so a missing file cannot be answered by a public example (ADR 0018).
   */
  servedAgents?: string[];
  /**
   * Model resolution per request. Default: lib/models/registry.ts with the
   * caller's X-API-Key scoped to its X-Provider. Override to route through
   * your own gateway or credential store. Returns what
   * CompileOptions.resolveModel returns: a model id, or a ModelAdapter
   * (lib/models/contract.ts).
   */
  resolveModel?: (modelName: string | undefined, ctx: A2AContext) => ResolvedModel;
  /** Bindings applied at every config load (e.g. current_date). */
  bindings?: () => Record<string, string>;
  log?: (message: string) => void;
  warn?: (message: string) => void;
}

/** What the identity plug point returns for an authenticated request. */
export interface RequestIdentity {
  /** Opaque key the caller's sessions and memory are stored under: [A-Za-z0-9._/-], ≤ 160. */
  scopeKey: string;
  /** A provider key for this request (BYOK-style). */
  apiKey?: string;
  /** The provider `apiKey` belongs to. */
  provider?: string;
  /** Which caller this is, for logs (a caller name, 'jwt', …). */
  caller?: string;
  /** The scope owns `<scopeKey>/…` beneath it (a caller's end users), so an
   *  erasure with no end user removes those too. */
  ownsNested?: boolean;
  /** An operator-issued credential (a backend), not an end user: what an
   *  operator-only adopter route checks (`currentRequestContext().operator`). */
  operator?: boolean;
}

const legacyCompat = { enabled: true };

/**
 * The authenticated caller of the request being handled, for adopter routes
 * (`routes` option): its scope key, caller name and whether it holds an
 * operator credential. Undefined outside a request or before authentication.
 */
export function currentRequestContext(): A2AContext | undefined {
  return requestContextStorage.getStore();
}

/**
 * The A2A user for a request: the caller's scope key, as resolved by the
 * identity middleware. The task store keys tasks by this owner, so one
 * caller cannot read, follow or cancel another's task by its id.
 */
const scopeUserBuilder = async () => {
  const ctx = requestContextStorage.getStore();
  const userName = ctx?.scopeKey ?? '';
  return { get isAuthenticated() { return !!userName; }, get userName() { return userName; } };
};

export interface A2AApp {
  app: Express;
  /** The default syndicate's resolved config. */
  config: SyndicateYamlConfig;
  /** Session backend in use: durable, or process memory. */
  sessionBackend: 'durable' | 'in-memory';
  /** Stop admitting tasks, wait up to `graceMs` for running ones, cancel the rest.
   *  Resolves with the number of tasks that had to be canceled. */
  shutdown(graceMs: number): Promise<number>;
  /**
   * Fail `/readyz` from now on while still serving every request, so a load
   * balancer stops routing here before the listener closes. The first step of
   * a graceful stop; `shutdown()` is the last.
   */
  markUnready(): void;
}

interface Handlers {
  /** Serves this agent's card, with URLs for the base the request reached. */
  card: RequestHandler;
  jsonRpc: RequestHandler;
  rest: RequestHandler;
}

/**
 * Build the agent card for one syndicate at one route prefix, in the A2A 1.0
 * shape. Each transport is advertised twice — once for 1.0 clients and once
 * (protocolVersion 0.3) for the 0.3 clients most platforms still run — and
 * the card handler serves a 0.3-shaped card to a request that asks for 0.3
 * (or sends no A2A-Version header, which the spec says means 0.3).
 */
export function compileAgentCard(
  config: SyndicateYamlConfig,
  opts: {
    baseUrl: string;
    routePrefix?: string;
    /** The server secret is checked (A2A_SERVER_SECRET). */
    bearer: boolean;
    /** The plugged-in authenticator's scheme, when there is one. */
    identity?: IdentityScheme;
    version: string;
    byok?: boolean;
  },
): AgentCard {
  const base = `${opts.baseUrl.replace(/\/$/, '')}${opts.routePrefix ?? ''}`;
  const securitySchemes: AgentCard['securitySchemes'] = {};
  if (opts.byok) {
    securitySchemes.apiKey = {
      scheme: {
        $case: 'apiKeySecurityScheme',
        value: {
          description: "The caller's model-provider key (BYOK). Required on every task request.",
          location: 'header',
          name: 'X-API-Key',
        },
      },
    };
  }
  if (opts.identity?.type === 'bearer') {
    // The authenticator reads the bearer itself (caller tokens, a JWT).
    securitySchemes.bearer = {
      scheme: {
        $case: 'httpAuthSecurityScheme',
        value: { description: opts.identity.description, scheme: 'bearer', bearerFormat: opts.identity.bearerFormat ?? '' },
      },
    };
  } else if (opts.bearer) {
    securitySchemes.bearer = {
      scheme: {
        $case: 'httpAuthSecurityScheme',
        value: { description: 'The server secret (A2A_SERVER_SECRET).', scheme: 'bearer', bearerFormat: '' },
      },
    };
  }
  if (opts.identity?.type === 'header') {
    securitySchemes.identity = {
      scheme: {
        $case: 'apiKeySecurityScheme',
        value: { description: opts.identity.description, location: 'header', name: opts.identity.name },
      },
    };
  }
  const requirement: Record<string, { list: string[] }> = {};
  for (const name of Object.keys(securitySchemes)) requirement[name] = { list: [] };
  return {
    name: config.orchestrator.name,
    description: config.orchestrator.description || 'Syndicate Orchestrator Agent',
    supportedInterfaces: duplicateInterfacesForLegacy(
      [
        { url: `${base}/a2a/jsonrpc`, protocolBinding: 'JSONRPC', tenant: '', protocolVersion: '1.0' },
        { url: `${base}/a2a/rest`, protocolBinding: 'HTTP+JSON', tenant: '', protocolVersion: '1.0' },
      ],
      ['JSONRPC', 'HTTP+JSON'],
    ),
    provider: undefined,
    version: opts.version,
    capabilities: {
      // SendStreamingMessage is served: progress arrives as `[STATUS]`
      // working updates and the answer as the final status message.
      streaming: true,
      pushNotifications: false,
      extensions: [],
    },
    securitySchemes,
    securityRequirements: Object.keys(requirement).length ? [{ schemes: requirement }] : [],
    defaultInputModes: ['text/plain', 'application/json'],
    defaultOutputModes: ['text/plain'],
    skills: (config.subagents ?? []).map((sub) => ({
      id: sub.name,
      name: sub.name,
      description: sub.description || 'Subagent collaborator',
      tags: sub.tools || [],
      examples: [],
      inputModes: [],
      outputModes: [],
      securityRequirements: [],
    })),
    signatures: [],
  };
}

/**
 * The app name a syndicate's sessions and memory are stored under: its
 * declared `memory_namespace` (ADR 0020), else the server-wide name every
 * syndicate shared before namespaces existed — kept so data stored then
 * stays reachable.
 */
export function memoryAppName(cfg: SyndicateYamlConfig): string {
  return cfg.memory_namespace || A2A_APP_NAME;
}

export async function createA2AApp(options: A2AAppOptions): Promise<A2AApp> {
  // A deployment still configured for the removed adk runtime fails here, naming 1.0.0 (ADR 0107).
  runtimeSetting();
  geminiAdapterSetting();
  const log = options.log ?? ((m: string) => console.log(`[A2A] ${m}`));
  const warn = options.warn ?? ((m: string) => console.warn(`[A2A] ⚠ ${m}`));
  const bindings = options.bindings ?? (() => ({
    current_date: new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' }),
  }));
  const baseUrl = options.publicUrl || `http://localhost:${options.port ?? 4000}`;
  const keyMode = options.keyMode ?? 'server';
  // Billing and scoping are separate (ADR 0025): 'byok' always means the
  // caller's X-API-Key pays; it decides the scope only when no
  // authenticator is plugged in (the pre-0.16 key-hash silo).
  const byokBilling = keyMode === 'byok';
  const byokScoping = byokBilling && !options.resolveRequest;
  if (options.identityScheme?.type === 'header' && !options.serverSecret) {
    throw new Error('A trusted-header authenticator needs serverSecret: without it any client could set the header.');
  }

  // ── The default syndicate ──────────────────────────────────────────────────
  const config = options.defaultSyndicate.startsWith('registry:')
    ? await loadSyndicateFromRegistry(options.defaultSyndicate.slice('registry:'.length), { bindings: bindings() })
    : loadSyndicate(options.defaultSyndicate, { bindings: bindings() });

  // ── Persistence ────────────────────────────────────────────────────────────
  let durableSessions: SessionService | undefined;
  let memoryService: MemoryService | undefined;
  let erase: NonNullable<A2AAppOptions['storage']>['erase'];
  let readSchemaVersion: (() => Promise<number | null>) | undefined;
  let checkHardening: (() => Promise<RlsHardeningStatus>) | undefined;
  if (options.storage) {
    durableSessions = options.storage.sessionService;
    memoryService = options.storage.memoryService;
    erase = options.storage.erase;
    readSchemaVersion = options.storage.schemaVersion;
    checkHardening = options.storage.rlsHardening;
  } else if (hasSupabaseCredentials()) {
    // ADR 0021 item 6: the supabase-js path stays for a transition period.
    warn('Storage: supabase-js over the Supabase REST API is deprecated (ADR 0021). Set DATABASE_URL to the '
      + "database's Postgres connection string to use postgresStorage instead.");
    // Embeddings and fact extraction use the SERVER's Gemini key: memory is
    // operator infrastructure, like tools.
    const services = await createSupabaseServices({
      apiKey: process.env.GOOGLE_GENAI_API_KEY || process.env.GEMINI_API_KEY || '',
      withMemory: true,
      extractor: options.memory?.extractor,
      embedder: options.memory?.embedder,
    });
    durableSessions = services.sessionService;
    memoryService = services.memoryService;
    erase = (scopeKey, eraseOpts) => eraseScope(services.rpcClient, scopeKey, eraseOpts);
    readSchemaVersion = services.schemaVersion;
    checkHardening = services.checkRlsHardening;
  }
  // Both storage paths: refuse a public deployment whose tables an API key can read.
  if (checkHardening) {
    const rls = await checkHardening();
    if (rls.applied) {
      log(`✓ DB hardening verified — ${rls.detail}.`);
    } else if (options.requireHardenedDb) {
      throw new Error(
        `Supabase hardening is missing (${rls.detail}). User transcripts and memory facts are exposed `
        + 'to the anon API key. Run db/hardening.sql, or set ALLOW_UNHARDENED_DB=true to accept the risk.',
      );
    } else {
      warn(`Supabase hardening not applied — ${rls.detail}. Run db/hardening.sql before serving real user data.`);
    }
  }
  // ADR 0021 item 3: refuse a database behind the migrations this code needs.
  if (readSchemaVersion) {
    const check = compareSchema(await readSchemaVersion(), shippedSchemaVersion());
    if (check.state === 'match') {
      log(`✓ DB schema version ${check.shipped}.`);
    } else if (check.state === 'ahead') {
      warn(`DB schema version ${check.db} is newer than this server's ${check.shipped} (a later migration was applied first); continuing.`);
    } else if (options.allowSchemaMismatch) {
      warn(`${schemaBehindMessage(check)} Continuing because the mismatch is allowed.`);
    } else {
      throw new Error(schemaBehindMessage(check));
    }
  }
  // ADR 0020 item 5: an embedder whose vectors do not fit the stored column
  // would fail every insert; refuse to start instead.
  const verifyDims = (memoryService as { verifyEmbeddingDimensions?: () => Promise<void> } | undefined)?.verifyEmbeddingDimensions;
  if (verifyDims) await verifyDims.call(memoryService);
  const sessionBackend: A2AApp['sessionBackend'] = durableSessions ? 'durable' : 'in-memory';
  // Shared by every executor, so a conversation is serialised whichever
  // agent route reaches it.
  const turnLock: TurnLock = options.storage?.turnLock ?? inProcessTurnLock();

  // Task leases: a task left running by an instance that died is failed
  // rather than polled forever (ADR 0021). Reap once now, then on a timer.
  const leaseTimers: NodeJS.Timeout[] = [];
  const leases = options.storage?.leases;
  if (leases) {
    const reap = async () => {
      try {
        const n = await leases.reap();
        if (n) warn(`Failed ${n} task(s) left running by a stopped instance.`);
      } catch (err: unknown) {
        warn(`Task lease reaping failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    };
    await reap();
    const renew = async () => {
      try {
        await leases.renew();
      } catch (err: unknown) {
        warn(`Task lease renewal failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    };
    leaseTimers.push(setInterval(renew, Math.max(1000, Math.floor(leases.ttlMs / 3))).unref());
    leaseTimers.push(setInterval(reap, Math.max(1000, leases.ttlMs)).unref());
  }

  /**
   * Session and memory services for one syndicate, honouring its
   * `memory_system`: `internal-only` keeps transcripts in process memory
   * even when Supabase is configured (the docs promise "nothing persists"),
   * and only `long-term` syndicates get the memory service.
   */
  const internalSessions = new InProcessSessionService();
  // Long-term memory sends transcripts to its extraction and embedding
  // providers; say so once per syndicate when they are not the agents' own.
  const memoryFlowWarned = new Set<string>();
  const warnMemoryFlow = (cfg: SyndicateYamlConfig) => {
    if (memoryFlowWarned.has(cfg.syndicate_name)) return;
    memoryFlowWarned.add(cfg.syndicate_name);
    const dest = memoryDestinations(process.env, { extractor: options.memory?.extractor, embedder: options.memory?.embedder });
    const models = [cfg.orchestrator?.model, ...(cfg.subagents ?? []).map((s) => s.model)];
    const crossed = memoryCrossesProviders(models, dest);
    if (crossed.length) {
      warn(
        `'${cfg.syndicate_name}' keeps long-term memory, so its transcripts also go to ${crossed.join(' and ')} `
          + `(extraction: ${dest.extraction}, embeddings: ${dest.embeddings}), which its agents do not use. `
          + 'Set MEMORY_EXTRACTION_MODEL and MEMORY_EMBEDDING_PROVIDER to keep memory on an approved provider.',
      );
    }
  };
  const servicesFor = (cfg: SyndicateYamlConfig) => {
    const mode = cfg.memory_system;
    const sessionService = mode === 'internal-only' || !durableSessions ? internalSessions : durableSessions;
    // Pinned to the syndicate's namespace (ADR 0020), so every agent the
    // turn reaches — including subagents, which run under their own app
    // name — recalls and stores in the root syndicate's memory.
    const memory = mode === 'long-term' && memoryService ? namespacedMemoryService(memoryService, memoryAppName(cfg)) : undefined;
    if (memory) warnMemoryFlow(cfg);
    if (mode === 'long-term' && !memoryService) {
      warn(`'${cfg.syndicate_name}' requests long-term memory but Supabase is not configured — memory disabled.`);
    }
    if ((mode === 'session-only' || mode === 'long-term') && !durableSessions) {
      warn(`'${cfg.syndicate_name}' requests ${mode} sessions but Supabase is not configured — sessions live in process memory and are lost on restart.`);
    }
    return { sessionService, memoryService: memory, durable: sessionService !== internalSessions };
  };

  const audit: AuditSink | undefined = options.audit ?? options.storage?.audit;
  const limiter = new TaskLimiter(options.maxConcurrentTasks ?? 0, {
    perScope: options.maxConcurrentPerScope ?? DEFAULT_MAX_CONCURRENT_PER_SCOPE,
    perCaller: options.maxConcurrentPerCaller ?? 0,
  });
  // A cancel that reached another instance (ADR 0113): on the lease
  // heartbeat, abort each run here that was asked to stop. The abort is
  // idempotent; it is logged once per task, by its id's prefix only.
  if (leases?.cancelRequested) {
    const cancelRequested = leases.cancelRequested;
    const aborted = new Set<string>();
    const honourCancels = async () => {
      try {
        const ids = new Set(await cancelRequested());
        for (const id of aborted) if (!ids.has(id)) aborted.delete(id);
        for (const id of ids) {
          if (limiter.cancel(id) && !aborted.has(id)) {
            aborted.add(id);
            log(`Cancel requested for task ${id.slice(0, 8)} through another instance`);
          }
        }
      } catch (err: unknown) {
        warn(`Task cancel check failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    };
    leaseTimers.push(setInterval(honourCancels, Math.max(1000, Math.floor(leases.ttlMs / 3))).unref());
  }
  const metrics = options.metricsToken ? createMetrics() : undefined;
  const onTaskEnd = (record: TaskRecord) => {
    metrics?.observeTask(record);
    options.onTaskEnd?.(record);
  };
  // The YAML model id always wins (its prefix names the provider). What
  // differs is whose credential pays: an adopter's resolver, the
  // credentials plug point, the caller's key (byok), or the server's env.
  const modelResolverFor = (ctx: A2AContext) => (modelName?: string) => {
    if (options.resolveModel) return options.resolveModel(modelName, ctx);
    if (options.credentials) {
      const provider = providerForModel(modelName ?? '');
      const given = options.credentials(provider, ctx);
      if (typeof given === 'string') {
        return given ? resolveModel(modelName, { apiKey: given, defaultProvider: provider }) : resolveModel(modelName);
      }
      if (given) {
        return resolveModel(modelName, { endpoint: given, ...(given.apiKey ? { apiKey: given.apiKey, defaultProvider: provider } : {}) });
      }
      return resolveModel(modelName);
    }
    if (ctx.apiKey) return resolveModel(modelName, { apiKey: ctx.apiKey, defaultProvider: ctx.provider });
    return resolveModel(modelName);
  };
  const compileFor = (ctx: A2AContext) => ({
    resolveModel: modelResolverFor(ctx),
    onUnknownTool: (name: string) => warn(`Unknown tool '${name}' — skipping.`),
    log,
  });

  // Memory retention (ADR 0020 item 7): a syndicate with
  // memory_retention_days has its namespace pruned when first loaded, then
  // daily. Keyed by namespace, so syndicates sharing one prune it once.
  const retentionTimers = new Map<string, NodeJS.Timeout>();
  const scheduleRetention = (cfg: SyndicateYamlConfig, memory: MemoryService | undefined) => {
    const days = cfg.memory_retention_days;
    const namespace = cfg.memory_namespace;
    const prune = (memory as { pruneExpired?: (ns: string, d: number) => Promise<number | null> } | undefined)?.pruneExpired;
    if (!days || !namespace || !prune || retentionTimers.has(namespace)) return;
    const run = () =>
      prune.call(memory, namespace, days).catch((err: unknown) =>
        warn(`Memory retention for ${namespace} failed: ${err instanceof Error ? err.message : String(err)}`),
      );
    void run();
    retentionTimers.set(namespace, setInterval(run, 24 * 60 * 60 * 1000).unref());
  };

  const buildHandlers = (cfg: SyndicateYamlConfig, routePrefix: string, agentId: string): Handlers => {
    const services = servicesFor(cfg);
    scheduleRetention(cfg, services.memoryService);
    const executor = new SyndicateExecutor({
      config: cfg,
      sessionService: services.sessionService,
      memoryService: services.memoryService,
      compileFor,
      taskTimeoutMs: options.taskTimeoutMs,
      streamText: options.streamText,
      turnLock,
      turnLockWaitMs: options.turnLockWaitMs,
      ...(options.toolCredentials ? { toolCredentials: { store: options.toolCredentials.store, ...(options.toolCredentials.consent ? { consent: options.toolCredentials.consent } : {}) } } : {}),
      limiter,
      agentId,
      policy: options.policy,
      onTaskEnd,
      onAudit: audit,
      log,
      warn,
    });
    const version = executor.configHashFor().slice(0, 12);
    const cardFor = (base: string) =>
      compileAgentCard(cfg, {
        baseUrl: base,
        routePrefix,
        bearer: !!options.serverSecret,
        identity: options.resolveRequest ? options.identityScheme : undefined,
        version,
        byok: byokBilling,
      });
    const card = cardFor(baseUrl);
    const taskStore = options.storage?.taskStore?.(agentId) ?? new InMemoryTaskStore();
    const handler = new DefaultRequestHandler(card, taskStore, executor);
    return {
      // With PUBLIC_URL the card names that base. Without it, the base is
      // the one this request reached — a server on port 4097 must not
      // advertise :4000, and a client that follows the card must land here.
      card: options.publicUrl
        ? (agentCardHandler({ agentCardProvider: handler, legacyCompat }) as RequestHandler)
        : (req: Request, res: Response, next: NextFunction) => {
            const base = `${req.protocol}://${req.get('host') ?? `localhost:${options.port ?? 4000}`}`;
            const perRequest = agentCardHandler({ agentCardProvider: async () => cardFor(base), legacyCompat }) as RequestHandler;
            perRequest(req, res, next);
          },
      // legacyCompat: A2A 0.3 requests (method names, part shapes, enum
      // spellings) are translated to and from 1.0, so 0.3 clients keep working.
      jsonRpc: jsonRpcHandler({ requestHandler: handler, userBuilder: scopeUserBuilder, legacyCompat }) as RequestHandler,
      rest: restHandler({ requestHandler: handler, userBuilder: scopeUserBuilder, legacyCompat }) as RequestHandler,
    };
  };

  const app = express();
  app.set('trust proxy', options.trustProxy ?? 1);
  app.disable('x-powered-by');

  // ── 1. Health ──────────────────────────────────────────────────────────────
  app.get('/healthz', (_req, res) => {
    res.json({ status: 'ok' });
  });
  // Prometheus scrape, behind its own token: a scraper is not a caller.
  if (options.metricsToken) {
    const expected = createHash('sha256').update(options.metricsToken).digest();
    app.get('/metrics', (req, res) => {
      const header = req.headers.authorization ?? '';
      const given = createHash('sha256').update(header.startsWith('Bearer ') ? header.slice(7) : '').digest();
      if (!timingSafeEqual(given, expected)) {
        res.status(401).json({ error: 'Unauthorized' });
        return;
      }
      res.type('text/plain; version=0.0.4').send(metrics!.render(limiter.inFlight));
    });
  }
  // Readiness: not while stopping, and not while durable storage is
  // unreachable (a turn there would fail). The reason is logged once per
  // change of state, never per probe, and the answer names no host.
  let unready = false;
  let storageDown = false;
  // /readyz is unauthenticated, so the database is asked at most once per
  // READY_CACHE_MS however often it is probed; concurrent probes share the
  // one check in flight.
  const READY_CACHE_MS = 2_000;
  let lastCheck: { at: number; ok: boolean } | undefined;
  let checking: Promise<boolean> | undefined;
  const checkStorage = async (): Promise<boolean> => {
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        readSchemaVersion!(),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('no answer within 2 s')), 2_000); }),
      ]);
      if (storageDown) log('readyz: the database answers again.');
      storageDown = false;
      return true;
    } catch (err: unknown) {
      if (!storageDown) warn(`readyz: the database is unreachable (${err instanceof Error ? err.message : String(err)}); reporting not ready.`);
      storageDown = true;
      return false;
    } finally {
      clearTimeout(timer);
    }
  };
  const storageReachable = async (): Promise<boolean> => {
    if (!readSchemaVersion) return true;
    if (lastCheck && Date.now() - lastCheck.at < READY_CACHE_MS) return lastCheck.ok;
    checking ??= checkStorage().then((ok) => {
      lastCheck = { at: Date.now(), ok };
      checking = undefined;
      return ok;
    });
    return checking;
  };
  app.get('/readyz', async (_req, res) => {
    if (unready || limiter.isDraining) {
      res.status(503).json({ status: 'draining' });
      return;
    }
    if (!(await storageReachable())) {
      res.status(503).json({ status: 'unavailable', reason: 'storage' });
      return;
    }
    res.json({ status: 'ready', sessions: sessionBackend, inFlight: limiter.inFlight });
  });

  // ── 1b. The OAuth consent callback (ADR 0085) ─────────────────────────────
  // The provider redirects the person's browser here, so it cannot carry the
  // A2A bearer: it sits before the bearer check, behind its own rate limit.
  // The state nonce (single-use, expiring, bound to the user, the session
  // and the paused call) is what admits it.
  const consent = options.toolCredentials?.consent;
  if (consent) {
    const callbackLimit = options.toolCredentials?.callbackLimit ?? { windowMs: 15 * 60 * 1000, max: 30 };
    app.get(
      new URL(consent.redirectUri).pathname,
      rateLimit({
        windowMs: callbackLimit.windowMs,
        max: callbackLimit.max,
        standardHeaders: true,
        legacyHeaders: false,
        message: { error: 'Too many authorization attempts; try again later.' },
      }),
      consentCallback(consent, {
        resolveRequest: options.resolveRequest,
        ...(options.serverSecret ? { serverSecret: options.serverSecret } : {}),
        requireCallerIdentity: options.toolCredentials?.requireCallerIdentity !== false,
        log,
        warn,
      }),
    );
  }

  // ── 2–3. Authentication ───────────────────────────────────────────────────
  const failWindow = options.authFailureLimit ?? { windowMs: 15 * 60 * 1000, max: 30 };
  app.use(
    rateLimit({
      windowMs: failWindow.windowMs,
      max: failWindow.max,
      standardHeaders: true,
      legacyHeaders: false,
      // Only failed authentications count; a valid caller never spends this.
      skipSuccessfulRequests: true,
      requestWasSuccessful: (_req: Request, res: Response) => res.statusCode !== 401,
      ...(options.limitStore ? { store: options.limitStore('auth-failure') } : {}),
      message: { error: 'Too many failed authentication attempts; try again later.' },
    }),
  );
  const rejectAuth = (req: Request, res: Response, error: string) => {
    warn(`401 ${req.method} ${req.path} from ${req.ip}: ${error}`);
    try {
      audit?.({ event: 'auth.failure', outcome: 'denied', sourceIp: req.ip, detail: { method: req.method, path: req.path, reason: error } });
    } catch {
      /* the refusal stands whatever the sink does */
    }
    res.status(401).json({ error });
  };
  if (options.serverSecret) {
    const expected = Buffer.from(options.serverSecret);
    app.use((req, res, next) => {
      const header = req.headers.authorization;
      if (!header || !header.startsWith('Bearer ')) {
        rejectAuth(req, res, 'Unauthorized: Missing or invalid Authorization Bearer token');
        return;
      }
      const token = Buffer.from(header.substring(7));
      if (token.length !== expected.length || !timingSafeEqual(token, expected)) {
        rejectAuth(req, res, 'Unauthorized: Invalid Authorization Bearer token');
        return;
      }
      next();
    });
  }

  // ── 4. Body ────────────────────────────────────────────────────────────────
  app.use(express.json({ limit: options.bodyLimit ?? '1mb' }));

  // ── 5. Caller context: who is calling, and whose data this is ──────────
  // Agent-card GETs need no caller context: discovery must not require a
  // model key or an identity.
  const isCardRequest = (req: Request) =>
    req.method === 'GET' && (req.path.endsWith('/agent-card.json') || req.path.endsWith('/agent.json'));
  let warnedIgnoredKey = false;
  app.use(async (req, res, next) => {
    if (isCardRequest(req)) {
      // A card is behind the same credential as the agent, never public:
      // with no server-secret gate, the authenticator itself must accept
      // the request (a model key is still not needed to read a card).
      if (options.resolveRequest && !options.serverSecret) {
        let identity: RequestIdentity | undefined;
        try {
          identity = await options.resolveRequest(req);
        } catch (err: unknown) {
          warn(`resolveRequest refused ${req.method} ${req.path}: ${err instanceof Error ? err.message : String(err)}`);
        }
        if (!identity) {
          rejectAuth(req, res, 'Unauthorized');
          return;
        }
      }
      next();
      return;
    }
    // X-Surface-*: telemetry only. A bad value is refused, not dropped — a
    // silently ignored header makes a dashboard lie about coverage.
    let surface: SurfaceContext | undefined;
    for (const [header, field] of SURFACE_HEADERS) {
      const raw = req.headers[header] as string | undefined;
      if (raw === undefined || raw === '') continue;
      if (!HEADER_VALUE_PATTERN.test(raw)) {
        res.status(400).json({ error: `Invalid ${header}: must match [A-Za-z0-9._-]{1,64}` });
        return;
      }
      if (field === 'name') {
        surface = { name: raw };
        continue;
      }
      if (!surface) {
        res.status(400).json({ error: `${header} requires X-Surface to name the surface` });
        return;
      }
      surface[field] = raw;
    }

    // The adopter's identity system decides, when one is plugged in.
    if (options.resolveRequest) {
      let identity: RequestIdentity | undefined;
      try {
        identity = await options.resolveRequest(req);
      } catch (err: unknown) {
        warn(`resolveRequest refused ${req.method} ${req.path}: ${err instanceof Error ? err.message : String(err)}`);
      }
      if (!identity) {
        rejectAuth(req, res, 'Unauthorized');
        return;
      }
      if (!SCOPE_KEY_PATTERN.test(identity.scopeKey)) {
        warn(`resolveRequest returned an invalid scopeKey for ${req.path}`);
        res.status(500).json({ error: 'Server identity configuration error.' });
        return;
      }
      // Billing follows keyMode, whoever the caller is: under 'byok' the
      // caller's own X-API-Key funds its X-Provider unless the identity
      // supplied a key (a per-tenant key from a secret manager, say).
      let apiKey = identity.apiKey ?? '';
      let provider = identity.provider ?? ((req.headers['x-provider'] as string | undefined) || 'google');
      if (!apiKey && byokBilling) {
        apiKey = (req.headers['x-api-key'] as string | undefined) ?? '';
        if (!apiKey) {
          rejectAuth(req, res, 'Unauthorized: Missing X-API-Key header');
          return;
        }
      }
      if (identity.apiKey && !identity.provider) provider = 'google';
      requestContextStorage.run(
        {
          apiKey,
          provider,
          scopeKey: identity.scopeKey,
          surface,
          caller: identity.caller,
          ownsNested: identity.ownsNested ?? false,
          operator: identity.operator ?? false,
          sourceIp: req.ip, traceparent: validTraceparent(req.headers.traceparent),
        },
        () => next(),
      );
      return;
    }

    // X-User-Id: the caller's own end-user id. The calling backend (which
    // passed the bearer check) authenticates its users before sending it.
    const rawUserId = req.headers['x-user-id'] as string | undefined;
    let siteUserId: string | undefined;
    if (rawUserId !== undefined && rawUserId !== '') {
      if (!HEADER_VALUE_PATTERN.test(rawUserId)) {
        res.status(400).json({ error: 'Invalid X-User-Id: must match [A-Za-z0-9._-]{1,64}' });
        return;
      }
      siteUserId = rawUserId;
    }
    const apiKey = req.headers['x-api-key'] as string | undefined;
    const provider = (req.headers['x-provider'] as string | undefined) || 'google';

    if (byokScoping) {
      if (!apiKey) {
        rejectAuth(req, res, 'Unauthorized: Missing X-API-Key header');
        return;
      }
      // The caller's key funds its provider, and its hash prefixes the scope
      // so no key holder can reach another's data.
      const scopeKey = deriveUserId({ apiKey, siteUserId });
      requestContextStorage.run(
        { apiKey, provider, siteUserId, scopeKey, surface, caller: 'shared-secret', ownsNested: !siteUserId, operator: !!options.serverSecret, sourceIp: req.ip, traceparent: validTraceparent(req.headers.traceparent) },
        () => next(),
      );
      return;
    }

    // Server mode: the server's credentials pay; X-API-Key is not used.
    if (apiKey && !warnedIgnoredKey) {
      warnedIgnoredKey = true;
      warn('A caller sent X-API-Key, which server key mode ignores. Set A2A_KEY_MODE=byok (keyMode: \'byok\') if callers fund their own inference — and to keep reaching sessions and memory stored under key-hash silos.');
    }
    requestContextStorage.run(
      {
        apiKey: '',
        provider,
        siteUserId,
        scopeKey: siteUserId ?? 'default',
        surface,
        // Everyone holding the secret is one caller; without a secret (loopback) the caller is local.
        caller: options.serverSecret ? 'shared-secret' : 'local',
        operator: !!options.serverSecret,
        sourceIp: req.ip, traceparent: validTraceparent(req.headers.traceparent),
      },
      () => next(),
    );
  });

  // ── 6. Task rate limit ────────────────────────────────────────────────────
  // Runaway/cost protection for authenticated callers. GETs (task polling)
  // are exempt; the limit targets task submissions.
  const rl = options.rateLimit ?? { windowMs: 15 * 60 * 1000, max: 60 };
  app.use(
    rateLimit({
      windowMs: rl.windowMs,
      max: rl.max,
      standardHeaders: true,
      legacyHeaders: false,
      skip: (req) => req.method === 'GET',
      ...(options.limitStore ? { store: options.limitStore('task') } : {}),
      // With an authenticator, the limit is per identity: an operator's
      // backend by its caller name, an end user by their scope, so callers
      // behind one NAT or proxy do not share a bucket. The shared secret
      // alone identifies nobody, so it stays per IP.
      keyGenerator: (req) => {
        const ctx = requestContextStorage.getStore();
        if (options.resolveRequest && ctx?.caller) {
          return ctx.operator ? `caller:${ctx.caller}` : `scope:${ctx.scopeKey}`;
        }
        return ipKeyGenerator(req.ip ?? '');
      },
      message: { error: 'Too many requests, please try again later.' },
    }),
  );

  // ── 7. Routes ──────────────────────────────────────────────────────────────
  // The adopter's own routes first: they see the authenticated caller
  // context (requestContextStorage) like the built-in ones.
  options.routes?.(app);

  // Right-to-erasure (ADR 0020): everything stored for the CALLING scope —
  // facts, sessions (with their subagent rows), ledger turns, spans and
  // payloads — in one operation, with per-store counts. Scoped to the
  // default syndicate's memory namespace; `?all=1` covers every namespace.
  // A caller whose scope owns nested end-user scopes (a caller token, or a
  // BYOK key silo) and sends no X-User-Id erases its scope and every one
  // beneath it. The scope comes from the authenticated context, so a caller
  // can erase only what it could write.
  app.delete('/memory', async (req, res) => {
    if (!erase) {
      res.status(501).json({ error: 'Erasure needs durable storage; this server has none configured.' });
      return;
    }
    const ctx = requestContextStorage.getStore();
    if (!ctx) {
      res.status(401).json({ error: 'No authentication context.' });
      return;
    }
    const all = req.query.all === '1' || req.query.all === 'true';
    try {
      const counts = await erase(ctx.scopeKey, {
        namespace: all ? undefined : memoryAppName(config),
        includeNested: !!ctx.ownsNested,
      });
      log(`Erasure for scope ${ctx.scopeKey}${all ? ' (all namespaces)' : ''}: ${JSON.stringify(counts)}`);
      audit?.({ event: 'memory.erase', outcome: 'ok', caller: ctx.caller, scopeHash: scopeHashOf(ctx.scopeKey), sourceIp: ctx.sourceIp, detail: { allNamespaces: all, deleted: counts } });
      res.json({ deleted: counts });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      warn(`Erasure failed: ${msg}`);
      audit?.({ event: 'memory.erase', outcome: 'failed', caller: ctx.caller, scopeHash: scopeHashOf(ctx.scopeKey), sourceIp: ctx.sourceIp, detail: { allNamespaces: all } });
      res.status(503).json({ error: msg });
    }
  });

  // The default syndicate at the root routes.
  const root = buildHandlers(config, '', 'default');
  app.use(`/${AGENT_CARD_PATH}`, root.card);
  app.use('/a2a/jsonrpc', root.jsonRpc);
  app.use('/a2a/rest', root.rest);

  // Every other syndicate at /:agentId/... — loaded on first request, then
  // cached for the process lifetime (a config change needs a restart).
  // The in-flight load is cached, not just the result, so a burst of first
  // requests builds ONE handler (and one task store) instead of several.
  const handlerCache = new Map<string, Promise<Handlers>>();
  const unknownAgents = new Map<string, number>(); // id → time of the failed load
  const UNKNOWN_TTL_MS = 30_000;

  // ADR 0018: a bare id is a FILE in the deployment's own agents directory.
  // The registry answers only `registry:<id>`, or a bare id the operator
  // listed in `registryAgents` — never as an implicit preference, and with
  // no silent fallback between the two. The shipped examples/ and templates/
  // answer only ids listed in `servedAgents`.
  const registryIds = new Set(options.registryAgents ?? []);
  const served = options.servedAgents ? new Set(options.servedAgents) : undefined;
  class AgentNotFound extends Error {}

  const loadAgentConfig = async (agentId: string): Promise<{ config: SyndicateYamlConfig; source: string }> => {
    const registryId = agentId.startsWith('registry:') ? agentId.slice('registry:'.length) : registryIds.has(agentId) ? agentId : undefined;
    if (registryId) {
      try {
        return { config: await loadSyndicateFromRegistry(registryId, { bindings: bindings() }), source: `registry:${registryId}` };
      } catch (err: unknown) {
        const why = err instanceof Error ? err.message : String(err);
        if (/not found/i.test(why)) throw new AgentNotFound(`registry has no row '${registryId}'`);
        throw err; // validation failure or registry outage: 503, never a file substitute
      }
    }
    const file = agentId.endsWith('.yaml') ? agentId : `${agentId}.yaml`;
    try {
      return {
        config: loadSyndicate(file, { bindings: bindings(), shippedFallback: !!served?.has(agentId) }),
        source: `file:${file}`,
      };
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') throw new AgentNotFound(`no file ${file}`);
      throw err;
    }
  };

  const handlersFor = (agentId: string): Promise<Handlers> => {
    const cached = handlerCache.get(agentId);
    if (cached) return cached;
    const pending = (async () => {
      const { config: cfg, source } = await loadAgentConfig(agentId);
      log(`⚙ Loaded '${agentId}' from ${source}`);
      return buildHandlers(cfg, `/${agentId}`, agentId);
    })();
    handlerCache.set(agentId, pending);
    pending.catch(() => handlerCache.delete(agentId));
    return pending;
  };

  const dynamic = (pick: (h: Handlers) => RequestHandler, label: string) =>
    async (req: Request, res: Response, next: NextFunction) => {
      const agentId = String(req.params.agentId);
      if (req.method !== 'GET') log(`${req.method} /${agentId}/${label}`);
      const failedAt = unknownAgents.get(agentId);
      if (!isValidAgentId(agentId) || (served && !served.has(agentId)) || (failedAt && Date.now() - failedAt < UNKNOWN_TTL_MS)) {
        res.status(404).json({ error: `Unknown agent '${agentId.slice(0, 80)}'.` });
        return;
      }
      try {
        pick(await handlersFor(agentId))(req, res, next);
      } catch (err: unknown) {
        // The detail (which can carry server paths) stays in the log.
        const detail = err instanceof Error ? err.message : String(err);
        if (err instanceof AgentNotFound) {
          warn(`Unknown agent '${agentId}': ${detail}`);
          unknownAgents.set(agentId, Date.now());
          res.status(404).json({ error: `Unknown agent '${agentId.slice(0, 80)}'.` });
        } else {
          // An invalid config or a registry outage: the agent exists but
          // cannot be served right now. Not cached — the next request retries.
          warn(`Agent '${agentId}' could not be loaded: ${detail}`);
          res.setHeader('Retry-After', '30');
          res.status(503).json({ error: `Agent '${agentId.slice(0, 80)}' is unavailable; see the server log.` });
        }
      }
    };

  app.use('/:agentId/.well-known/agent-card.json', dynamic((h) => h.card, 'agent-card'));
  app.use('/:agentId/agent-card.json', dynamic((h) => h.card, 'agent-card'));
  app.use('/:agentId/a2a/jsonrpc', dynamic((h) => h.jsonRpc, 'a2a/jsonrpc'));
  app.use('/:agentId/a2a/rest', dynamic((h) => h.rest, 'a2a/rest'));

  return {
    app,
    config,
    sessionBackend,
    markUnready: () => {
      unready = true;
    },
    shutdown: async (graceMs: number) => {
      const left = await limiter.drain(graceMs);
      for (const t of leaseTimers) clearInterval(t);
      for (const t of retentionTimers.values()) clearInterval(t);
      return left;
    },
  };
}
