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
| anything else | Gemini (the ADK-native default) | `GOOGLE_GENAI_API_KEY` (or `GEMINI_API_KEY`) |

The fallback is silent and deliberate: a typo in a `claude-` id does not error,
it becomes a Gemini call. When an agent answers in an unexpected voice, check
the id against this table before reading the prompt. `providerMap.ts` is a
**leaf module** — no imports — keep it dependency-free.

The transport is a second decision (`lib/models/gateway.ts`): a provider's own
adapter whenever its key is present; a configured gateway (`MODEL_GATEWAY`)
only when it is absent.

## The adapters

One per provider (`claudeLlm.ts`, `gptLlm.ts`, `grokLlm.ts`, `ollamaLlm.ts`,
`openAiCompatibleLlm.ts`, `gatewayLlm.ts`), all reaching the tracer through
`traceLlmGeneration`, which is where `max_steps`, cancellation and token
accounting apply. Tool declarations come from `toolDeclarationFor()`
(`schemaNormalize.ts`), never from a tool's private fields. A provider quirk
belongs in its adapter, never at a call site and never in a prompt.

What each provider and transport can do — delegation, structured output, image
parts, thinking with tools — is the capability matrix
(`lib/models/capabilities.ts`, `npm run doctor -- --matrix`, ADR 0019). A
capability that cannot reach parity is stated there before it is promised.

## Traps

- **Ollama's context window** defaults to 4,096 tokens and the `/v1` path
  ignores `num_ctx`: a long prompt is silently truncated. Set the context in
  the Modelfile.
- **ADK and genai are pinned exact** in development because newer minors
  change response part shapes. Bump deliberately: run the boundary suite
  (`tests/syndicateTurn.test.ts`) and one live turn.
- **`@google/adk` is a peer dependency** of the package
  (`package-surface`).

## Cost is a design property

Every routing choice is a spend choice. Before changing a model on a
scheduled agent, say what it does to the run's cost and where that shows up
(the ledger, the task records, budgets — ADR 0026).
