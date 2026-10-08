/**
 * lib/models/capabilities.ts — what an agent keeps and loses on the path
 * its model will actually take.
 *
 * WHY this file exists:
 *   A model id is the whole routing decision, and some of what an agent
 *   declares only exists on one provider: Gemini grounding, xAI's x_search
 *   and Collections, the server-side web_search sentinel that every cloud
 *   adapter turns into its provider's native search. Until now the only
 *   defence against losing one was a one-time console.warn inside an
 *   adapter. This module states the loss BEFORE a request is made, per
 *   agent, on the RESOLVED transport (direct or gateway), so the doctor
 *   (lib/doctor.ts), the A2A startup log (lib/compile.ts) and the ledger
 *   (llm.capability.dropped) all say the same thing.
 *
 * It knows nothing about gateways beyond planTransport(); a future
 * transport that restores a native feature changes the table here, not
 * the callers.
 */

import { PROVIDERS } from './providerMap.ts';
import type { ProviderId } from './providerMap.ts';
import { planTransport } from './gateway.ts';
import type { TransportPlan } from './gateway.ts';
import { nativeSearchOn, PLATFORMS_FOR, platformFromEnv } from './endpoints.ts';
import type { Platform } from './endpoints.ts';
import { claudeUrlImagesOn } from './claudeModels.ts';
import type { ReasoningSetting } from '../loadSyndicate.ts';

/** The platform a direct path uses (ADR 0023); a misconfigured one reads as direct here, the doctor reports it. */
function directPlatform(provider: ProviderId): Platform {
  try {
    return platformFromEnv(provider);
  } catch {
    return 'direct';
  }
}

/**
 * Server-side tool sentinels and the providers whose DIRECT adapter
 * honours them natively. Anything not listed is a client-side function
 * tool and travels on every path.
 */
export const SERVER_SIDE_TOOLS: Record<string, ProviderId[]> = {
  web_search: ['gemini', 'anthropic', 'openai', 'xai'],
  google_search: ['gemini'],
  url_context: ['gemini'],
  x_search: ['xai'],
  collections_search: ['xai'],
};

export interface CapabilityReport {
  model: string;
  provider: ProviderId;
  providerLabel: string;
  transport: TransportPlan['transport'];
  /** Gateway id when transport is 'gateway'. */
  gateway?: string;
  /** The cloud platform of a direct path (ADR 0023); absent on Ollama and the gateway. */
  platform?: Platform;
  /** False when neither a direct key nor a gateway can serve this id. */
  funded: boolean;
  /** The env var that would fund the direct path. */
  keyEnv: string | null;
  /** Declared server-side tools this path runs natively. */
  native: string[];
  /** Declared server-side tools this path cannot run — they are omitted. */
  dropped: string[];
  /** Declared client-side tools; portable across every path. */
  portable: string[];
}

export function describeCapabilities(
  model: string,
  tools: readonly string[] = [],
  opts: { callerKey?: boolean } = {},
): CapabilityReport {
  const plan = planTransport(model, opts);
  const platform = plan.transport === 'direct' && plan.provider !== 'ollama' ? directPlatform(plan.provider) : undefined;
  const native: string[] = [];
  const dropped: string[] = [];
  const portable: string[] = [];
  for (const name of tools) {
    const providers = SERVER_SIDE_TOOLS[name];
    if (!providers) {
      portable.push(name);
    } else if (plan.transport === 'direct' && providers.includes(plan.provider) && nativeSearchOn(plan.provider, platform ?? 'direct')) {
      native.push(name);
    } else {
      dropped.push(name);
    }
  }
  return {
    model,
    provider: plan.provider,
    providerLabel: PROVIDERS[plan.provider].label,
    transport: plan.transport,
    ...(plan.gateway ? { gateway: plan.gateway.id } : {}),
    ...(platform && platform !== 'direct' ? { platform } : {}),
    funded: plan.funded,
    keyEnv: plan.keyEnv,
    native,
    dropped,
    portable,
  };
}

/**
 * One line for a startup log, or undefined when there is nothing to say —
 * a funded direct path with no dropped tool is the quiet default.
 */
