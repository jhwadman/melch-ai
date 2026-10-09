/**
 * lib/syndicateSchema.ts — the syndicate YAML contract, as a validator.
 *
 * WHY this file exists:
 *   A syndicate YAML is the framework's primary authoring surface, and the
 *   loader used to type-cast it (`parse(...) as SyndicateYamlConfig`). A typo
 *   either crashed deep inside the compiler (`orchestator:` → "cannot read
 *   'model' of undefined") or, worse, was accepted and silently changed
 *   behaviour (`memory_system: internl-only` disabled memory in the A2A
 *   server). Here the shape the interfaces in lib/loadSyndicate.ts declare is
 *   written once as a zod schema, checked at load, and every problem is
 *   reported with its key path and, for a misspelt key, the key it was meant
 *   to be.
 *
 *   The same schema emits config/agents/syndicate.schema.json (npm run
 *   schema:gen) so an editor can flag the typo before a run does; a test
 *   keeps the committed file equal to the generated one.
 *
 * Strictness is deliberate at the syndicate, agent and dispatch levels — the
 * places a misspelt key silently does nothing — and deliberately ABSENT inside
 * `generateContentConfig` and `outputSchema`, which pass through to provider
 * SDKs whose fields this repo does not own.
 */

import { z } from 'zod';

import type { SyndicateYamlConfig } from './loadSyndicate.ts';
import { DEFAULT_ROUTE_KEY, NODE_KINDS, ROUTE_STEP_SUFFIX, START_NAME, elementNames, nodeKind } from './workflowConfig.ts';
import { isSecretShapedEnvName } from './tools/skills/env.ts';
import { OAUTH_SCOPE, PROVIDER_NAME } from './tools/auth.ts';
import type { EdgeElement, WorkflowNodeYaml } from './workflowConfig.ts';

// ── Leaf rules ───────────────────────────────────────────────────────────────

/**
 * ADK's agent-name rule (validateAgentName in ADK's base_agent), kept: checked here
 * so the error names the YAML key instead of surfacing from a constructor
 * mid-compile.
 */
const AGENT_NAME_RE = /^[\p{ID_Start}$_][\p{ID_Continue}$_-]*$/u;

const agentName = z
  .string()
  .regex(AGENT_NAME_RE, 'must be a valid identifier (letters, digits, _ and -; not starting with a digit)')
  .refine((n) => n !== 'user', "'user' is reserved for the end user's input")
  .describe('Unique agent name within the tree. A valid identifier; cannot be "user".');

export const MEMORY_SYSTEMS = ['internal-only', 'session-only', 'long-term'] as const;

const thinkingConfig = z
  .looseObject({
    thinkingBudget: z.number().int().optional().describe('Reasoning token budget. 0 = off, -1 = dynamic.'),
    includeThoughts: z.boolean().optional().describe('Stream the thinking trace in the response.'),
  })
  .describe('Older spelling of `reasoning` for Gemini and Claude (thinkingLevel or thinkingBudget). Cannot be combined with `reasoning`.');

export const REASONING_LEVELS = ['none', 'low', 'medium', 'high'] as const;

/**
 * The provider-neutral reasoning key (ADR 0047): a level, or a token budget.
 * The compiler maps it per provider (lib/compile.ts reasoningConfig).
 */
const reasoningSchema = z
  .union(
    [
      z.enum(REASONING_LEVELS),
      z.strictObject({
        budget_tokens: z.number().int().min(0).describe('Thinking tokens; 0 = none. Effort-only providers take the nearest level at or above it.'),
      }),
    ],
    {
      error: (iss) => {
        const hint = typeof iss.input === 'string' ? suggest(iss.input, REASONING_LEVELS) : undefined;
        return `must be one of ${REASONING_LEVELS.join(' | ')}, or { budget_tokens: <integer ≥ 0> } (got ${describeValue(iss.input)}${hint ? ` — did you mean "${hint}"?` : ''})`;
      },
    },
  )
  .describe('How hard this agent reasons, on any provider: none | low | medium | high, or { budget_tokens: <int> }. Replaces generateContentConfig.thinkingConfig and reasoningEffort (ADR 0047).');

/**
 * Loose on purpose: provider-specific fields (e.g. `toolConfig`) pass through
 * to the SDK. Only the documented fields are typed, so `temperature: hot`
 * still fails while an unlisted knob does not.
 */
const generateContentConfig = z
  .looseObject({
    temperature: z.number().optional(),
    topP: z.number().optional(),
    topK: z.number().optional(),
    maxOutputTokens: z.number().int().positive().optional(),
    stopSequences: z.array(z.string()).optional(),
    candidateCount: z.number().int().positive().optional(),
    presencePenalty: z.number().optional(),
    frequencyPenalty: z.number().optional(),
    seed: z.number().int().optional(),
    responseMimeType: z.string().optional(),
    safetySettings: z
      .array(z.looseObject({ category: z.string(), threshold: z.string() }))
      .optional(),
    thinkingConfig: thinkingConfig.optional(),
    reasoningEffort: z
      .string()
      .optional()
      .describe('Older spelling of `reasoning` for the chat-completions and Responses providers. Cannot be combined with `reasoning`.'),
  })
  .describe('Model generation config (@google/genai GenerateContentConfig). Do not set tools here.');

// ── Skills ───────────────────────────────────────────────────────────────────

/** The most delegated calls one step may run at once (`max_concurrency`, ADR 0116): each is a model run that costs money. */
const MAX_DELEGATION_CONCURRENCY = 32;

export const SKILL_SCRIPT_MODES = ['none', 'local'] as const;

const envName = z.string().regex(/^[A-Z_][A-Z0-9_]*$/, 'an environment variable name (A–Z, 0–9, _)');

/**
 * Agent Skills for one agent (lib/tools/skillToolset.ts): the frontmatter
 * index is injected into the instruction at compile time, a skill is read in
 * full on demand, and its scripts run only when `scripts` allows and a person
 * approves each run.
 */
