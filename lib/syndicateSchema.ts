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
import type { EdgeElement, WorkflowNodeYaml } from './workflowConfig.ts';

// ── Leaf rules ───────────────────────────────────────────────────────────────

/**
 * ADK's own rule (validateAgentName in @google/adk base_agent): checked here
 * so the error names the YAML key instead of surfacing from a constructor
 * mid-compile.
 */
const AGENT_NAME_RE = /^[\p{ID_Start}$_][\p{ID_Continue}$_-]*$/u;

const agentName = z
  .string()
  .regex(AGENT_NAME_RE, 'must be a valid identifier (letters, digits, _ and -; not starting with a digit)')
  .refine((n) => n !== 'user', "'user' is reserved by ADK for the end user's input")
  .describe('Unique agent name within the tree. A valid identifier; cannot be "user".');

export const MEMORY_SYSTEMS = ['internal-only', 'session-only', 'long-term'] as const;

const thinkingConfig = z
  .looseObject({
    thinkingBudget: z.number().int().optional().describe('Reasoning token budget. 0 = off, -1 = dynamic.'),
    includeThoughts: z.boolean().optional().describe('Stream the thinking trace in the response.'),
  })
  .describe('Gemini thinking controls (generateContentConfig.thinkingConfig).');

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
  })
  .describe('Model generation config (@google/genai GenerateContentConfig). Do not set tools here.');

// ── Skills ───────────────────────────────────────────────────────────────────

export const SKILL_SCRIPT_MODES = ['none', 'local'] as const;

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
  })
  .describe('Agent Skills (SKILL.md directories) this agent reads the way a coding harness does.');

// ── OpenAPI ──────────────────────────────────────────────────────────────────

const envName = z.string().regex(/^[A-Z_][A-Z0-9_]*$/, 'an environment variable name (A–Z, 0–9, _)');
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
      })
      .refine((a) => !!a.bearer_env !== !!a.api_key, 'exactly one of bearer_env or api_key')
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
      'Tools from this agent\'s `tools` that run only after a person approves the exact call (ADR 0028): the A2A task ends input-required until the caller answers approve or reject. Allowed on the orchestrator and on plan-dispatch routes.',
    ),
  includeContents: z
    .enum(['default', 'none'])
    .optional()
    .describe('"default" = include conversation history, "none" = stateless.'),
  disallowTransferToParent: z.boolean().optional(),
  disallowTransferToPeers: z.boolean().optional(),
  outputKey: z.string().optional().describe('Session-state key the final reply is saved under.'),
  generateContentConfig: generateContentConfig.optional(),
  outputSchema: z
    .record(z.string(), z.unknown())
    .optional()
    .describe('JSON Schema for structured output. Cannot be combined with AgentTool delegation.'),
  mcp_server_url: z
    .string()
    .optional()
    .describe('MCP server (SSE) whose tools are discovered at runtime and merged with `tools`.'),
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
  .describe('The root agent (ADK LlmAgentConfig).');

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
      .describe('A whole nested syndicate (filename under the agents dir) used as this subagent.'),
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

const retrySchema = z
  .strictObject({
    max_attempts: z.number().int().positive().optional().describe('Attempts including the first; 1 = no retry. ADK default 5.'),
    initial_delay: z.number().nonnegative().optional().describe('Seconds before the first retry.'),
    max_delay: z.number().nonnegative().optional(),
    backoff_factor: z.number().positive().optional(),
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
    retry: retrySchema.optional(),
    timeout: z.number().positive().optional().describe('Seconds this node may run before it fails.'),
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
      .describe('Self-correction on model and tool errors (ADK reflect-and-retry plugins). On by default.'),
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
      .describe('Hard cap on runner loops (LLM → tool cycles).'),
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
      out.push({ path: p, message: `must be a positive integer (got ${describeValue(got)})` });
      continue;
    }
    out.push({ path: p, message: issue.message });
  }
  return out;
}

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

  // Approval gates (ADR 0028): only tools the agent has, and only on agents
  // the turn runs directly — a delegated subagent runs inside a tool call,
  // where ADK swallows the pause and the gated tool silently never runs.
  const gateProblems = (agent: Record<string, unknown>, path: (string | number)[], allowed: boolean) => {
    if (agent.require_approval === undefined) return;
    if (!allowed) {
      out.push({
        path: [...path, 'require_approval'],
        message: 'approval gates run only on the orchestrator or a plan-dispatch route; a delegated subagent cannot pause the turn (ADR 0028)',
      });
      return;
    }
    const tools = Array.isArray(agent.tools) ? agent.tools : [];
    // An OpenAPI operation can be gated once it is named under `operations`.
    const operations = (Array.isArray(agent.openapi) ? agent.openapi : []).flatMap((e) => (isObj(e) && Array.isArray(e.operations) ? e.operations : []));
    (Array.isArray(agent.require_approval) ? agent.require_approval : []).forEach((name, j) => {
      if (typeof name === 'string' && !tools.includes(name) && !operations.includes(name)) {
        out.push({ path: [...path, 'require_approval', j], message: `'${name}' is not in this agent's tools or its openapi operations` });
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
        message: 'skill scripts pause for approval, which only the orchestrator or a plan-dispatch route can do; a delegated subagent cannot pause the turn (ADR 0028)',
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
  // approval, so it is allowed in the same places (lib/runtime/questions.ts).
  const questionProblems = (agent: Record<string, unknown>, path: (string | number)[], allowed: boolean) => {
    const tools = Array.isArray(agent.tools) ? agent.tools : [];
    const at = tools.indexOf('ask_user');
    if (at === -1) return;
    if (isObj(raw.workflow)) {
      out.push({ path: [...path, 'tools', at], message: 'ask_user is not supported on a workflow node yet; use an ask_user node (workflow.nodes)' });
    } else if (!allowed) {
      out.push({ path: [...path, 'tools', at], message: 'ask_user pauses the turn, which only the orchestrator or a plan-dispatch route can do; a delegated subagent cannot' });
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
  };
  if (isObj(raw.orchestrator)) executionProblems(raw.orchestrator, ['orchestrator'], true);
  for (const [i, sub] of (Array.isArray(raw.subagents) ? raw.subagents : []).entries()) if (isObj(sub)) executionProblems(sub, ['subagents', i], false);

  if (isObj(raw.orchestrator)) {
    gateProblems(raw.orchestrator, ['orchestrator'], true);
    skillProblems(raw.orchestrator, ['orchestrator'], true);
    questionProblems(raw.orchestrator, ['orchestrator'], true);
  }
  const dispatching = isObj(raw.dispatch);

  subs.forEach((sub, i) => {
    if (!isObj(sub)) return;
    gateProblems(sub, ['subagents', i], dispatching);
    skillProblems(sub, ['subagents', i], dispatching);
    questionProblems(sub, ['subagents', i], dispatching);
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
    if (Array.isArray(agent.require_approval) && agent.require_approval.length) {
      out.push({ path: [...path, 'require_approval'], message: 'approval gates are not supported inside a workflow yet' });
    }
    if (isObj(agent.skills) && agent.skills.scripts === 'local') {
      out.push({ path: [...path, 'skills', 'scripts'], message: 'skill scripts (an approval pause) are not supported inside a workflow yet' });
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
