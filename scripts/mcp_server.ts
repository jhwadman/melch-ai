#!/usr/bin/env node
/**
 * scripts/mcp_server.ts — the `melchizedek-mcp` bin: syndicates as MCP tools
 * (ADR 0125). Thin: it reads flags and the environment, loads the syndicates,
 * refuses unsafe binds, and hands everything to lib/mcp/server.ts.
 *
 *   claude mcp add melch -- npx melchizedek-mcp
 *   melchizedek-mcp --syndicate research_desk --syndicate tutor
 *   melchizedek-mcp --http --port 4100
 *
 * Every console line goes to stderr: on stdio, stdout is the protocol.
 *
 * Flags:
 *   --syndicate <id>      serve this syndicate (repeatable; a bare id may also
 *                         resolve to the shipped examples/ and templates/).
 *                         Positional ids work too. None: every YAML at the
 *                         agents directory's root.
 *   --agents-dir <dir>    the agents directory (MELCHIZEDEK_AGENTS_DIR, else
 *                         <cwd>/config/agents)
 *   --http                Streamable HTTP at /mcp instead of stdio
 *   --host <addr>         HTTP bind (MCP_HOST, default 127.0.0.1)
 *   --port <n>            HTTP port (MCP_PORT, default 4100)
 *
 * Environment (all optional):
 *   MCP_SERVER_SECRET     bearer every HTTP request presents; required, 32+
 *                         characters, on a bind beyond loopback
 *   MCP_ALLOWED_HOSTS     comma list: Host names a non-loopback bind answers to
 *   MCP_TRUST_PROXY       Express trust proxy (hop count, true/false, subnets)
 *   MCP_RATE_LIMIT_PER_MINUTE   HTTP requests per minute per IP (240)
 *   MCP_USER_ID           the scope a stdio client's sessions are stored under (default)
 *   DATABASE_URL          Postgres for sessions, memory, turn locks, audit, credentials
 *   A2A_TASK_TIMEOUT_MS, A2A_MAX_CONCURRENT_TASKS, A2A_MAX_CONCURRENT_PER_SCOPE,
 *   A2A_MAX_CONCURRENT_PER_CALLER, A2A_TURN_LOCK_WAIT_MS, A2A_BUDGETS,
 *   A2A_SHUTDOWN_GRACE_MS, MELCHIZEDEK_CREDENTIAL_KEY, OAUTH_REDIRECT_URI,
 *   OAUTH_CALLBACK_IDENTITY, MELCHIZEDEK_OAUTH_HOSTS, MELCHIZEDEK_CREDENTIAL_HOSTS
 *                         as melchizedek-serve reads them (scripts/a2a_server.ts)
 */
import { readdirSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export interface McpCliArgs {
  syndicates: string[];
  agentsDir?: string;
  http: boolean;
  host?: string;
  port?: number;
  help: boolean;
}

/** The bin's flags. Throws, naming the flag, on one it does not know. */
export function parseMcpArgs(argv: string[]): McpCliArgs {
  const out: McpCliArgs = { syndicates: [], http: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const value = () => {
      const v = argv[++i];
      if (v === undefined || v.startsWith('--')) throw new Error(`${a} needs a value`);
      return v;
    };
    if (a === '--help' || a === '-h') out.help = true;
    else if (a === '--http') out.http = true;
    else if (a === '--stdio') out.http = false;
    else if (a === '--syndicate') out.syndicates.push(value());
    else if (a === '--agents-dir') out.agentsDir = value();
    else if (a === '--host') out.host = value();
    else if (a === '--port') {
      const n = Number(value());
      if (!Number.isInteger(n) || n < 0 || n > 65535) throw new Error('--port must be a port number');
      out.port = n;
    } else if (a.startsWith('-')) throw new Error(`Unknown flag ${a} (see --help)`);
    else out.syndicates.push(a);
  }
  return out;
}

const HELP = [
  'Usage: melchizedek-mcp [--syndicate <id>]... [--agents-dir <dir>] [--http [--host <addr>] [--port <n>]]',
  '',
  'Serves syndicates as MCP tools: one tool per syndicate ({ message, session_id? }),',
  'plus melch_resume for a turn that paused (an approval, a question, an authorization).',
  'stdio by default (Claude Code: claude mcp add melch -- npx melchizedek-mcp);',
  '--http serves Streamable HTTP at /mcp on 127.0.0.1; a wider --host needs MCP_SERVER_SECRET.',
  'Environment variables are listed at the top of scripts/mcp_server.ts.',
].join('\n');

function envInt(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) throw new Error(`${name} must be a non-negative number`);
  return Math.floor(n);
}

