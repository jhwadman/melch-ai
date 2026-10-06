/**
 * lib/config.ts — Framework-level configuration constants.
 *
 * WHY this file exists:
 *   Previously, model identifiers were hardcoded inside individual service
 *   files, making them invisible to contributors and impossible to change
 *   without hunting through source.
 *
 *   Centralising them here creates a single, obvious place to:
 *     1. Swap the default inference model used by the A2A server
 *     2. Change summary/extraction model without touching service logic
 *     3. Understand the full set of third-party model dependencies at a glance
 *
 *   These are intentionally plain constants — not env vars — because model
 *   IDs are code decisions, not deployment secrets. If you want env-var
 *   overrides, wrap the const: `process.env.GEMINI_MODEL ?? DEFAULT_GEMINI_MODEL`.
 */

// ── Inference Models ──────────────────────────────────────────────────────────

/**
 * Default Gemini model used by the A2A server when no model is specified
 * in the caller's YAML or request.
 *
 * Use gemini-3.5-flash-lite for lightweight/cost-efficient loads (subagents,
 * data retrieval). Use gemini-3.8-flash in YAML for production orchestrators.
 *
 * NOTE: gemini-2.5-flash is known incompatible with this framework's
 * includeServerSideToolInvocations flag on AI Studio Tier 1 — do not use it
 * as the default. See DOCUMENTATION.md §7.0 for the full compatibility table.
 *
 * Supported Gemini identifiers: https://ai.google.dev/gemini-api/docs/models
 */
export const DEFAULT_GEMINI_MODEL = 'gemini-3.5-flash-lite';

/**
 * Default Claude model used by the A2A server when a claude-* model is
 * requested but no specific identifier is provided.
 *
 * Requires ANTHROPIC_API_KEY to be set. The ClaudeLlm provider in
 * lib/models/claudeLlm.ts handles routing automatically via LLMRegistry.
 */
export const DEFAULT_CLAUDE_MODEL = 'claude-sonnet-4-6';

/**
 * Default OpenAI model used when a gpt-* model is requested but no specific
 * identifier is provided. Requires OPENAI_API_KEY. gpt-5-mini is the
 * lightweight reasoning tier — enough for subagent work, and it exposes
 * reasoning summaries via the Responses API (lib/models/gptLlm.ts).
 */
export const DEFAULT_GPT_MODEL = 'gpt-5-mini';

/**
 * Default xAI model used when a grok-* model is requested but no specific
 * identifier is provided. Requires XAI_API_KEY (lib/models/grokLlm.ts).
 * grok-4.7 is a reasoning model (reasoning cannot be disabled); it returns
 * reasoning summaries, which the adapter surfaces as thinking.
 */
export const DEFAULT_GROK_MODEL = 'grok-4.7';

/**
 * Reasoning effort sent with grok-4.5/4.7 requests: 'low' | 'medium' | 'high'
 * (xAI's own default is 'high'; 4.7 adds 'xhigh'). Pinned to MEDIUM — deeper
 * than low without high's latency and token cost. Source: docs.x.ai › Model
 * capabilities › Text › Reasoning › Effort levels. Older grok ids don't
 * accept the param and never receive it (lib/models/grokLlm.ts).
 */
export const DEFAULT_GROK_REASONING_EFFORT = 'medium';

/**
 * Default Moonshot model used when a kimi-* model is requested but no
 * specific identifier is provided. Requires MOONSHOT_API_KEY
 * (lib/models/kimiLlm.ts). kimi-k3 is the flagship, priced like a mid-tier
 * closed model ($3 / $15, Claude Sonnet 4.6's price; Sonnet 5.5 is cheaper);
 * kimi-k2.6 is the general tier at a quarter of that (the family table and
 * the cost note are in the adapter's header).
 */
export const DEFAULT_KIMI_MODEL = 'kimi-k3';

/**
 * Reasoning effort sent with kimi-k3 requests: 'low' | 'high' | 'max'
 * (Moonshot's own default is 'max'; K3 always thinks and has no off switch).
 * Pinned to HIGH — one step below max, which is the benchmark setting and
 * the slowest; an agent sets generateContentConfig.reasoningEffort to
 * override. Source: platform.moonshot.ai › Guides › Reasoning effort.
 */
export const DEFAULT_KIMI_REASONING_EFFORT = 'high';

/**
 * Model calls one turn may make, subagents included, when the syndicate sets
 * no `max_steps`. A runaway tool loop stops here instead of at the provider's
 * bill. Every shipped example that sets a cap sets 12 to 30; a syndicate that
 * needs more raises its own `max_steps` (ADR 0039).
 */
export const DEFAULT_MAX_STEPS = 50;

/**
 * Default open-weight model, served locally by Ollama (lib/models/ollamaLlm.ts).
 * qwen3:8b is the smallest pulled model that supports tool calling — the
 * floor capability for syndicate delegation. Vision work uses ollama/qwen3-vl:8b.
 */
export const DEFAULT_OLLAMA_MODEL = 'ollama/qwen3:8b';

/**
 * Model used by SupabaseVectorMemoryService to extract discrete facts
 * from a session transcript before embedding them.
 *
 * Must be a text generation model (not an embedding model).
 */
export const MEMORY_EXTRACTION_MODEL = 'gemini-3.8-flash';

/**
 * Default model for wiki agent operations (wiki_query, wiki_garden, and the
 * gap-fill pass in lib/wiki/fill.ts). Prose quality matters more than
 * latency here, so this sits one tier above the subagent default. Any
 * provider works — override per call or via WIKI_AGENT_MODEL env
 * ('claude-*', 'ollama/*', …); routing goes through lib/models/registry.ts.
 */
export const WIKI_AGENT_MODEL = 'gemini-3.8-flash';

// ── Embedding Models ──────────────────────────────────────────────────────────

/**
 * Model used by SupabaseVectorMemoryService to produce vector embeddings
 * for semantic memory storage and retrieval.
 *
 * ⚠ IMPORTANT CONSTRAINT: The output dimensionality set below MUST match the
 * dimensionality of the Supabase pgvector index you have provisioned. The index
 * is created once and cannot be resized. The default (768) fits within
 * Supabase's free-tier limits and is compatible with the match_memory_facts
 * RPC defined in the database schema.
 *
 * If you switch embedding models, you must:
 *   1. Update EMBEDDING_MODEL to the new model identifier.
 *   2. Update EMBEDDING_DIMENSIONS to match the new model's output.
 *   3. Drop and recreate your adk_memory_facts table and ivfflat index.
 *   4. Re-ingest all existing facts (old vectors are dimensionally incompatible).
 *
 * Gemini options:
 *   'gemini-embedding-001'  → supports outputDimensionality up to 3072
 *   'text-embedding-004'    → supports outputDimensionality up to 768
 */
export const EMBEDDING_MODEL = 'gemini-embedding-001';

/**
 * Output dimensionality for the embedding model.
 * Must match the Supabase pgvector index dimension. Default: 768.
 */
export const EMBEDDING_DIMENSIONS = 768;