const skillsSchema = z
  .strictObject({
    dir: z
      .string()
      .min(1)
      .describe('A directory of skills: one subdirectory per skill, named as its SKILL.md frontmatter names it. Relative to the working directory.'),
    scripts: z
      .enum(SKILL_SCRIPT_MODES)
      .optional()
      .describe('Whether a skill\'s scripts/ may run. "local" runs them on this machine, each after a person approves (ADR 0028); default "none".'),
    tools: z
      .array(z.string().min(1))
      .optional()
      .describe('Registry tool names a skill may unlock through its `allowed-tools` frontmatter once it is loaded. Omitted, no skill unlocks anything.'),
    env: z
      .array(envName)
      .optional()
      .describe(
        'Environment variable NAMES (never values) a skill script gets, beyond PATH, HOME, the temp directory, the locale and the OS essentials (ADR 0086). A name that looks like a secret (KEY, TOKEN, SECRET, PASSWORD, AUTH, DATABASE, …) belongs under secret_env.',
      ),
    secret_env: z
      .array(envName)
      .optional()
      .describe('Secret-shaped environment variable names a skill script gets, listed here so passing a credential to a script is a deliberate, reviewable act (ADR 0086).'),
  })
  .superRefine((skills, ctx) => {
    (skills.env ?? []).forEach((name, j) => {
      if (isSecretShapedEnvName(name)) {
        ctx.addIssue({ code: 'custom', path: ['env', j], message: `'${name}' looks like it holds a secret; a script gets it only if you list it under skills.secret_env (ADR 0086)` });
      }
    });
    if ((skills.env?.length || skills.secret_env?.length) && skills.scripts !== 'local') {
      ctx.addIssue({ code: 'custom', path: [skills.env?.length ? 'env' : 'secret_env'], message: 'variables reach skill scripts only, which run only with scripts: "local"' });
    }
  })
  .describe('Agent Skills (SKILL.md directories) this agent reads the way a coding harness does.');

// ── OAuth (ADR 0112) ─────────────────────────────────────────────────────────

const oauth2Auth = z
  .strictObject({
    provider: z
      .string()
      .regex(PROVIDER_NAME, 'a provider name: lowercase letters, digits, and . _ - inside, at most 64 characters')
      .describe('The credential store\'s name for the provider (e.g. github). Every tool naming it shares one grant.'),
    grant: z
      .enum(['authorization_code', 'client_credentials'])
      .describe('authorization_code: each user\'s own token, granted through the consent pause (ADR 0085). client_credentials: the server\'s own token, from the token endpoint.'),
    authorization_url: z.string().url().optional().describe('The provider\'s authorization endpoint (https). authorization_code only.'),
    token_url: z.string().url().describe('The provider\'s token endpoint (https).'),
    client_id: z.string().min(1).max(512).optional().describe('The OAuth client id, written out (it is not a secret). Or client_id_env.'),
    client_id_env: envName.optional().describe('Environment variable holding the client id. Or client_id.'),
    client_secret_env: envName
      .optional()
      .describe('Environment variable NAME holding the client secret, never the value. Required for client_credentials; omit for a public client (PKCE alone).'),
    scopes: z.array(z.string().regex(OAUTH_SCOPE, 'an OAuth scope: visible ASCII, no space, quote or backslash')).max(64).optional().describe('The scopes the grant asks for.'),
    authorization_params: z
      .record(z.string().regex(/^[A-Za-z0-9_.-]{1,64}$/), z.string().max(512))
      .optional()
      .describe('Extra authorization parameters (e.g. access_type: offline). authorization_code only; never state, redirect_uri, scope, client_id or the PKCE pair.'),
  })
  .superRefine((o, ctx) => {
    if (!!o.client_id === !!o.client_id_env) ctx.addIssue({ code: 'custom', path: ['client_id'], message: 'exactly one of client_id or client_id_env' });
    if (o.grant === 'authorization_code' && !o.authorization_url) {
      ctx.addIssue({ code: 'custom', path: ['authorization_url'], message: 'an authorization_code grant needs authorization_url' });
    }
    if (o.grant === 'client_credentials') {
      if (!o.client_secret_env) ctx.addIssue({ code: 'custom', path: ['client_secret_env'], message: 'a client_credentials grant needs client_secret_env' });
      for (const key of ['authorization_url', 'authorization_params'] as const) {
        if (o[key] !== undefined) ctx.addIssue({ code: 'custom', path: [key], message: `${key} is for authorization_code only` });
      }
    }
    const reserved = ['state', 'redirect_uri', 'code_challenge', 'code_challenge_method', 'client_id', 'response_type', 'scope'];
    for (const key of Object.keys(o.authorization_params ?? {})) {
      if (reserved.includes(key)) ctx.addIssue({ code: 'custom', path: ['authorization_params', key], message: `authorization_params may not set "${key}"` });
    }
  })
  .describe('An OAuth 2 access token sent as a bearer token on every call (lib/tools/oauthTools.ts). Secrets come from environment variable names, never values.');

// ── OpenAPI ──────────────────────────────────────────────────────────────────

const openapiEntry = z
  .strictObject({
    spec: z.string().min(1).describe('An OpenAPI 3 spec file (.yaml, .yml, .json), relative to this syndicate file. Files only, never URLs.'),
    operations: z
      .array(z.string().min(1))
      .min(1)
      .optional()
      .describe('Operations to expose, by operationId or tool name. Omitted: every GET operation, and nothing that writes.'),
    base_url: z.string().url().optional().describe('Overrides the spec\'s servers[0].url. Checked by the SSRF guard.'),
    prefix: z.string().regex(/^[a-z][a-z0-9_]*$/).optional().describe('Prepended to each tool name, to keep two APIs apart.'),
    auth: z
      .strictObject({
        bearer_env: envName.optional().describe('Environment variable holding a bearer token.'),
        api_key: z
          .strictObject({ env: envName, in: z.enum(['header', 'query']), name: z.string().min(1) })
          .optional()
          .describe('An API key read from `env`, sent in a header or the query under `name`.'),
        oauth2: oauth2Auth.optional(),
      })
      .refine((a) => [a.bearer_env, a.api_key, a.oauth2].filter((x) => x !== undefined).length === 1, 'exactly one of bearer_env, api_key or oauth2')
      .optional()
      .describe('Credentials, always from the environment, never written in YAML.'),
  })
  .describe('An HTTP API as tools, from its OpenAPI spec (lib/tools/openapiTools.ts).');

// ── Agents ───────────────────────────────────────────────────────────────────