function trustProxy(): number | boolean | string {
  const raw = process.env.MCP_TRUST_PROXY?.trim();
  if (!raw) return false;
  if (/^\d+$/.test(raw)) return Number(raw);
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  return raw;
}

function fatal(message: string): never {
  console.error(`[MCP] ✗ FATAL: ${message}`);
  process.exit(1);
}

export async function startMcpServer(argv: string[] = process.argv.slice(2)): Promise<void> {
  let args: McpCliArgs;
  try {
    args = parseMcpArgs(argv);
  } catch (err: unknown) {
    fatal(err instanceof Error ? err.message : String(err));
  }
  if (args.help) {
    console.error(HELP);
    process.exit(0);
  }
  if (args.agentsDir) process.env.MELCHIZEDEK_AGENTS_DIR = path.resolve(args.agentsDir);

  const { loadEnv, isPlaceholderValue } = await import('../lib/loadEnv.ts');
  loadEnv(import.meta.url);
  // Sign in with ChatGPT is local only (ADR 0126). Over stdio this bin is one person's process, spawned by
  // their own MCP client; --http can be reached by others, so it refuses like melchizedek-serve.
  if (args.http) {
    const { refuseChatGptSignInOnServedSurface } = await import('../lib/chatgpt/state.ts');
    try {
      refuseChatGptSignInOnServedSurface('melchizedek-mcp --http');
    } catch (err: unknown) {
      fatal(err instanceof Error ? err.message : String(err));
    }
  }
  if (process.env.OTEL_CONSOLE_SPANS === undefined) process.env.OTEL_CONSOLE_SPANS = 'false';
  const { setLogLevel } = await import('../lib/runtime/logging.ts');
  setLogLevel('warn');
  const log = (m: string) => console.error(`[MCP] ${m}`);
  const warn = (m: string) => console.error(`[MCP] ⚠ ${m}`);

  const { createMcpServer, mcpBindProblem, mcpHttpApp, serveMcpStdio, toolNameFor } = await import('../lib/mcp/server.ts');
  const { loadSyndicate, nestedLoader } = await import('../lib/loadSyndicate.ts');
  const { syndicateOAuthHostProblems } = await import('../lib/tools/oauthTools.ts');
  const { syndicateCredentialHostProblems } = await import('../lib/tools/credentialUses.ts');

  // ── Transport posture first: a refused bind loads nothing ────────────────
  const host = args.host ?? (process.env.MCP_HOST?.trim() || '127.0.0.1');
  const port = args.port ?? envInt('MCP_PORT', 4100);
  let secret = process.env.MCP_SERVER_SECRET?.trim() || undefined;
  if (secret && isPlaceholderValue(secret)) fatal('MCP_SERVER_SECRET is still a placeholder. Generate one: openssl rand -hex 32');
  if (args.http) {
    const problem = mcpBindProblem({ host, ...(secret ? { secret } : {}) });
    if (problem) fatal(problem);
  }

  // ── The syndicates: the exposure ──────────────────────────────────────────
  const bindings = () => ({
    current_date: new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' }),
  });
  const agentsDir = path.resolve(process.env.MELCHIZEDEK_AGENTS_DIR ?? path.join(process.cwd(), 'config', 'agents'));
  let files = args.syndicates.map((id) => (id.endsWith('.yaml') || id.endsWith('.yml') ? id : `${id}.yaml`));
  const named = files.length > 0;
  if (!named) {
    try {
      files = readdirSync(agentsDir)
        .filter((f) => (f.endsWith('.yaml') || f.endsWith('.yml')) && f !== 'syndicateSchema.yaml')
        .sort();
    } catch {
      files = [];
    }
    if (!files.length) fatal(`No syndicates at the root of ${agentsDir}. Name one: melchizedek-mcp --syndicate <id> (a shipped example works: --syndicate tutor).`);
  }
  const syndicates: Array<{ id: string; config: import('../lib/loadSyndicate.ts').SyndicateYamlConfig }> = [];
  for (const file of files) {
    try {
      const config = loadSyndicate(file, { bindings: bindings(), shippedFallback: named });
      // The operator's host allowlists hold here as on the A2A server (ADR 0114, ADR 0122).
      const nested = nestedLoader(config, (ref) => loadSyndicate(ref, { bindings: bindings() }));
      const load = (ref: string) => {
        try {
          return nested(ref);
        } catch {
          return {};
        }
      };
      const problems = [...syndicateOAuthHostProblems([config], { load }), ...syndicateCredentialHostProblems([config], { load })];
      if (problems.length) throw new Error(`refused by the operator's host allowlists:\n  - ${problems.join('\n  - ')}`);
      syndicates.push({ id: toolNameFor(path.basename(file)), config });
    } catch (err: unknown) {
      const why = (err as NodeJS.ErrnoException)?.code === 'ENOENT' ? 'not found' : err instanceof Error ? err.message : String(err);
      if (named) fatal(`${file}: ${why}`);
      warn(`Skipped ${file}: ${why.split('\n')[0]}`);
    }
  }
  if (!syndicates.length) fatal('No syndicate loaded.');

  // ── Storage, budgets, tool credentials: as melchizedek-serve ─────────────
  const databaseUrl = process.env.DATABASE_URL?.trim() || undefined;
  let pg: Awaited<ReturnType<typeof import('../lib/storage/postgres/index.ts').postgresStorage>> | undefined;
  if (databaseUrl) {
    const { postgresStorage } = await import('../lib/storage/postgres/index.ts');
    const { dbSchema } = await import('../lib/storage/schema.ts');
    pg = postgresStorage({
      connectionString: databaseUrl,
      schema: dbSchema(),
      memory: { apiKey: process.env.GOOGLE_GENAI_API_KEY || process.env.GEMINI_API_KEY || '' },
    });
    const { compareSchema, schemaBehindMessage, shippedSchemaVersion } = await import('../lib/storage/schemaVersion.ts');
    const check = compareSchema(await pg.schemaVersion(), shippedSchemaVersion());
    if (check.state === 'behind' && process.env.ALLOW_SCHEMA_MISMATCH?.trim().toLowerCase() !== 'true') fatal(schemaBehindMessage(check));
  }
  let policy: import('../lib/a2a/policy.ts').Policy | undefined;
  const budgetsJson = process.env.A2A_BUDGETS?.trim();
  if (budgetsJson) {
    const { budgets, memoryUsageStore, parseBudgets, postgresUsageStore } = await import('../lib/a2a/policy.ts');
    try {
      policy = budgets(parseBudgets(budgetsJson), { store: pg ? postgresUsageStore(pg.pool) : memoryUsageStore() });
    } catch (err: unknown) {
      fatal(err instanceof Error ? err.message : String(err));
    }
  }
  const { oauthServerSetup, callbackIdentity } = await import('../lib/a2a/oauthSetup.ts');
  const { postgresCredentialRows } = await import('../lib/storage/postgres/credentialStore.ts');
  let oauth;
  try {
    oauth = oauthServerSetup({
      configs: syndicates.map((s) => s.config),
      load: (ref) => loadSyndicate(ref),
      env: process.env,
      ...(pg ? { rows: postgresCredentialRows(pg.pool), audit: pg.audit } : {}),
      allowPrivate: process.env.ALLOW_PRIVATE_OPENAPI === 'true' || process.env.ALLOW_PRIVATE_MCP === 'true',
    });
  } catch (err: unknown) {
    fatal(err instanceof Error ? err.message : String(err));
  }
  for (const w of oauth.warnings) warn(w);
  const consent = oauth.toolCredentials?.consent;
  if (consent && !args.http) {
    warn('stdio serves no OAuth consent callback: a consent pause completes only where OAUTH_REDIRECT_URI is served by a server sharing this credential store.');
  }

  const mcp = createMcpServer({
    syndicates,
    ...(pg ? { sessionService: pg.sessionService, turnLock: pg.turnLock, audit: pg.audit } : {}),
    ...(pg?.memoryService ? { memoryService: pg.memoryService } : {}),
    taskTimeoutMs: envInt('A2A_TASK_TIMEOUT_MS', 15 * 60 * 1000),
    maxConcurrentTasks: envInt('A2A_MAX_CONCURRENT_TASKS', 0),
    maxConcurrentPerScope: envInt('A2A_MAX_CONCURRENT_PER_SCOPE', 4),
    maxConcurrentPerCaller: envInt('A2A_MAX_CONCURRENT_PER_CALLER', 0),
    turnLockWaitMs: envInt('A2A_TURN_LOCK_WAIT_MS', 30_000),
    ...(policy ? { policy } : {}),
    ...(oauth.toolCredentials ? { toolCredentials: oauth.toolCredentials } : {}),
    log,
    warn,
  });
  const toolList = syndicates.map((s) => s.id).join(', ');

  const graceMs = envInt('A2A_SHUTDOWN_GRACE_MS', 25_000);
  let stopping = false;
  let closeHttp: (() => Promise<void>) | undefined;
  const stop = async (why: string) => {
    if (stopping) return;
    stopping = true;
    log(`${why}: waiting up to ${graceMs} ms for running turns.`);
    const canceled = await mcp.shutdown(graceMs);
    if (canceled > 0) warn(`${canceled} turn(s) did not finish in time and were canceled.`);
    await closeHttp?.().catch(() => {});
    const { flushTracing } = await import('../lib/observability/tracer.ts');
    await flushTracing().catch(() => {});
    await pg?.close().catch(() => {});
    process.exit(0);
  };
  process.on('SIGTERM', () => void stop('SIGTERM'));
  process.on('SIGINT', () => void stop('SIGINT'));

  if (!args.http) {
    const scope = process.env.MCP_USER_ID?.trim() || 'default';
    const { HEADER_VALUE_PATTERN } = await import('../lib/a2a/identity.ts');
    if (!HEADER_VALUE_PATTERN.test(scope)) fatal('MCP_USER_ID must match [A-Za-z0-9._-]{1,64}');
    await serveMcpStdio(mcp, { caller: { scopeKey: scope, caller: 'local' } });
    log(`✓ Serving ${syndicates.length} syndicate tool(s) over stdio: ${toolList}`);
    process.stdin.on('end', () => void stop('stdin closed'));
    return;
  }

  const allowedHosts = process.env.MCP_ALLOWED_HOSTS?.split(',').map((s) => s.trim()).filter(Boolean);
  const { consentCallback } = await import('../lib/a2a/app.ts');
  const app = mcpHttpApp(mcp, {
    host,
    port,
    ...(secret ? { secret } : {}),
    ...(allowedHosts?.length ? { allowedHosts } : {}),
    trustProxy: trustProxy(),
    rateLimitPerMinute: envInt('MCP_RATE_LIMIT_PER_MINUTE', 240),
    ...(consent
      ? {
          beforeAuth: (a: import('express').Express) =>
            a.get(
              new URL(consent.redirectUri).pathname,
              consentCallback(consent, { requireCallerIdentity: callbackIdentity(process.env) === 'required', log, warn }),
            ),
        }
      : {}),
    warn,
  });
  closeHttp = app.closeSessions;
  // The secret is not needed past this point.
  secret = undefined;
  await new Promise<void>((resolve) => {
    app.listen(port, host, () => resolve());
  });
  log(`✓ Serving ${syndicates.length} syndicate tool(s) at http://${host.includes(':') ? `[${host}]` : host}:${port}/mcp: ${toolList}`);
  log(`  auth     ${process.env.MCP_SERVER_SECRET?.trim() ? 'bearer MCP_SERVER_SECRET' : 'none (loopback only)'}`);
  log(`  storage  ${pg ? 'postgres' : 'in-memory (lost on restart)'}`);
  log(`  oauth    ${oauth.summary}`);
}

// Run-as-main guard on the realpath of argv[1] (the bin is a symlink; see a2a_server.ts).
const invokedAsMain = (() => {
  if (!process.argv[1]) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
  } catch {
    return import.meta.url === `file://${process.argv[1]}`;
  }
})();

if (invokedAsMain) {
  // Before anything else loads: stdout is the stdio protocol channel.
  console.log = console.error;
  console.info = console.error;
  console.debug = console.error;
  startMcpServer().catch((error: unknown) => {
    console.error(`[MCP] ✗ ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