export function capabilitySummary(agentName: string, r: CapabilityReport): string | undefined {
  if (!r.funded) {
    return `${agentName}: ${r.model} has no route — set ${r.keyEnv ?? 'a provider key'} (or a MODEL_GATEWAY).`;
  }
  const via = r.transport === 'gateway' ? ` via gateway:${r.gateway}` : '';
  if (r.dropped.length === 0) {
    return via ? `${agentName}: ${r.model}${via}.` : undefined;
  }
  const why =
    r.transport === 'gateway'
      ? 'a gateway cannot enable upstream native search'
      : r.provider === 'ollama'
        ? 'a local model has no native search'
        : r.platform
          ? `native search is not sent to ${r.providerLabel} on ${r.platform}`
          : `${r.providerLabel} has no native ${r.dropped.join('/')}`;
  return `${agentName}: ${r.model}${via} — dropped ${r.dropped.join(', ')} (${why}).`;
}

// ── The capability matrix (ADR 0019) ─────────────────────────────────────────
//
// "Multi-model" promises that any provider can run any role, orchestrators
// included. This table states, per resolved path (a direct provider, or the
// gateway transport), what an agent can rely on. Each cell describes what the
// ADAPTER SENDS, not how a given model behaves once it receives the request:
//
//   supported    the feature reaches the provider in its native form
//   degraded     it reaches the provider in a weaker form; `note` names the loss
//   unsupported  the adapter does not send it; `note` says what happens instead
//
// `evidence: 'test'` cells are asserted against the real outgoing request body
// in tests/capabilityMatrix.test.ts, so changing an adapter without changing
// its row fails a test. `evidence: 'adk'` cells are ADK's own Gemini adapter,
// which this repo does not build requests for.

export const CAPABILITIES = [
  'delegation',
  'memory_tools',
  'structured_output',
  'thinking_with_tools',
  'streaming',
  'vision',
  'native_search',
] as const;
export type Capability = (typeof CAPABILITIES)[number];

export const CAPABILITY_LABELS: Record<Capability, string> = {
  delegation: 'delegation (subagents as tools)',
  memory_tools: 'memory tools (load_memory)',
  structured_output: 'structured output (outputSchema)',
  thinking_with_tools: 'thinking with tool use',
  streaming: 'token streaming',
  vision: 'image input',
  native_search: 'native web search',
};

export type Support = 'supported' | 'degraded' | 'unsupported';

export interface CapabilityCell {
  support: Support;
  /** What is lost, or what happens instead. Present unless `supported` is the whole story. */
  note?: string;
  evidence: 'test' | 'adk';
}

/** Matrix rows: each direct provider, plus the gateway transport. */
export type MatrixRow = ProviderId | 'gateway';

const ok = (evidence: CapabilityCell['evidence'] = 'test', note?: string): CapabilityCell =>
  note ? { support: 'supported', note, evidence } : { support: 'supported', evidence };
const degraded = (note: string): CapabilityCell => ({ support: 'degraded', note, evidence: 'test' });
const unsupported = (note: string): CapabilityCell => ({ support: 'unsupported', note, evidence: 'test' });

const nativeSearch = (row: ProviderId): CapabilityCell =>
  SERVER_SIDE_TOOLS.web_search.includes(row)
    ? ok(row === 'gemini' ? 'adk' : 'test')
    : unsupported('no native search on this path; the web_search sentinel is dropped (use web_extract)');

const responsesReasoningNote = (ids: string): string =>
  `encrypted reasoning items are replayed verbatim within the turn's tool loop, with store: false (ADR 0050); ${ids}`;
const CHAT_THINKING_NOTE =
  'thinkingConfig budgets are ignored on chat-completions; reasoning: is the lever, compiled to reasoningEffort and sent as reasoning_effort (ADR 0047)';