const agentFields = {
  name: agentName,
  description: z
    .string()
    .optional()
    .describe('One line other agents read to decide when to delegate here.'),
  model: z
    .string()
    .min(1)
    .describe('Model id; its prefix picks the provider (gemini-*, claude-*, gpt-*/o*, grok-*, ollama/*).'),
  fallback_model: z
    .string()
    .min(1)
    .optional()
    .describe('A model on another provider that answers when this agent\'s model fails provider-side (5xx, 429, network) before producing anything, or while that provider\'s circuit is open (ADR 0044).'),
  instruction: z.string().min(1).describe('System prompt / persona.'),
  globalInstruction: z
    .string()
    .optional()
    .describe('Instruction applied to every agent in the tree; only the root agent\'s value takes effect.'),
  tools: z
    .array(z.string().min(1))
    .optional()
    .describe('Named tools from lib/toolRegistry.ts (e.g. web_search, web_extract, wiki_search).'),
  require_approval: z
    .array(z.string().min(1))
    .optional()
    .describe(
      'Tools from this agent\'s `tools` that run only after a person approves the exact call (ADR 0028): the A2A task ends input-required until the caller answers approve or reject. Allowed on any agent but one a workflow map node runs; inside a delegated subagent the pause reaches the caller through its open call (ADR 0110).',
    ),
  includeContents: z
    .enum(['default', 'none'])
    .optional()
    .describe('"default" = include conversation history, "none" = stateless.'),
  disallowTransferToParent: z.boolean().optional(),
  disallowTransferToPeers: z.boolean().optional(),
  outputKey: z.string().optional().describe('Session-state key the final reply is saved under.'),
  generateContentConfig: generateContentConfig.optional(),
  reasoning: reasoningSchema.optional(),
  outputSchema: z
    .record(z.string(), z.unknown())
    .optional()
    .describe('JSON Schema for structured output: the agent answers with one JSON object matching it. An agent that also calls tools or delegates to subagents does that first, then ends its turn on that JSON: the schema travels beside the tools where the model takes both in one request, as a set_model_response tool elsewhere (the capability matrix\'s structured_output_with_tools, ADR 0109).'),
  mcp_server_url: z
    .string()
    .optional()
    .describe('MCP server (SSE) whose tools are discovered at runtime and merged with `tools`.'),
  mcp_tools: z
    .array(z.string().min(1))
    .min(1)
    .optional()
    .describe('The MCP server\'s tools this agent may use, by name; any other tool the server lists is not exposed. Without it, every listed tool is. require_approval may name these. Needs mcp_server_url.'),
  mcp_auth: z
    .strictObject({ oauth2: oauth2Auth })
    .optional()
    .describe('The OAuth grant the MCP server takes (ADR 0112). With authorization_code, each user\'s own token on their own connection, and mcp_tools is required. Needs mcp_server_url; replaces MCP_BEARER_TOKENS for this server.'),
  skills: skillsSchema.optional(),
  openapi: z.array(openapiEntry).min(1).optional(),
  code_execution: z
    .literal('gemini')
    .optional()
    .describe('"gemini": the model writes and runs Python in Gemini\'s server-side sandbox; nothing runs on this host. Gemini models only.'),
  context: z
    .strictObject({
      compact_after_tokens: z.number().int().min(1000).describe('Compact when the last request\'s prompt passed this many tokens.'),
      keep_recent_events: z.number().int().min(1).max(100).optional().describe('Events kept verbatim after the summary. Default 6.'),
      summary_model: z.string().min(1).optional().describe('The model that writes the summary. Default: the agent\'s own.'),
    })
    .optional()
    .describe('Summarize a long conversation instead of overflowing the window. The orchestrator of a delegate syndicate only.'),
  examples: z
    .array(z.strictObject({ input: z.string().min(1), output: z.string().min(1) }))
    .min(1)
    .max(20)
    .optional()
    .describe('Few-shot exchanges (input, output) added to every request\'s instruction.'),
  mode: z
    .literal('task')
    .optional()
    .describe('"task": the agent works until it calls finish_task; its arguments (matching outputSchema) are the node\'s output. Workflow nodes only.'),
  orchestration: z
    .strictObject({
      role: z.enum(['primary', 'sub-agent']).optional(),
      delegates: z.array(z.string()).optional(),
    })
    .optional(),
};

export const agentSchema = z
  .strictObject(agentFields)
  .describe('The root agent, which the engine\'s agent loop runs (keys spelled after ADK\'s LlmAgentConfig).');

/**
 * Model and instruction are optional at the type level because a nested
 * (`yaml_reference`) or remote (`a2a_agent_url`) subagent brings its own; the
 * "an ordinary subagent needs an instruction" rule is checked in
 * crossFieldProblems so it can name the alternative keys in its message.
 */
export const subagentSchema = z
  .strictObject({
    ...agentFields,
    description: z
      .string()
      .min(1)
      .describe('Required: the orchestrator reads it to decide when to call this subagent.'),
    model: agentFields.model.optional().describe('Model id. Inherits the orchestrator\'s when omitted.'),
    instruction: agentFields.instruction.optional(),
    yaml_reference: z
      .string()
      .min(1)
      .optional()
      .describe(
        'A whole nested syndicate (filename under the agents dir) used as this subagent. An approval request or ask_user question raised inside it pauses the turn with the agent path (ADR 0110, ADR 0111): a delegate syndicate\'s gates anywhere, a dispatch syndicate\'s on its classifier (its routes never run nested), and a workflow\'s ask_user nodes and gates when it is delegated to as a subagent.',
      ),
    a2a_agent_url: z
      .string()
      .min(1)
      .optional()
      .describe(
        'A remote agent over A2A: the server base URL or its agent-card URL. Needs no model or instruction; credentials come from A2A_AGENT_TOKENS, never YAML.',
      ),
  })
  .describe('A subagent: an inline agent, a nested syndicate (yaml_reference), or a remote A2A agent (a2a_agent_url).');

// ── Dispatch ─────────────────────────────────────────────────────────────────

const routeOverride = z.strictObject({
  route: z.string().min(1).describe('Subagent to run on a match.'),
  pattern: z.string().min(1).describe('JS regular expression source tested against the raw message.'),
  flags: z.string().optional().describe('Regex flags. Default "i".'),
  reason: z.string().optional().describe('Shown to the waiting user as the [STATUS] route note.'),
});

const dispatchSchema = z
  .strictObject({
    default_route: z
      .string()
      .min(1)
      .describe('Subagent used whenever routing yields no usable answer. Must name a declared subagent.'),
    route_key: z.string().optional().describe('JSON property holding the chosen route. Default "route".'),
    reason_key: z.string().optional().describe('JSON property holding the justification. Default "reason".'),
    route_overrides: z.array(routeOverride).optional(),
  })
  .describe('Opts into PLAN-DISPATCH orchestration (lib/dispatch.ts).');

// ── Workflow ─────────────────────────────────────────────────────────────────

const nodeName = z.string().min(1);
const edgeTargets = z.union([nodeName, z.array(nodeName).min(1)]);
/** One element of an edge chain: a name, several names, or a routing map. */
const edgeElement = z.union([
  nodeName,
  z.array(nodeName).min(1).describe('Several nodes: fan-out when they follow one node, fan-in when one node follows them.'),
  z
    .record(z.string().min(1), edgeTargets)
    .describe('A routing map after a node: `{ <route>: <node or nodes>, default: <node> }`, matched against that node\'s output.'),
]);

/** An error class name, as ADK matches `exceptions` against one: an identifier. */
const ERROR_NAME = /^[A-Za-z_$][\w$]*$/;

