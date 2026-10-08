---
name: model-routing
description: How a model id in a YAML becomes a provider call — the prefix table, the gateway fallback, the adapters, the capability matrix, and cost as a design property. Use when changing a model id, adding a provider, or when an agent answers in an unexpected voice.
---

# Model routing

**A model id in a YAML is the whole routing decision.**
`lib/models/providerMap.ts` maps it:

| id shape | provider | key env |
|---|---|---|
| `ollama/<model>` | Ollama (local) | none — keyless |
| `claude-*` | Anthropic | `ANTHROPIC_API_KEY` |
| `gpt-*`, `o<digit>*` | OpenAI | `OPENAI_API_KEY` |
| `grok-*` | xAI | `XAI_API_KEY` |
| `kimi-*` | Moonshot AI (Kimi) | `MOONSHOT_API_KEY` |
| anything else | Gemini (the default) | `GOOGLE_GENAI_API_KEY` (or `GEMINI_API_KEY`) |

The fallback is silent and deliberate: a typo in a `claude-` id does not error,
it becomes a Gemini call. When an agent answers in an unexpected voice, check
the id against this table before reading the prompt. `providerMap.ts` is a
**leaf module** — no imports — keep it dependency-free.

The transport is a second decision (`lib/models/gateway.ts`): a provider's own
adapter whenever its key is present; a configured gateway (`MODEL_GATEWAY`)
only when it is absent.

`resolveAdapter` (`lib/models/adapterResolver.ts`) turns the id into its
provider's adapter over that prefix table, with the gateway rule, BYOK key
scoping and the cloud endpoints; `lib/models/registry.ts` re-exports it beside
`resolveModel` (the BYOK path, returning the same `ModelAdapter`),
`providerStatuses` and `logProviderStatuses`, which reports and logs which
providers have a key and registers nothing. There is no model registry to
populate: the id is resolved at compile time, per agent.

## The adapters

One `ModelAdapter` per provider on the engine's model contract
(`lib/models/contract.ts`): `claudeAdapter.ts`, `gptAdapter.ts`,
`grokAdapter.ts`, `geminiAdapter.ts` (on `@google/genai`), and the
chat-completions three, `kimiAdapter.ts`, `ollamaAdapter.ts` and
`gatewayAdapter.ts` on `chatCompletionsAdapter.ts`. `fallbackAdapter.ts`
wraps an agent's `model` and `fallback_model`. The native loop calls the
adapter directly, and that call is where `max_steps`, cancellation, the
`llm.request` span and token accounting apply (ADR 0053, ADR 0057). Tool
declarations come from `contractToolDeclaration()` (`schemaNormalize.ts`),
never from a tool's private fields. A provider quirk belongs in its adapter, never at a call site
and never in a prompt.

What each provider and transport can do — delegation, structured output, image
parts, thinking with tools — is the capability matrix
(`lib/models/capabilities.ts`, `npm run doctor -- --matrix`, ADR 0019). A
capability that cannot reach parity is stated there before it is promised.

## Traps

- **Ollama's context window** defaults to 4,096 tokens and the `/v1` path
  ignores `num_ctx`: a long prompt is silently truncated. Set the context in
  the Modelfile.
- **`@google/genai` is pinned exact** because newer minors change response
  part shapes. Bump deliberately: run the boundary suite
  (`tests/syndicateTurn.test.ts`) and one live Gemini turn.
- **The package has no Google ADK dependency** since 1.0.0; `@google/genai`
  is reached only by the Gemini adapter, the image tools and memory
  embeddings (`package-surface`).

## Cost is a design property

Every routing choice is a spend choice. Before changing a model on a
scheduled agent, say what it does to the run's cost and where that shows up
(the ledger, the task records, budgets — ADR 0026). Read the list price
against the closed tiers before calling an open model cheap: `kimi-k3` costs
what Claude Sonnet 4.6 costs and thinks on every turn, billed as output
(ADR 0035); `kimi-k2.6` is its budget tier. A reasoning model's default
effort is part of its price — pin it in the adapter, as the Grok and Kimi
adapters do.