export const CAPABILITY_MATRIX: Record<MatrixRow, Record<Capability, CapabilityCell>> = {
  gemini: {
    delegation: ok('adk'),
    memory_tools: ok('adk'),
    structured_output: ok('adk'),
    thinking_with_tools: ok('adk'),
    streaming: ok('adk'),
    vision: ok('adk'),
    native_search: nativeSearch('gemini'),
  },
  anthropic: {
    delegation: ok(),
    memory_tools: ok(),
    structured_output: ok(
      'test',
      'output_config.format (json_schema) from Opus 4.8, Sonnet 5 and Haiku 5.5 on; a forced tool call on Claude 4.6 and earlier and Opus 4.7, offered under tool_choice auto when thinking is on (ADR 0049)',
    ),
    thinking_with_tools: ok(
      'test',
      "a thinking budget on Claude 4.6 and earlier, adaptive thinking with output_config.effort after (ADR 0049); signed thinking blocks are replayed verbatim within the turn's tool loop (ADR 0046), and where the model binds them to the conversation (Fable 5.1, Opus 5.5, Sonnet 5.5, Haiku 5.5) under drop_block, so a block whose history changed is dropped rather than rejected; with a budget, a step answering another model's tool call runs without thinking",
    ),
    streaming: ok(),
    vision: ok('test', 'user-turn images only'),
    native_search: nativeSearch('anthropic'),
  },
  openai: {
    delegation: ok(),
    memory_tools: ok(),
    structured_output: ok(),
    thinking_with_tools: ok('test', responsesReasoningNote('reasoning ids only (o-series, gpt-5*)')),
    streaming: ok(),
    vision: ok('test', 'user-turn images only'),
    native_search: nativeSearch('openai'),
  },
  xai: {
    delegation: ok(),
    memory_tools: ok(),
    structured_output: ok(),
    thinking_with_tools: ok('test', responsesReasoningNote('grok-4.5, grok-4.6 and grok-4.7; other grok ids re-reason each step')),
    streaming: ok(),
    vision: ok('test', 'user-turn images only'),
    native_search: nativeSearch('xai'),
  },
  moonshot: {
    delegation: ok(),
    memory_tools: ok(),
    structured_output: ok('test', 'strict json_schema; kimi-k2.6 is documented as unstable on complex schemas ($ref, oneOf)'),
    thinking_with_tools: ok(
      'test',
      "reasoning_content is sent back on the turn's tool-loop assistant messages for the same model (ADR 0046) on kimi-k3, kimi-k2.6 and kimi-k2.7-code; earlier turns' reasoning is not, which K3 and K2.7 Code also ask for; effort travels as reasoning_effort (K3) or a thinking switch (K2.x)",
    ),
    streaming: ok(),
    vision: ok('test', 'user-turn images only, sent as base64 (Moonshot takes no public image URLs)'),
    native_search: unsupported(
      "Moonshot's model-side $web_search retires 2026-10-20 and its successor is a REST call, not a request field; the web_search sentinel is dropped (use web_extract)",
    ),
  },
  ollama: {
    delegation: ok(),
    memory_tools: ok(),
    structured_output: degraded('JSON mode only (json_object): the output is JSON but the schema is not enforced'),
    thinking_with_tools: degraded(CHAT_THINKING_NOTE),
    streaming: ok(),
    vision: ok('test', 'needs a vision model, e.g. ollama/qwen3-vl:8b'),
    native_search: nativeSearch('ollama'),
  },
  gateway: {
    delegation: ok(),
    memory_tools: ok(),
    structured_output: ok('test', 'strict json_schema; upstream support varies by model'),
    thinking_with_tools: degraded(CHAT_THINKING_NOTE),
    streaming: ok(),
    vision: ok('test', 'upstream model must accept images'),
    native_search: unsupported('a gateway cannot enable upstream native search; the web_search sentinel is dropped'),
  },
};

/** The matrix cell for a model on the path it will actually take. */
export function capabilityOf(
  model: string,
  capability: Capability,
  opts: { callerKey?: boolean } = {},
): CapabilityCell & { row: MatrixRow } {
  const plan = planTransport(model, opts);
  const row: MatrixRow = plan.transport === 'gateway' ? 'gateway' : plan.provider;
  if (row !== 'gateway' && row !== 'ollama') {
    const cell = platformCell(row, directPlatform(row), capability);
    if (cell) return { row, ...cell };
  }
  return { row, ...CAPABILITY_MATRIX[row][capability] };
}

/** What one agent's YAML asks of its model. */
export interface AgentNeedsInput {
  tools?: readonly string[];
  outputSchema?: unknown;
  generateContentConfig?: { thinkingConfig?: { thinkingBudget?: number; includeThoughts?: boolean } };
  /** The provider-neutral reasoning key (ADR 0047). */
  reasoning?: ReasoningSetting;
  /** True when this agent delegates to subagents through tools (DELEGATE mode). */
  delegates?: boolean;
}

export function requiredCapabilities(agent: AgentNeedsInput): Capability[] {
  const tools = agent.tools ?? [];
  const needs = new Set<Capability>();
  if (agent.delegates) needs.add('delegation');
  if (tools.includes('load_memory')) needs.add('memory_tools');
  if (agent.outputSchema) needs.add('structured_output');
  const thinking = agent.generateContentConfig?.thinkingConfig;
  const thinks =
    agent.reasoning !== undefined
      ? agent.reasoning !== 'none' && !(typeof agent.reasoning === 'object' && agent.reasoning.budget_tokens === 0)
      : !!thinking && (thinking.thinkingBudget ?? 0) !== 0;
  if (thinks && (tools.length > 0 || agent.delegates)) needs.add('thinking_with_tools');
  if (tools.includes('web_search')) needs.add('native_search');
  return [...needs];
}

