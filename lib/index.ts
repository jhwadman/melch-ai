/**
 * lib/index.ts — the package's main entry (public repo only).
 *
 * This barrel IS the primary API surface of the `melchizedek-agents`
 * package: what it re-exports is covered by semver; everything else is
 * reachable only through the subpath exports declared in package.json.
 * The cloned repo's npm scripts never import this file — they run the
 * modules directly.
 *
 * The run API is plain data in, plain data out: a YAML config and text
 * parts go in, a SyndicateTurnResult comes out. The engine runs every turn
 * on its own agent loop; sessions and memory are its own interfaces
 * (SessionService, MemoryService), and nothing here names Google ADK
 * (ADR 0107).
 */

// ── Load a syndicate ────────────────────────────────────────────────────────
export {
  loadSyndicate,
  loadSyndicateFromRegistry,
  parseCliBindings,
  validateRegistryConfig,
} from './loadSyndicate.ts';
export type {
  AgentYamlConfig,
  LoadSyndicateOptions,
  SubagentYamlConfig,
  SyndicateYamlConfig,
  VariableMap,
} from './loadSyndicate.ts';

// ── Run it ──────────────────────────────────────────────────────────────────
export { runSyndicateTurn, ingestTurnMemory } from './runtime/syndicateTurn.ts';
// The runtime in use: native, the only one since 1.0.0 (ADR 0107).
export { DEFAULT_RUNTIME, describeRuntime, RuntimeRemovedError, UnsupportedOnRuntimeError } from './runtime/syndicateTurn.ts';
export type { RuntimeName, RuntimeSource } from './runtime/syndicateTurn.ts';
// The engine's session and memory interfaces, and the in-process store (ADR 0107).
export { InProcessSessionService } from './runtime/sessions.ts';
export type { Session, SessionKey, SessionService } from './runtime/sessions.ts';
export type { MemoryEntry, MemoryIngestOptions, MemorySearchRequest, MemorySearchResult, MemoryService } from './runtime/memoryService.ts';
export type { TurnEvent } from './runtime/events.ts';
export { approvalResponsePart, pendingApproval, APPROVAL_REQUEST } from './runtime/approvals.ts';
export type { PendingApproval } from './runtime/approvals.ts';
export type {
  DrainedRun,
  MessagePart,
  TurnUsage,
  RouteDecision,
  SyndicateTurnOptions,
  SyndicateTurnResult,
  TraceOptions,
  TurnEvents,
  TurnStage,
} from './runtime/syndicateTurn.ts';
export type { CompileOptions } from './compile.ts';
export { isWorkflowSyndicate, describeInput } from './workflow.ts';
export type { WorkflowConfig, WorkflowNodeYaml, EdgeElement, PendingInput } from './workflow.ts';

// ── Serve it over A2A, or call a remote A2A agent ───────────────────────────
export { createA2AApp, compileAgentCard, currentRequestContext } from './a2a/app.ts';
export type { A2AApp, A2AAppOptions, RequestIdentity } from './a2a/app.ts';
export type { A2AContext } from './a2a/executor.ts';
export {
  callerTokens,
  firstOf,
  hashCallerToken,
  jwtIdentity,
  parseCallers,
  scopeSegment,
  sharedSecret,
  trustedHeader,
} from './a2a/identity.ts';
export type { Authenticator, CallerEntry, IdentityScheme, JwtIdentityOptions } from './a2a/identity.ts';
export { budgets, memoryUsageStore, parseBudgets, postgresUsageStore, supabaseUsageStore } from './a2a/policy.ts';
export type { BudgetConfig, BudgetLimits, DailyUsage, Policy, PolicyDecision, PolicySubject, UsageStore } from './a2a/policy.ts';
export { createMetrics } from './observability/metrics.ts';
export type { Metrics, TaskRecord } from './observability/metrics.ts';
export { patternRedactor, redactRow, setTelemetryRedactor, telemetryRedactor } from './observability/redact.ts';
export type { Redactor } from './observability/redact.ts';
export { RemoteA2AAgent, remoteAgentTool } from './a2a/remoteAgent.ts';
export type { RemoteAnswer } from './a2a/remoteAgent.ts';

// ── Extend it ───────────────────────────────────────────────────────────────
export { resolveTools, registerTool, registeredToolNames } from './toolRegistry.ts';
export { registerGuard, resolveGuards } from './guards/index.ts';
export type { Guard, GuardResult } from './guards/index.ts';
export { defineTool } from './tools/toolContract.ts';
export type { Tool, ToolContext } from './tools/tool.ts';

// ── Memory ──────────────────────────────────────────────────────────────────
export {
  modelExtractor,
  geminiEmbedder,
  openAiCompatibleEmbedder,
  memoryProvidersFromEnv,
} from './memory/providers.ts';
export type { Embedder, MemoryExtractor } from './memory/providers.ts';
export { eraseScope } from './memory/erase.ts';
export type { EraseCounts } from './memory/erase.ts';
export { namespacedMemoryService } from './memory/namespace.ts';

// ── Storage (ADR 0021) ──────────────────────────────────────────────────────
export { postgresStorage, PostgresSessionService, PostgresTaskStore } from './storage/postgres/index.ts';
export type { PostgresStorage, PostgresStorageOptions } from './storage/postgres/index.ts';
export type { MemoryStore } from './memory/store.ts';

// ── Validation ──────────────────────────────────────────────────────────────
export { validateSyndicateConfig, syndicateJsonSchema, SyndicateValidationError } from './syndicateSchema.ts';

// ── Models ──────────────────────────────────────────────────────────────────
export {
  PROVIDERS,
  providerForModel,
  providerKeyPresent,
  providerStatuses,
  logProviderStatuses,
  resolveModel,
  // Listed as root exports in the 0.12.0 changelog but shipped only as a
  // subpath until 0.16.0.
  describeCapabilities,
  capabilitySummary,
  planTransport,
  gatewayConfig,
  gatewayProblem,
  gatewayUsable,
  GATEWAYS,
} from './models/registry.ts';

export { loadEnv } from './loadEnv.ts';
