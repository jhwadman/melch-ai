---
type: decision
title: 'ADR 0027: A chat-completions turn that thinks but never answers is a named error'
description: When an OpenAI-compatible provider (Ollama, a gateway) ends a turn with reasoning but no reply and no tool call, the adapter yields <PROVIDER>_MAX_TOKENS (finish_reason length) or <PROVIDER>_EMPTY_RESPONSE instead of an empty final; an unclosed <think> block is scratchpad; the model zoo's local agent runs with thinking off.
tags:
  - decision
  - models
status: stable
generated:
  by: claude-code/claude-opus-5-5
  at: 2026-10-01
sources:
  - resource: lib/models/openAiCompatibleLlm.ts
  - resource: lib/models/ollamaLlm.ts
  - resource: config/agents/examples/model_zoo.yaml
  - resource: tests/models.test.ts
---

# ADR 0027: A chat-completions turn that thinks but never answers is a named error

## Context

`npm run demo:models` showed the local agent (`ollama/qwen3.5:9b`) printing its thinking, then an empty OUTPUT, with a trace of about 3,700 output tokens and three minutes of wall time. ADK logged "The last event is partial, which is not expected."

**What happened on the wire.** Ollama answered `finish_reason: "length"`, `content: ""`, and 18,000 characters in `reasoning`, with `total_tokens` exactly 4,096. A qwen3.5 model thinks before it answers, and on the explainer prompt it drafts and recounts its words until the scratchpad fills Ollama's default 4,096-token context window. The reply never starts. Ollama's OpenAI-compatible `/v1` endpoint ignores `num_ctx` and the whole `options` object, so the adapter cannot raise the window per request. It also ignores `think: false`. Of the `reasoning_effort` values, only `"none"` changes anything, and it turns thinking off.

**What the adapter did with it.** It ignored `finish_reason` and yielded a final response with empty `parts`. ADK drops a final with no parts and no `errorCode`, so the last event left was the thought partial. The turn ended with empty text and no reason, while the tracer still counted the tokens.

## Decision

1. **The chat-completions base reads `finish_reason`** on both the JSON and SSE paths, and records it on the `llm.request` span as `llm.finish_reason`.
2. **No reply after reasoning is an error, never an empty final.** When a turn produced reasoning or hit `length`, and has neither reply text nor a tool call, the final response is `<PROVIDER>_MAX_TOKENS` (for `length`) or `<PROVIDER>_EMPTY_RESPONSE` (the model stopped after thinking). The error carries the turn's usage. A subclass words it through `noAnswerError()`. Ollama's version names the context window and both remedies: `reasoningEffort: "none"`, or a larger window set in a Modelfile or `OLLAMA_CONTEXT_LENGTH`.
3. **A bare empty turn is untouched.** With no reasoning and no truncation (for example, a model with nothing to add after a tool result), the empty final passes through as before, because ADK already handles that shape.
4. **A reply that started keeps its text.** When the reply is cut off by `length`, the final carries the text and `finishReason: MAX_TOKENS`.
5. **An unclosed `<think>` is scratchpad.** `splitThinkBlocks` treats everything after an opening tag that never closed as reasoning, as the streaming `ThinkStreamSplitter` already did.
6. **The model zoo's `qwen_local` runs with `reasoningEffort: "none"`.** With a 32,768-token window, the same prompt still had no answer after five minutes. Turning thinking off gives an answer in about 15 seconds.

## Alternatives considered

- **Return the reasoning as the answer.** This puts a half-finished scratchpad into session history as if it were the reply, and it is the text the scratchpad split exists to keep out.
- **Raise the context per request.** `/v1` ignores `num_ctx`. Moving Ollama to its native `/api/chat` would honour `options.num_ctx` but would fork the shared chat-completions translation that the gateways also use. A bigger window alone also did not produce an answer in useful time on this prompt.
- **Set `reasoning_effort` by default in the Ollama adapter.** That would silently change every Ollama agent, including those whose prompts leave room to think. The choice belongs in each agent's YAML.
- **Error on every empty final.** That would turn a shape ADK handles (an empty step after a tool call) into a failure.

## Consequences

- A thinking agent that runs out of room now fails visibly, with a code a caller can branch on and a message that says what to change, instead of returning empty text.
- The zoo demo no longer prints Ollama's thinking. The other four providers still show theirs.
- A non-streaming Ollama call that thinks for more than 300 seconds still hits Node's fetch headers timeout and is reported as `OLLAMA_UNREACHABLE`. The streaming path is not affected.
