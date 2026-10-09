/**
 * lib/tools/credentialUses.ts — every static credential variable a syndicate
 * YAML sends somewhere, and where (ADR 0122).
 *
 * A YAML sends a static credential in three places: an OpenAPI entry's
 * `auth.bearer_env` or `auth.api_key.env` (to the spec's server, or
 * `base_url`), and an `oauth2` block's `client_secret_env` (to its
 * `token_url`; the OpenAPI entry's or the MCP server's `mcp_auth`). The
 * operator's credential host allowlist (lib/tools/credentialHosts.ts) is
 * checked against them when a served syndicate loads
 * (`syndicateCredentialHostProblems`), and the doctor and the server binary
 * name each variable no allowlist binds (`unboundCredentialEnvs`).
 *
 * Names and hosts only: no value is read here.
 */

import { resolve } from 'node:path';

import { credentialHostProblem, credentialHosts } from './credentialHosts.ts';
import type { CredentialHostAllowlist } from './credentialHosts.ts';
import { openApiServers } from './openapiTools.ts';
import type { OpenApiConfig } from './openapiTools.ts';

/** One credential variable a YAML sends, and to what. */
export interface CredentialUse {
  /** The agent that holds the tools ("Parent › Child" inside a nested file). */
  agent: string;
  /** `openapi <spec>` or `mcp <url>`. */
  tools: string;
  /** The variable's name. */
  env: string;
  /** Where the YAML names it. */
  role: 'bearer_env' | 'api_key' | 'client_secret_env';
  /**
   * The URLs its value goes to: the token endpoint for a client secret,
   * `base_url` for an OpenAPI entry that sets one. Absent for an OpenAPI
   * entry whose server is in its spec (read only when checked, by
   * `syndicateCredentialHostProblems`).
   */
  destinations?: string[];
  /** The OpenAPI entry, for its spec's servers. */
  openapi?: OpenApiEntryLike;
}

/** The parts of an `oauth2` block read here. */
interface OAuth2Like {
  token_url?: string;
  client_secret_env?: string;
}
/** The parts of an `openapi:` entry read here. */
interface OpenApiEntryLike {
  spec?: string;
  base_url?: string;
  auth?: { bearer_env?: string; api_key?: { env?: string }; oauth2?: OAuth2Like };
}
interface AgentLike {
  name?: string;
  openapi?: OpenApiEntryLike[];
  mcp_server_url?: string;
  mcp_auth?: { oauth2?: OAuth2Like };
  mcp_servers?: Array<{ url?: string; auth?: { oauth2?: OAuth2Like } }>;
  yaml_reference?: string;
}
/** The parts of a syndicate config read here. */
export interface SyndicateLike {
  orchestrator?: AgentLike;
  subagents?: AgentLike[];
}

/** The token endpoint a client secret goes to; none named yet for a grant whose endpoints are discovered (ADR 0124). */
const tokenUrlOf = (o: OAuth2Like): string[] => (o.token_url ? [o.token_url] : []);

/** The credential variables one agent's tools send. */
export function agentCredentialUses(agent: AgentLike, prefix = ''): CredentialUse[] {
  const name = `${prefix}${agent.name ?? ''}`;
  const out: CredentialUse[] = [];
  for (const entry of agent.openapi ?? []) {
    const tools = `openapi ${entry?.spec ?? ''}`;
    const auth = entry?.auth;
    if (!auth) continue;
    const servers = entry.base_url ? { destinations: [entry.base_url] } : {};
    if (auth.bearer_env) out.push({ agent: name, tools, env: auth.bearer_env, role: 'bearer_env', ...servers, openapi: entry });
    if (auth.api_key?.env) out.push({ agent: name, tools, env: auth.api_key.env, role: 'api_key', ...servers, openapi: entry });
    if (auth.oauth2?.client_secret_env) out.push({ agent: name, tools, env: auth.oauth2.client_secret_env, role: 'client_secret_env', destinations: tokenUrlOf(auth.oauth2) });
  }
  const mcp = agent.mcp_auth?.oauth2;
  if (mcp?.client_secret_env) out.push({ agent: name, tools: `mcp ${agent.mcp_server_url ?? ''}`, env: mcp.client_secret_env, role: 'client_secret_env', destinations: tokenUrlOf(mcp) });
  // Each mcp_servers entry's grant (ADR 0124), as the single server's.
  for (const server of agent.mcp_servers ?? []) {
    const o = server?.auth?.oauth2;
    if (o?.client_secret_env) out.push({ agent: name, tools: `mcp ${server.url ?? ''}`, env: o.client_secret_env, role: 'client_secret_env', destinations: tokenUrlOf(o) });
  }
  return out;
}

