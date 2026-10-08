---
type: decision
title: "ADR 0096: Ollama structured output sends the schema as json_schema"
description: "An output schema on an ollama/ model goes as response_format json_schema, the schema in its strict form, as on Kimi and the gateway; JSON mode without a schema stays json_object. Ollama 0.5.0 (December 2024) is the minimum: it enforces the schema with grammar-constrained decoding, and an older server ignores json_schema without an error. No version probe and no json_object fallback: 0.5.0 is the documented floor. A probe with a clear error, a probe with a fallback, and keeping json_object were rejected."
tags:
  - decision
  - models
  - contracts
status: stable
generated:
  by: claude-code/claude-opus-5-5
  at: 2026-10-08
sources:
  - resource: lib/models/ollamaAdapter.ts
  - resource: lib/models/chatCompletionsAdapter.ts
  - resource: lib/models/capabilities.ts
  - resource: tests/chatCompletionsAdapter.test.ts
  - resource: tests/doctor.test.ts
---

# ADR 0096: Ollama structured output sends the schema as json_schema

## Context

`OllamaAdapter` sent an agent's `outputSchema` as `response_format: { type: 'json_object' }`, because its header said the OpenAI-compatible `/v1` endpoint takes no `json_schema`. JSON mode makes the answer JSON but does not hold it to the schema, so the capability matrix ([ADR 0019](/decisions/0019-multi-model-parity-matrix.md)) marked Ollama's structured output degraded. The live parity run of 2026-10-08 failed only that check under both runtimes: a required field was missing from the answer.

The premise is out of date. Ollama 0.5.0 (December 2024) added structured outputs, and its `/v1` translation (`openai/openai.go`, `fromChatRequest`) reads `response_format: { type: 'json_schema', json_schema: { schema } }` and passes the schema to the native `format` field, which constrains decoding with a grammar. A live check against Ollama 0.31.1 (qwen3:8b, a two-field schema with an enum) returned JSON that followed the schema. `strict` and `name` are accepted and ignored.

Before 0.5.0 the same translation reads only `json_object`. A `json_schema` request is not rejected: the type is ignored, no format is set, and the model answers in free text. Ollama Cloud is reported to accept `json_schema` without enforcing it.

## Decision

1. **A schema goes as strict `json_schema` on every chat-completions provider.** `ChatCompletionsAdapter` sends `response_format: { type: 'json_schema', json_schema: { name: 'response', strict: true, schema: toStrictJsonSchema(outputSchema) } }` for Ollama exactly as for Kimi and the gateway. The per-provider switch that let Ollama send `json_object` instead (`supportsJsonSchemaFormat`) is gone, since no provider needs it.
2. **JSON mode without a schema stays `json_object`** ([ADR 0061](/decisions/0061-json-mode-on-the-contract.md)), and a schema beside `outputFormat: 'json'` still wins.
3. **Tools travel beside a schema**, as on the other two; the retry without thinking keeps the schema.
4. **Ollama 0.5.0 is the minimum for structured output, documented and not probed.** The adapter makes no version call and has no fallback. The header of `ollamaAdapter.ts`, the capability matrix's Ollama cell and the chat-completions page name the floor and say what an older server and Ollama Cloud do.
5. **The capability matrix marks Ollama's structured output supported**, with the note that it is enforced from 0.5.0 and not on Ollama Cloud.

## Alternatives considered

- **A clear error naming the minimum version.** An older server does not reject `json_schema`, so there is no error response to translate. Producing one means calling `/api/version` first: a second endpoint outside `/v1` (which `OLLAMA_BASE_URL` names, and which a proxy in front of Ollama may not route), a cached result per base URL, and a call on the first turn of every process for a server line that is nearly two years old. The cost falls on every current install to serve the rare old one.
- **A fallback to `json_object` on an older server.** It needs the same probe, and it restores the behaviour this record removes: JSON that silently does not follow the schema. An agent that declared a schema is better served by an answer that visibly fails its parse than by one that parses and is wrong.
- **Keep `json_object`.** It is what failed the parity check. With a two-year-old server floor there is no install the change would break that the probe alternatives would save.

## Consequences

- An `ollama/` agent with an `outputSchema` gets an answer held to the schema on Ollama 0.5.0 and later, on the ADK runtime and on native, since both run the same adapter. The `ollama` structured-output cell is supported; an Ollama agent with a schema no longer shows a structured-output gap in the doctor.
- On a server older than 0.5.0 the answer is free text, which the agent's output-schema handling sees as not matching. On Ollama Cloud it may not follow the schema. Both are stated where the floor is.
- `tests/chatCompletionsAdapter.test.ts` asserts the request bodies: the strict schema on all three providers, the same normalisation on Ollama as on Kimi, a schema over JSON mode, tools beside a schema, the retry, and `json_object` for JSON mode alone. `tests/doctor.test.ts` no longer expects a structured-output gap on Ollama. `tests/capabilityMatrix.test.ts` derives the cell from the body and agrees with the table.
- If an old server ever matters, a version check belongs in the doctor, which runs once before any turn, rather than on the turn path. The doctor makes no network call today, so that would be a new step for it.