export interface CapabilityGap {
  capability: Capability;
  support: Exclude<Support, 'supported'>;
  row: MatrixRow;
  note?: string;
}

/** The capabilities an agent needs that its resolved path does not fully give it. */
export function capabilityGaps(
  model: string,
  agent: AgentNeedsInput,
  opts: { callerKey?: boolean } = {},
): CapabilityGap[] {
  const gaps: CapabilityGap[] = [];
  for (const capability of requiredCapabilities(agent)) {
    const cell = capabilityOf(model, capability, opts);
    if (cell.support === 'supported') continue;
    gaps.push({ capability, support: cell.support, row: cell.row, ...(cell.note ? { note: cell.note } : {}) });
  }
  return gaps;
}

// ── Cloud platforms (ADR 0023) ───────────────────────────────────────────────
//
// On Vertex AI, Bedrock and Azure OpenAI the adapter sends the same request
// as on the provider's own API (the vendor SDK's platform client speaks the
// same dialect), so every cell is the provider's row, except where the
// adapter deliberately sends less: native search, and Claude's URL images
// on Bedrock and Vertex AI, which take base64 images only (ADR 0049).

/** The cell that differs from the provider's row on a platform, or undefined. */
export function platformCell(provider: ProviderId, platform: Platform, capability: Capability): CapabilityCell | undefined {
  if (platform === 'direct') return undefined;
  if (capability === 'vision' && provider === 'anthropic' && !claudeUrlImagesOn(platform)) {
    return degraded(`user-turn images inline (base64) only; an image given by URL is dropped, since ${PLATFORM_LABEL[platform]} takes no URL image source`);
  }
  if (capability !== 'native_search' || nativeSearchOn(provider, platform)) return undefined;
  return unsupported(`not sent on ${PLATFORM_LABEL[platform]}; the web_search sentinel is dropped (use web_extract)`);
}

const PLATFORM_LABEL: Record<Platform, string> = {
  direct: 'the provider API',
  vertex: 'Vertex AI',
  bedrock: 'Bedrock',
  azure: 'Azure OpenAI',
};

const SUPPORT_MARK: Record<Support, string> = { supported: '✓', degraded: '◐', unsupported: '✗' };

/** The matrix as a Markdown table plus notes, for documentation and the doctor. */
export function renderCapabilityMatrix(): string {
  const rows = Object.keys(CAPABILITY_MATRIX) as MatrixRow[];
  const label = (r: MatrixRow) => (r === 'gateway' ? 'Gateway (any id)' : PROVIDERS[r].label);
  const lines: string[] = [];
  lines.push(`| Capability | ${rows.map(label).join(' | ')} |`);
  lines.push(`|---|${rows.map(() => '---').join('|')}|`);
  const notes: string[] = [];
  for (const cap of CAPABILITIES) {
    const cells = rows.map((r) => {
      const cell = CAPABILITY_MATRIX[r][cap];
      if (!cell.note) return SUPPORT_MARK[cell.support];
      notes.push(`${label(r)} · ${CAPABILITY_LABELS[cap]}: ${cell.note}.`);
      return `${SUPPORT_MARK[cell.support]}${notes.length}`;
    });
    lines.push(`| ${CAPABILITY_LABELS[cap]} | ${cells.join(' | ')} |`);
  }
  lines.push('');
  lines.push('✓ supported · ◐ degraded · ✗ unsupported. Gemini cells are ADK\'s own adapter; every other cell is asserted against the request the adapter sends.');
  lines.push('');
  notes.forEach((n, i) => lines.push(`${i + 1}. ${n}`));
  lines.push('');
  lines.push('**Cloud platforms** (ADR 0023): the same adapter and request as the provider\'s own API, except as listed. These paths are tested against mocks, not against the live clouds.');
  lines.push('');
  lines.push('| Path | Differs from the provider row |');
  lines.push('|---|---|');
  for (const provider of Object.keys(PLATFORMS_FOR) as ProviderId[]) {
    for (const platform of PLATFORMS_FOR[provider]) {
      if (platform === 'direct') continue;
      const diffs = CAPABILITIES.map((cap) => [cap, platformCell(provider, platform, cap)] as const)
        .filter(([, cell]) => cell)
        .map(([cap, cell]) => `${CAPABILITY_LABELS[cap]}: ${SUPPORT_MARK[cell!.support]} ${cell!.note ?? ''}`.trim());
      lines.push(`| ${PROVIDERS[provider].label} on ${PLATFORM_LABEL[platform]} | ${diffs.join('; ') || 'nothing'} |`);
    }
  }
  return lines.join('\n');
}