const retrySchema = z
  .strictObject({
    max_attempts: z.number().int().positive().optional().describe('Attempts including the first; 1 = no retry. Default 5.'),
    initial_delay: z.number().nonnegative().optional().describe('Seconds before the first retry.'),
    max_delay: z.number().nonnegative().optional(),
    backoff_factor: z.number().positive().optional(),
    jitter: z.number().nonnegative().optional().describe('Randomness of the backoff; 0 = none. Default 1.'),
    exceptions: z
      .array(z.string().regex(ERROR_NAME, 'an error name, such as TypeError or NodeTimeoutError'))
      .min(1)
      .optional()
      .describe('Error names to retry on (the error\'s class or its `name`); every error when absent.'),
  })
  .describe('Retry a node on failure (lib/workflow.ts).');

const workflowNodeSchema = z
  .strictObject({
    ask_user: z.string().min(1).optional().describe('Pause and ask the person this; the reply becomes the node\'s output.'),
    schema: z.record(z.string(), z.unknown()).optional().describe('JSON Schema a structured reply to ask_user must satisfy; plain text passes as is.'),
    join: z.literal(true).optional().describe('Wait for every predecessor; output `{ <predecessor>: <output> }`.'),
    map: z.string().min(1).optional().describe('Run this agent once per item of a list input, concurrently; output the list of results.'),
    max_parallel: z.number().int().positive().optional().describe('Concurrency of map. Default 8.'),
    tool: z.string().min(1).optional().describe('Run this registry tool with the node input as its arguments.'),
    route_key: z.string().min(1).optional().describe('Property of a JSON output holding the route. Default "route".'),
    retry: retrySchema.optional().describe('Retry this node on failure. Not on a map node: each item runs under its agent\'s own retry.'),
    timeout: z.number().positive().optional().describe('Seconds this node may run before it fails. Not on a map node: each item runs under its agent\'s own timeout.'),
  })
  .describe('A declared node (exactly one of ask_user, join, map, tool) or modifiers for an agent node (retry, timeout, route_key).');

const workflowSchema = z
  .strictObject({
    edges: z
      .array(z.array(edgeElement).min(2))
      .min(1)
      .describe('Chains of nodes, each a list; `START` begins at least one. A routing map follows the node whose output it routes.'),
    nodes: z.record(nodeName, workflowNodeSchema).optional(),
    max_concurrency: z.number().int().positive().optional().describe('Nodes that may run at once. Default: unbounded.'),
  })
  .describe('Opts into a WORKFLOW: the syndicate as a graph (lib/workflow.ts). Cannot be combined with dispatch.');

// ── Syndicate ────────────────────────────────────────────────────────────────

export const syndicateSchema = z
  .strictObject({
    syndicate_name: z.string().min(1).describe('Display name for this syndicate.'),
    orchestrator: agentSchema,
    subagents: z
      .array(subagentSchema)
      .optional()
      .describe('The orchestrator\'s team. Omit it (or write `subagents: []`) for a single-agent syndicate.'),
    dispatch: dispatchSchema.optional(),
    workflow: workflowSchema.optional(),
    retries: z
      .strictObject({
        model_errors: z.number().int().min(0).max(5).optional().describe('Retries of a malformed model reply. Default 2; 0 off.'),
        tool_errors: z.number().int().min(0).max(5).optional().describe('Retries of a tool that threw, with reflection guidance. Default 3; 0 off.'),
      })
      .optional()
      .describe('Self-correction on model and tool errors: the engine\'s reflect-and-retry. On by default.'),
    variables: z
      .record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
      .optional()
      .describe('Defaults for {{token}} interpolation. {{current_date}} is built in.'),
    memory_system: z
      .enum(MEMORY_SYSTEMS)
      .optional()
      .describe('Persistence and semantic-memory layer.'),
    guards: z
      .array(z.string().min(1))
      .optional()
      .describe('Post-answer guards by name (lib/guards/index.ts).'),
    memory_namespace: z
      .string()
      .regex(/^[A-Za-z0-9._-]{1,96}$/, 'letters, digits, ".", "_" and "-" only (max 96)')
      .optional()
      .describe('Where long-term memory is stored: the syndicate name plus a generated id, written once and never recomputed (ADR 0020). Syndicates that declare the same namespace share memory.'),
    memory_extraction_rules: z
      .string()
      .optional()
      .describe('Domain rules appended to the fact-extraction prompt (long-term memory only).'),
    memory_extraction_model: z
      .string()
      .min(1)
      .optional()
      .describe("The model that distils this syndicate's turns into memory records; default MEMORY_EXTRACTION_MODEL (ADR 0020)."),
    memory_retention_days: z
      .number()
      .int()
      .positive()
      .optional()
      .describe('Days a memory fact is kept in this syndicate\'s namespace; older facts are deleted daily. Needs memory_namespace (ADR 0020).'),
    max_steps: z
      .number()
      .int()
      .positive()
      .optional()
      .describe('Hard cap on model calls per turn, subagents included. Default 50 (DEFAULT_MAX_STEPS) when unset.'),
    max_concurrency: z
      .number()
      .int()
      .positive()
      .max(MAX_DELEGATION_CONCURRENCY)
      .optional()
      .describe('Subagent calls from one orchestrator step that run at once; the rest wait their turn, in call order. Default 4; 1 runs them one after another. A delegate syndicate only (ADR 0116).'),
    bundled_references: z
      .record(z.string(), z.record(z.string(), z.unknown()))
      .optional()
      .describe(
        'Written by the registry publisher, not by hand: every nested yaml_reference this syndicate reaches, as it was when published, so a registry version is one unit (ADR 0018). Nested references load from here instead of from files.',
      ),
  })
  .describe('A Melchizedek syndicate definition (lib/loadSyndicate.ts).');

// ── Did-you-mean ─────────────────────────────────────────────────────────────

/** Optimal-string-alignment distance: a transposition ("modle") costs 1. */
function editDistance(a: string, b: string): number {
  const d: number[][] = Array.from({ length: a.length + 1 }, (_, i) =>
    Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)),
  );
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
      }
    }
  }
  return d[a.length][b.length];
}

/**
 * The closest candidate, if it is close enough to be a typo. Case and
 * snake/camel drift (`output_key` for `outputKey`) count as an exact match.
 */
export function suggest(input: string, candidates: readonly string[]): string | undefined {
  const norm = (s: string) => s.replace(/[_-]/g, '').toLowerCase();
  const exact = candidates.find((c) => norm(c) === norm(input));
  if (exact) return exact;
  let best: string | undefined;
  let bestD = Infinity;
  for (const c of candidates) {
    const dist = editDistance(input.toLowerCase(), c.toLowerCase());
    if (dist < bestD) {
      best = c;
      bestD = dist;
    }
  }
  // The second bound stops a one-letter name "suggesting" another one-letter
  // name: replacing every character is not a typo.
  return best !== undefined &&
    bestD <= Math.max(2, Math.floor(best.length / 3)) &&
    bestD < Math.max(input.length, best.length)
    ? best
    : undefined;
}