/**
 * Every credential variable these syndicates send, orchestrators and
 * subagents, following a nested `yaml_reference:` through `load` when given
 * (once per file; agent names then read "Parent › Child").
 */
export function syndicateCredentialUses(configs: readonly SyndicateLike[], load?: (ref: string) => SyndicateLike): CredentialUse[] {
  const out: CredentialUse[] = [];
  const seen = new Set<string>();
  const visit = (config: SyndicateLike, prefix: string) => {
    const agents = [config.orchestrator, ...(config.subagents ?? [])].filter((a): a is AgentLike => !!a);
    for (const agent of agents) {
      if (agent.yaml_reference) {
        if (!load || seen.has(agent.yaml_reference)) continue;
        seen.add(agent.yaml_reference);
        visit(load(agent.yaml_reference), `${prefix}${agent.name ?? agent.yaml_reference} › `);
        continue;
      }
      out.push(...agentCredentialUses(agent, prefix));
    }
  };
  for (const config of configs) visit(config, '');
  return out;
}

/** The URLs a use's value goes to; an OpenAPI spec that cannot be read gives none (its compile fails on its own). */
function destinationsOf(use: CredentialUse): string[] {
  if (use.destinations) return use.destinations;
  if (!use.openapi?.spec) return [];
  try {
    return openApiServers(use.openapi as OpenApiConfig, resolve(process.cwd()));
  } catch {
    return [];
  }
}

/**
 * Why these syndicates may not be served here, one line per refusal
 * (ADR 0122): each credential variable they send, against the operator's
 * credential host allowlist. With none configured, nothing is refused. The
 * A2A server checks every syndicate it loads to serve; the compile checks
 * again, and each call once more.
 */
export function syndicateCredentialHostProblems(
  configs: readonly SyndicateLike[],
  options: { load?: (ref: string) => SyndicateLike; allowlist?: CredentialHostAllowlist | null } = {},
): string[] {
  const allowlist = options.allowlist === undefined ? credentialHosts() ?? null : options.allowlist;
  if (!allowlist) return [];
  const out = new Set<string>();
  for (const use of syndicateCredentialUses(configs, options.load)) {
    const role = use.role === 'client_secret_env' ? 'token_url' : 'server';
    const where = `${use.agent} · ${use.tools} · ${use.role}`;
    if (!Object.hasOwn(allowlist, use.env)) {
      out.add(`${where}: ${credentialHostProblem(use.env, '', role, allowlist)}`);
      continue;
    }
    for (const url of destinationsOf(use)) {
      const problem = credentialHostProblem(use.env, url, role, allowlist);
      if (problem) out.add(`${where}: ${problem}`);
    }
  }
  return [...out];
}

/**
 * The credential variables these uses send that no allowlist binds, sorted
 * and once each: every one of them when none is configured. Names only.
 */
export function unboundCredentialEnvs(uses: readonly CredentialUse[], allowlist: CredentialHostAllowlist | null | undefined): string[] {
  return [...new Set(uses.map((u) => u.env))].filter((name) => !allowlist || !Object.hasOwn(allowlist, name)).sort();
}
