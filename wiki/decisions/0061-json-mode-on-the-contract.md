---
type: decision
title: "ADR 0061: JSON mode without a schema is a contract field, outputFormat: 'json'"
description: "ModelRequest gains outputFormat: 'json', the provider's JSON mode with no schema. The genai mapping reads it from responseMimeType: application/json without a schema and writes it back. GPT and Grok send text.format json_object, the chat-completions adapters response_format json_object, Gemini responseMimeType alone; Claude, which has no JSON mode, sends nothing, as its ADK path never did. The chat shims stop carrying JSON mode as olderSpelling. An empty outputSchema, a wider responseFormat union, a MIME-type field and keeping JSON mode on the ADK path only were rejected."
tags:
  - decision
  - models
  - contracts
status: stable
generated:
  by: claude-code/claude-opus-5-5
  at: 2026-10-07
sources:
  - resource: lib/models/contract.ts
  - resource: lib/models/genaiMapping.ts
  - resource: lib/models/gptAdapter.ts
  - resource: lib/models/chatCompletionsAdapter.ts
  - resource: lib/models/openAiCompatibleLlm.ts
  - resource: lib/models/geminiAdapter.ts
  - resource: lib/models/claudeAdapter.ts
  - resource: tests/genaiMapping.test.ts
  - resource: tests/responsesAdapter.test.ts
  - resource: tests/chatCompletionsAdapter.test.ts
---

# ADR 0061: JSON mode without a schema is a contract field, outputFormat: 'json'

## Context

The author skill teaches `generateContentConfig.responseMimeType: "application/json"`, and agents use it to get an answer that parses without a schema (the dispatch orchestrator among them). The [model contract](/models/model-contract.md) ([ADR 0048](/decisions/0048-engine-owned-model-contract.md)) had no field for it, so the genai mapping dropped it:

- GPT and Grok, once they ran as contract adapters behind the shim ([ADR 0056](/decisions/0056-responses-usage-meaning-on-the-adk-path.md)), stopped sending `text.format: { type: 'json_object' }` on the ADK path.
- The chat-completions shims kept it as part of the older spelling ([ADR 0057](/decisions/0057-chat-completions-shims-keep-the-adk-shape.md)), which only the ADK path sets.
- The native runtime, which builds a `ModelRequest` from the agent with no LlmRequest in between, could not ask for it on any provider.

Every provider but one has a JSON mode with no schema: OpenAI's and xAI's Responses `text.format: { type: 'json_object' }`, the chat-completions `response_format: { type: 'json_object' }` (Moonshot, Ollama and the gateways), and Gemini's `responseMimeType: 'application/json'` alone. Anthropic's Messages API has none.

## Decision

1. **`ModelRequest.outputFormat?: 'json'`.** It asks for one JSON object as the answer, with no schema to hold it to. The answer arrives as the final response's text. `outputSchema` says more and wins when both are set. Absent means plain text.
2. **The genai mapping carries it both ways.** `llmRequestToModelRequest` sets it when `responseMimeType` is `application/json` and neither `responseJsonSchema` nor `responseSchema` is given. `modelRequestToLlmRequest` writes `responseMimeType: 'application/json'` for it when there is no `outputSchema`. Beside a schema it reads back as the schema alone.
3. **Each adapter sends its provider's JSON mode.** `GptAdapter` and `GrokAdapter`: `text.format: { type: 'json_object' }`. `ChatCompletionsAdapter` (Ollama, Kimi, the gateway): `response_format: { type: 'json_object' }`, kept on Ollama's retry without thinking. `GeminiAdapter`, and `AdkGeminiAdapter` through the mapping: `responseMimeType: 'application/json'` alone.
4. **Claude sends nothing for it.** `ClaudeLlm` never sent anything for `responseMimeType` alone, and the Messages API has no JSON mode, so `ClaudeAdapter` leaves the body as it is. A prefilled `{` or a forced tool would change the answer's shape and its finish, which is more than an agent asked for. The prompt asks for the JSON.
5. **The chat shims stop carrying it beside the contract.** `OlderSpelling` keeps only the effort word that is no level. `olderSpellingOf` no longer reads `responseMimeType`.

So on the ADK path GPT and Grok send what they sent before they moved onto the contract, the chat-completions and Gemini bodies are unchanged, and the native runtime gets JSON mode on every provider that has one.

## Alternatives considered

- **An empty `outputSchema` (`{}` or `{ type: 'object' }`) for JSON mode.** It reuses a field but changes its meaning: an adapter that enforces schemas would send a strict `json_schema` whose strict form (no properties, `additionalProperties: false`) holds the answer to `{}`, and Claude would build a `structured_output` tool around it. Every adapter would need a special case for the empty schema, and a schema an author left empty by mistake would silently become JSON mode.
- **A wider union, `outputFormat: 'text' | 'json' | { schema }`, replacing `outputSchema`.** One field for the answer's shape reads well, but it renames a field every adapter and the mapping already read, for no behaviour gained. `'text'` would say only what absence says.
- **A MIME-type field (`responseMimeType: string`).** That is Gemini's vocabulary, and the contract's job is to not be Gemini's wire ([ADR 0048](/decisions/0048-engine-owned-model-contract.md)). Gemini's other MIME types (`text/x.enum`) have no counterpart elsewhere.
- **Keep JSON mode on the ADK path only, as the older spelling** for every shim, as ADR 0057 does for the chat shims. It fixes GPT and Grok today but leaves the native runtime without it, and it is the one setting the author skill teaches, not an older spelling.
- **Emulate JSON mode on Claude** with a prefilled `{` or a forced tool. Both change the request beyond what the ADK path sent, and a prefill does not combine with extended thinking.

## Consequences

- An agent with `responseMimeType: application/json` and no schema sends JSON mode to GPT, Grok, Kimi, Ollama, the gateway and Gemini, on the ADK runtime and on the contract. `tests/responsesAdapter.test.ts`, `tests/chatCompletionsAdapter.test.ts`, `tests/geminiAdapter.test.ts`, `tests/adkGeminiAdapter.test.ts` and `tests/claudeAdapter.test.ts` assert the wire bodies; `tests/genaiMapping.test.ts` the mapping both ways.
- `OlderSpelling.jsonMode` is gone. It was added in the same unreleased version, so no released consumer reads it.
- The fields the contract leaves out are now `topK`, `seed`, the penalties, `candidateCount`, `safetySettings`, `includeThoughts`, and the effort words `xhigh` and `max` (ADR 0048's list, less JSON mode).
- The capability matrix has no JSON-mode column. A provider's support follows from this ADR's table; a column joins the matrix when an agent can ask for JSON mode on a provider without one, which today is only Claude, where the prompt carries it.