// ── Reporting ────────────────────────────────────────────────────────────────

type Path = readonly PropertyKey[];

function formatPath(p: Path): string {
  let out = '';
  for (const seg of p) {
    if (typeof seg === 'number') out += `[${seg}]`;
    else out += out ? `.${String(seg)}` : String(seg);
  }
  return out || '(root)';
}

/** The strict object whose keys are valid at `p`, for did-you-mean. */
function knownKeysAt(p: Path): readonly string[] {
  const key = p.map((s) => (typeof s === 'number' ? '#' : String(s))).join('/');
  switch (key) {
    case '':
      return Object.keys(syndicateSchema.shape);
    case 'orchestrator':
      return Object.keys(agentSchema.shape);
    case 'subagents/#':
      return Object.keys(subagentSchema.shape);
    case 'dispatch':
      return Object.keys(dispatchSchema.shape);
    case 'dispatch/route_overrides/#':
      return Object.keys(routeOverride.shape);
    case 'orchestrator/orchestration':
    case 'subagents/#/orchestration':
      return ['role', 'delegates'];
    default:
      return [];
  }
}

function valueAt(root: unknown, p: Path): unknown {
  let cur: unknown = root;
  for (const seg of p) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<PropertyKey, unknown>)[seg as PropertyKey];
  }
  return cur;
}

function describeValue(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'a list';
  if (typeof v === 'object') return 'a mapping';
  if (typeof v === 'string') return JSON.stringify(v.length > 40 ? `${v.slice(0, 40)}…` : v);
  return String(v);
}

interface Problem {
  path: Path;
  message: string;
  /** Unknown keys sort first: "orchestator — did you mean orchestrator?" explains the "orchestrator — required" after it. */
  typo?: boolean;
}

function problemsFromIssues(issues: readonly z.core.$ZodIssue[], raw: unknown): Problem[] {
  const out: Problem[] = [];
  for (const issue of issues) {
    const p = issue.path as Path;
    if (issue.code === 'unrecognized_keys') {
      const known = knownKeysAt(p);
      for (const k of issue.keys) {
        const hint = suggest(k, known);
        out.push({
          path: [...p, k],
          message: `unknown key${hint ? ` (did you mean "${hint}"?)` : ''}`,
          typo: true,
        });
      }
      continue;
    }
    const got = valueAt(raw, p);
    if (issue.code === 'invalid_type' && got === undefined) {
      out.push({ path: p, message: 'required' });
      continue;
    }
    if (issue.code === 'invalid_value') {
      const values = issue.values.map(String);
      const hint = typeof got === 'string' ? suggest(got, values) : undefined;
      out.push({
        path: p,
        message:
          `must be one of ${values.join(' | ')} (got ${describeValue(got)}` +
          (hint ? ` — did you mean "${hint}"?)` : ')'),
      });
      continue;
    }
    if (issue.code === 'invalid_type') {
      out.push({ path: p, message: `expected ${issue.expected}, got ${describeValue(got)}` });
      continue;
    }
    if (issue.code === 'too_small' && issue.origin === 'string') {
      out.push({ path: p, message: 'must not be empty' });
      continue;
    }
    if (issue.code === 'too_small' && issue.origin === 'number') {
      out.push({ path: p, message: `must be ${Number(issue.minimum) === 0 ? '0 or more' : 'a positive integer'} (got ${describeValue(got)})` });
      continue;
    }
    out.push({ path: p, message: issue.message });
  }
  return out;
}

/** The generateContentConfig keys `reasoning` replaces (ADR 0047). */
export const REASONING_OLDER_SPELLING = ['thinkingConfig', 'reasoningEffort'] as const;

const isObj = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);

/** Same normalisation lib/dispatch.ts uses to match a route to a subagent. */
const routeNorm = (s: string) => s.replace(/[^a-z0-9]/gi, '').toLowerCase();

/**
 * Rules that span fields, which a JSON Schema an editor reads cannot express
 * cleanly. Defensive about shape: runs on raw input alongside zod, so a file
 * with a type error still gets its cross-field problems listed in one pass.
 */
function crossFieldProblems(raw: unknown): Problem[] {
  const out: Problem[] = [];
  if (!isObj(raw)) return out;
  // Retention prunes a namespace; on the shared default namespace it would
  // delete other syndicates' facts.
  if (raw.memory_retention_days !== undefined && typeof raw.memory_namespace !== 'string') {
    out.push({
      path: ['memory_retention_days'],
      message: 'needs memory_namespace — retention applies to one namespace, never to the shared default (npm run doctor -- --fix-namespaces <file>)',
    });
  }
  const subs = Array.isArray(raw.subagents) ? raw.subagents : [];

  // Approval gates (ADR 0028): only tools the agent has. A delegated
  // subagent's pause reaches the caller through the open call (ADR 0110),
  // so every agent of a delegate, dispatch or workflow syndicate may gate.
  const gateProblems = (agent: Record<string, unknown>, path: (string | number)[], allowed: boolean) => {
    if (agent.require_approval === undefined) return;
    if (!allowed) {
      out.push({
        path: [...path, 'require_approval'],
        message: 'approval gates are not supported here (ADR 0028, ADR 0110)',
      });
      return;
    }
    const tools = Array.isArray(agent.tools) ? agent.tools : [];
    // An OpenAPI operation can be gated once it is named under `operations`,
    // and an MCP tool once it is named under `mcp_tools`.
    const operations = (Array.isArray(agent.openapi) ? agent.openapi : []).flatMap((e) => (isObj(e) && Array.isArray(e.operations) ? e.operations : []));
    const mcpTools = Array.isArray(agent.mcp_tools) ? agent.mcp_tools : [];
    (Array.isArray(agent.require_approval) ? agent.require_approval : []).forEach((name, j) => {
      if (typeof name === 'string' && !tools.includes(name) && !operations.includes(name) && !mcpTools.includes(name)) {
        out.push({ path: [...path, 'require_approval', j], message: `'${name}' is not in this agent's tools, its openapi operations or its mcp_tools` });
      }
    });
  };
  // A skill script run pauses for approval the same way, so it is allowed in
  // the same places; `skills.tools` may only unlock tools the agent does not
  // already carry outright.
  const skillProblems = (agent: Record<string, unknown>, path: (string | number)[], allowed: boolean) => {
    if (!isObj(agent.skills)) return;
    if (agent.skills.scripts === 'local' && !allowed) {
      out.push({
        path: [...path, 'skills', 'scripts'],
        message: 'skill scripts on a delegated subagent are not supported yet; run them on the orchestrator or a plan-dispatch route (ADR 0110)',
      });
    }
    const tools = Array.isArray(agent.tools) ? agent.tools : [];
    (Array.isArray(agent.skills.tools) ? agent.skills.tools : []).forEach((name, j) => {
      if (typeof name === 'string' && tools.includes(name)) {
        out.push({ path: [...path, 'skills', 'tools', j], message: `'${name}' is already in this agent's tools; a skill cannot unlock what is always on` });
      }
    });
  };
  // ask_user ends the turn waiting for the person, the same pause as an
  // approval, so it is allowed in the same places (lib/runtime/questions.ts),
  // a delegated subagent included (ADR 0110); a workflow node asks through an ask_user node.
  const questionProblems = (agent: Record<string, unknown>, path: (string | number)[], allowed: boolean) => {
    const tools = Array.isArray(agent.tools) ? agent.tools : [];
    const at = tools.indexOf('ask_user');
    if (at === -1) return;
    if (isObj(raw.workflow)) {
      out.push({ path: [...path, 'tools', at], message: 'ask_user is not supported on a workflow node yet; use an ask_user node (workflow.nodes)' });
    } else if (!allowed) {
      out.push({ path: [...path, 'tools', at], message: 'ask_user is not supported here (ADR 0110)' });
    }
  };
  // Execution keys (ADR 0033): where each one means something.
  const executionProblems = (agent: Record<string, unknown>, path: (string | number)[], isOrchestrator: boolean) => {
    const model = typeof agent.model === 'string' ? agent.model : isObj(raw.orchestrator) && typeof raw.orchestrator.model === 'string' ? raw.orchestrator.model : '';
    if (agent.code_execution !== undefined && model && !/^gemini-/.test(model)) {
      out.push({ path: [...path, 'code_execution'], message: `code_execution: gemini needs a gemini-* model (this agent's is ${model})` });
    }
    if (agent.context !== undefined && (!isOrchestrator || isObj(raw.dispatch) || isObj(raw.workflow))) {
      out.push({
        path: [...path, 'context'],
        message: 'context compaction applies to the orchestrator of a delegate syndicate: a dispatch route reads a bounded projection, a workflow node sees only its input, and a subagent starts fresh on every call',
      });
    }
    if (agent.mode !== undefined && !isObj(raw.workflow)) {
      out.push({ path: [...path, 'mode'], message: 'mode: task applies to workflow nodes, whose output is the finish_task arguments' });
    }
    if (agent.mcp_tools !== undefined && typeof agent.mcp_server_url !== 'string') {
      out.push({ path: [...path, 'mcp_tools'], message: 'mcp_tools chooses among an MCP server\'s tools; it needs mcp_server_url' });
    }
    if (agent.mcp_auth !== undefined && typeof agent.mcp_server_url !== 'string') {
      out.push({ path: [...path, 'mcp_auth'], message: 'mcp_auth is the grant an MCP server takes; it needs mcp_server_url' });
    }
    if (isObj(agent.mcp_auth) && isObj(agent.mcp_auth.oauth2) && agent.mcp_auth.oauth2.grant === 'authorization_code' && agent.mcp_tools === undefined) {
      out.push({ path: [...path, 'mcp_auth'], message: 'an authorization_code mcp_auth needs mcp_tools: no user\'s grant exists at startup to list the server\'s tools' });
    }
  };
  if (isObj(raw.orchestrator)) executionProblems(raw.orchestrator, ['orchestrator'], true);
  // max_concurrency bounds an orchestrator's delegated calls (ADR 0116): a workflow bounds its nodes under workflow:, and a dispatch classifier delegates nothing.
  if (raw.max_concurrency !== undefined && (isObj(raw.workflow) || isObj(raw.dispatch))) {
    out.push({
      path: ['max_concurrency'],
      message: isObj(raw.workflow)
        ? 'max_concurrency at the root bounds a delegate orchestrator\'s subagent calls; a workflow bounds its nodes with workflow.max_concurrency'
        : 'max_concurrency bounds a delegate orchestrator\'s subagent calls; a dispatch syndicate\'s classifier delegates nothing (set it in a route\'s own syndicate file)',
    });
  }
  for (const [i, sub] of (Array.isArray(raw.subagents) ? raw.subagents : []).entries()) if (isObj(sub)) executionProblems(sub, ['subagents', i], false);

  // One spelling per agent (ADR 0047): `reasoning` is mapped onto the very
  // fields the older spelling sets, so the two together would leave which
  // one wins to merge order.
  const reasoningProblems = (agent: Record<string, unknown>, path: (string | number)[]) => {
    if (agent.reasoning === undefined) return;
    if (typeof agent.yaml_reference === 'string' || typeof agent.a2a_agent_url === 'string') {
      out.push({ path: [...path, 'reasoning'], message: 'applies to an inline agent; a nested syndicate (yaml_reference) or a remote agent (a2a_agent_url) sets its own' });
    }
    if (!isObj(agent.generateContentConfig)) return;
    for (const key of REASONING_OLDER_SPELLING) {
      if (agent.generateContentConfig[key] === undefined) continue;
      out.push({
        path: [...path, 'reasoning'],
        message: `cannot be combined with generateContentConfig.${key}; reasoning replaces it, so keep one (ADR 0047)`,
      });
    }
  };
  if (isObj(raw.orchestrator)) reasoningProblems(raw.orchestrator, ['orchestrator']);
  for (const [i, sub] of subs.entries()) if (isObj(sub)) reasoningProblems(sub, ['subagents', i]);

  if (isObj(raw.orchestrator)) {
    gateProblems(raw.orchestrator, ['orchestrator'], true);
    skillProblems(raw.orchestrator, ['orchestrator'], true);
    questionProblems(raw.orchestrator, ['orchestrator'], true);
  }
  const dispatching = isObj(raw.dispatch);
  // A workflow's subagents are its nodes, not delegated tools: a gated call pauses its node, and
  // the walk resumes it (ADR 0098); a skill script run pauses on the same approval (ADR 0106). A map item cannot (workflowProblems).
  const pausing = dispatching || isObj(raw.workflow);

  subs.forEach((sub, i) => {
    if (!isObj(sub)) return;
    // A delegated subagent's gate and question pause the turn through the open call (ADR 0110); its skill scripts stay refused.
    gateProblems(sub, ['subagents', i], true);
    skillProblems(sub, ['subagents', i], pausing);
    questionProblems(sub, ['subagents', i], true);
    const hasRef = typeof sub.yaml_reference === 'string';
    const hasRemote = typeof sub.a2a_agent_url === 'string';
    if (hasRef && hasRemote) {
      out.push({
        path: ['subagents', i, 'a2a_agent_url'],
        message: 'cannot be combined with yaml_reference — a subagent is either a nested syndicate or a remote agent',
      });
    }
    if (!hasRef && !hasRemote && sub.instruction === undefined) {
      out.push({
        path: ['subagents', i, 'instruction'],
        message: 'required (or set yaml_reference / a2a_agent_url for a nested or remote agent)',
      });
    }
    if (hasRemote && !/\{\{\w+\}\}/.test(sub.a2a_agent_url as string)) {
      let ok = false;
      try {
        ok = /^https?:$/.test(new URL(sub.a2a_agent_url as string).protocol);
      } catch {
        ok = false;
      }
      if (!ok) {
        out.push({ path: ['subagents', i, 'a2a_agent_url'], message: 'must be an http(s) URL' });
      }
    }
  });

  if (isObj(raw.workflow)) out.push(...workflowProblems(raw, subs));

  // Names must be unique across the tree this file declares: two AgentTools
  // with one name collide, and dispatch routes by name.
  const seen = new Map<string, string>();
  const named: Array<[Path, unknown]> = [
    [['orchestrator', 'name'], isObj(raw.orchestrator) ? raw.orchestrator.name : undefined],
    ...subs.map((s, i): [Path, unknown] => [['subagents', i, 'name'], isObj(s) ? s.name : undefined]),
  ];
  for (const [p, name] of named) {
    if (typeof name !== 'string') continue;
    const first = seen.get(name);
    if (first) out.push({ path: p, message: `duplicate agent name "${name}" (also ${first})` });
    else seen.set(name, formatPath(p));
  }

  if (isObj(raw.dispatch) && typeof raw.dispatch.default_route === 'string') {
    const names = subs.map((s) => (isObj(s) && typeof s.name === 'string' ? s.name : '')).filter(Boolean);
    const target = routeNorm(raw.dispatch.default_route);
    if (!names.some((n) => routeNorm(n) === target)) {
      const hint = suggest(raw.dispatch.default_route, names);
      out.push({
        path: ['dispatch', 'default_route'],
        message:
          `"${raw.dispatch.default_route}" is not a declared subagent` +
          (hint ? ` (did you mean "${hint}"?)` : names.length ? ` (declared: ${names.join(', ')})` : ''),
      });
    }
  }
  return out;
}

/**
 * The rules a `workflow:` block must keep (lib/workflow.ts), which a JSON
 * Schema cannot say: every name is an agent or a declared node, `START`
 * opens a chain and nothing else, a routing map follows the node it routes,
 * a declared node is exactly one kind, and the pauses and remotes the graph
 * cannot carry yet are refused with the reason.
 */
function workflowProblems(raw: Record<string, unknown>, subs: unknown[]): Problem[] {
  const out: Problem[] = [];
  const wf = raw.workflow as Record<string, unknown>;
  if (isObj(raw.dispatch)) {
    out.push({ path: ['workflow'], message: 'a syndicate is a workflow or a plan-dispatch router, not both; remove `dispatch`' });
  }
  const agentNames: string[] = [];
  if (isObj(raw.orchestrator) && typeof raw.orchestrator.name === 'string') agentNames.push(raw.orchestrator.name);
  for (const sub of subs) if (isObj(sub) && typeof sub.name === 'string') agentNames.push(sub.name);
  const nodes = isObj(wf.nodes) ? (wf.nodes as Record<string, WorkflowNodeYaml>) : {};
  const declared = Object.keys(nodes);
  const known = new Set([...agentNames, ...declared]);
  const mapped = new Set<string>();

  // Declared nodes: an agent takes modifiers only; anything else is one kind.
  for (const [name, entry] of Object.entries(nodes)) {
    if (!isObj(entry)) continue;
    const kinds = NODE_KINDS.filter((k) => (entry as Record<string, unknown>)[k] !== undefined);
    const isAgent = agentNames.includes(name);
    if (isAgent && kinds.length > 0) {
      out.push({ path: ['workflow', 'nodes', name], message: `'${name}' is an agent; its node entry may carry only route_key, retry and timeout` });
    } else if (!isAgent && kinds.length !== 1) {
      out.push({ path: ['workflow', 'nodes', name], message: `a declared node is exactly one of ${NODE_KINDS.join(', ')}${kinds.length ? ` (has ${kinds.join(', ')})` : ''}` });
    }
    if (name.endsWith(ROUTE_STEP_SUFFIX) || name === START_NAME) {
      out.push({ path: ['workflow', 'nodes', name], message: `'${name}' is reserved` });
    }
    const kind = nodeKind(entry as WorkflowNodeYaml);
    if (kind === 'map') {
      const target = (entry as WorkflowNodeYaml).map!;
      if (!agentNames.includes(target)) {
        const hint = suggest(target, agentNames);
        out.push({ path: ['workflow', 'nodes', name, 'map'], message: `'${target}' is not an agent of this syndicate${hint ? ` (did you mean "${hint}"?)` : ''}` });
      } else {
        mapped.add(target);
      }
    }
    if (kind !== 'ask_user' && (entry as WorkflowNodeYaml).schema !== undefined) {
      out.push({ path: ['workflow', 'nodes', name, 'schema'], message: 'schema applies to ask_user only' });
    }
    if (kind !== 'map' && (entry as WorkflowNodeYaml).max_parallel !== undefined) {
      out.push({ path: ['workflow', 'nodes', name, 'max_parallel'], message: 'max_parallel applies to map only' });
    }
    // A map item runs under its agent's own modifiers, as on ADK (ADR 0089, ADR 0103): the map entry's would never be applied.
    if (kind === 'map') {
      for (const key of ['retry', 'timeout'] as const) {
        if ((entry as WorkflowNodeYaml)[key] === undefined) continue;
        const target = (entry as WorkflowNodeYaml).map!;
        out.push({ path: ['workflow', 'nodes', name, key], message: `${key} on a map node is not applied: each item runs under its agent's own ${key}; set it on nodes.${target}` });
      }
    }
  }
  for (const name of agentNames) {
    if (name.endsWith(ROUTE_STEP_SUFFIX)) out.push({ path: ['workflow'], message: `agent name '${name}' ends with the reserved suffix ${ROUTE_STEP_SUFFIX}` });
  }

  // Edges.
  const edges = Array.isArray(wf.edges) ? (wf.edges as unknown[]) : [];
  let starts = 0;
  const referenced = new Set<string>();
  const checkName = (name: string, path: Path) => {
    if (known.has(name)) {
      referenced.add(name);
      return;
    }
    const hint = suggest(name, [...known]);
    out.push({ path, message: `'${name}' is not an agent or a declared node${hint ? ` (did you mean "${hint}"?)` : ''}` });
  };
  edges.forEach((chain, i) => {
    if (!Array.isArray(chain)) return;
    chain.forEach((element, j) => {
      const path: Path = ['workflow', 'edges', i, j];
      if (typeof element === 'string') {
        if (element === START_NAME) {
          if (j !== 0) out.push({ path, message: 'START opens a chain; it cannot follow a node' });
          else starts++;
          return;
        }
        checkName(element, path);
      } else if (Array.isArray(element)) {
        element.forEach((name, k) => typeof name === 'string' && checkName(name, [...path, k]));
      } else if (isObj(element)) {
        const previous = chain[j - 1];
        if (typeof previous !== 'string' || previous === START_NAME) {
          out.push({ path, message: 'a routing map follows the name of the node whose output it routes' });
        } else if (!agentNames.includes(previous) && nodeKind(nodes[previous]) !== 'tool') {
          out.push({ path, message: `'${previous}' is a ${nodeKind(nodes[previous]) ?? 'node'}; only an agent or a tool node emits a route` });
        }
        if (j !== chain.length - 1) out.push({ path, message: 'a routing map ends its chain; start another chain from each target' });
        for (const [key, target] of Object.entries(element)) {
          const targets = Array.isArray(target) ? target : [target];
          targets.forEach((name, k) => typeof name === 'string' && checkName(name, [...path, key, k]));
        }
      }
      for (const name of isObj(element) || Array.isArray(element) || typeof element === 'string' ? elementNames(element as EdgeElement) : []) {
        if (mapped.has(name)) out.push({ path, message: `'${name}' is run by a map node; it cannot also appear in an edge` });
      }
    });
  });
  if (edges.length && starts === 0) out.push({ path: ['workflow', 'edges'], message: `no chain begins with ${START_NAME}` });
  for (const name of declared) {
    if (!referenced.has(name) && !agentNames.includes(name)) out.push({ path: ['workflow', 'nodes', name], message: 'declared but used in no edge' });
  }
  void DEFAULT_ROUTE_KEY;

  // What a node cannot carry yet (lib/workflow.ts, "Not in this version").
  const agents: Array<[Path, unknown]> = [
    [['orchestrator'], raw.orchestrator],
    ...subs.map((sub, i): [Path, unknown] => [['subagents', i], sub]),
  ];
  for (const [path, agent] of agents) {
    if (!isObj(agent)) continue;
    // A map item cannot pause: the walk resumes a paused agent node, not an item of a map (ADR 0094, ADR 0098).
    if (typeof agent.name === 'string' && mapped.has(agent.name) && Array.isArray(agent.require_approval) && agent.require_approval.length) {
      out.push({ path: [...path, 'require_approval'], message: 'approval gates are not supported on an agent a map node runs: a map item cannot pause the walk' });
    }
    // A skill script run pauses on the same approval (ADR 0106): allowed on a node, not on a map item.
    if (typeof agent.name === 'string' && mapped.has(agent.name) && isObj(agent.skills) && agent.skills.scripts === 'local') {
      out.push({ path: [...path, 'skills', 'scripts'], message: 'skill scripts (an approval pause) are not supported on an agent a map node runs: a map item cannot pause the walk' });
    }
    if (typeof agent.a2a_agent_url === 'string') {
      out.push({ path: [...path, 'a2a_agent_url'], message: 'a remote agent cannot be a workflow node yet' });
    }
  }
  return out;
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Thrown by validateSyndicateConfig. `problems` holds one `<file>: <path> —
 * <what>` line per problem (the message lists them all); `issues` holds the
 * same lines without the file, for callers that already show it.
 */
export class SyndicateValidationError extends Error {
  readonly file: string | undefined;
  readonly issues: string[];
  readonly problems: string[];
  constructor(issues: string[], file?: string) {
    const problems = issues.map((i) => (file ? `${file}: ${i}` : i));
    super(
      problems.length === 1
        ? problems[0]
        : `${problems.length} problems in syndicate config:\n  ${problems.join('\n  ')}`,
    );
    this.name = 'SyndicateValidationError';
    this.file = file;
    this.issues = issues;
    this.problems = problems;
  }
}

/**
 * Validate a parsed syndicate and return it typed, or throw ONE error that
 * lists every problem as `<file>: <key.path> — <what is wrong>`.
 *
 * Runs on the interpolated config: a `{{token}}` inside a string is still a
 * string, and a full-token number (`max_steps: "{{n}}"`) is checked as the
 * value it resolved to.
 */
export function validateSyndicateConfig(raw: unknown, file?: string): SyndicateYamlConfig {
  if (!isObj(raw)) {
    throw new SyndicateValidationError(
      [`(root) — expected a mapping with syndicate_name, orchestrator and subagents, got ${describeValue(raw)}`],
      file,
    );
  }
  const result = syndicateSchema.safeParse(raw);
  const problems = [
    ...(result.success ? [] : problemsFromIssues(result.error.issues, raw)),
    ...crossFieldProblems(raw),
  ];
  if (problems.length > 0) {
    const ordered = [...problems.filter((p) => p.typo), ...problems.filter((p) => !p.typo)];
    throw new SyndicateValidationError(
      ordered.map((p) => `${formatPath(p.path)} — ${p.message}`),
      file,
    );
  }
  // A single-agent syndicate may omit `subagents`; callers always get a list.
  if (raw.subagents === undefined) raw.subagents = [];
  return raw as unknown as SyndicateYamlConfig;
}

/**
 * The syndicate contract as JSON Schema (draft-07: the widest editor
 * support), for `# yaml-language-server: $schema=` and other tooling.
 * Cross-field rules zod expresses as code are added back where JSON Schema
 * can say them, so an editor flags a subagent with no instruction too.
 */
export function syndicateJsonSchema(): Record<string, unknown> {
  const schema = z.toJSONSchema(syndicateSchema, {
    target: 'draft-7',
    override: (ctx) => {
      // `\p{ID_Start}` needs the regex `u` flag, which JSON Schema validators
      // do not all apply; the ASCII form only over-warns on non-Latin names,
      // and still catches the common mistake (a space in a name).
      if (ctx.jsonSchema.pattern === AGENT_NAME_RE.source) {
        ctx.jsonSchema.pattern = '^[A-Za-z_$][A-Za-z0-9_$-]*$';
      }
      if (ctx.zodSchema === (subagentSchema as unknown)) {
        ctx.jsonSchema.anyOf = [
          { required: ['instruction'] },
          { required: ['yaml_reference'] },
          { required: ['a2a_agent_url'] },
        ];
        ctx.jsonSchema.not = { required: ['yaml_reference', 'a2a_agent_url'] };
      }
    },
  }) as Record<string, unknown>;
  return { ...schema, title: 'Melchizedek syndicate' };
}
