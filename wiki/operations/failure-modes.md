---
type: runbook
title: Failure modes
description: The named errors newcomers actually hit — model-tier 503s, the gemini-2.5-flash tool-context 400, stale-orchestrator synthesis, the two A2A auth rejections, a thinking model that fills Ollama's context window, an ADK-only path without the optional @google/adk peer or a feature one runtime refuses, and a turn that fails on malformed or forged input (an approval answer that does not bind, a response to a call no agent made, a nested syndicate that reaches itself) — with their fixes.
tags:
  - operations
  - troubleshooting
generated:
  by: claude-code/claude-opus-5-5
  at: 2026-10-08
sources:
  - resource: QUICKSTART.md
    title: 'Common first-run errors'
  - resource: lib/config.ts
  - resource: lib/models/retry.ts
  - resource: lib/models/chatCompletionsAdapter.ts
  - resource: lib/models/ollamaAdapter.ts
  - resource: lib/a2a/app.ts
  - resource: lib/a2a/executor.ts
  - resource: lib/runtime/native/interrupts.ts
  - resource: lib/compile.ts
  - resource: lib/adkPeer.ts
  - resource: lib/runtime/runtimeFlag.ts
---

# Failure modes

## `503 ServiceUnavailable` on inference

The model id doesn't exist on the AI Studio endpoint or the account tier lacks access. Use `gemini-3.8-flash` or `gemini-3.5-flash-lite`; identifiers are case-sensitive and must match the AI Studio model list exactly. A 503 whose message says "high demand" on a VALID model id is different: Google's capacity spike, transient — and the framework retries it for you. Every provider gets the same policy (`lib/models/retry.ts`): 3 attempts in total (`MODEL_RETRY_MAX_ATTEMPTS`, 1 disables), full-jitter backoff from 500 ms to an 8 s ceiling, on 408/409/425/429/500/502/503/504 and connection resets — never on any other 4xx, and never on a refused connection (a stopped Ollama is reported at once). A `Retry-After` (or Gemini's `retryDelay`) is waited out up to 60 s; longer than that means a quota waiting won't fix, so the call fails immediately. A cancel or deadline wakes the backoff and stops the retries, and nothing is retried once the reply has started streaming, so a retry never repeats text. Gemini and the chat-completions path (Ollama, gateways) use the shared helper; Claude and GPT/Grok keep their SDKs' equivalent two retries. Each `llm.request` span records `llm.retries` and `llm.http_status`, so a ledger row shows whether a turn survived a 503 or died of one. If a 503 still surfaces after all that, the spike outlasted every attempt: retry later.

A failed turn's reason reaches the caller: the [A2A server](/protocols/a2a.md) publishes the failed task with a status message of the form `Error: [<code>] The agent run failed — <reason>`, built by `describeFailedTurn` and `describeTurnError` in `lib/a2a/executor.ts` (the upstream provider message, JSON ApiError blobs unwrapped, capped at 300 characters), so a client can show the cause verbatim.

## `400` — "tool call context circulation not enabled"

`gemini-2.5-flash` is incompatible with this framework's `includeServerSideToolInvocations: true` on standard AI Studio Tier 1 — which is why it must never be a default model (noted at the constant in `lib/config.ts`). Fix: `model: "gemini-3.8-flash"` in the YAML.

## Orchestrator ignores subagent output / returns stale data

Prompt engineering, not a framework bug: the orchestrator answered from prior context instead of waiting. Mandate in its instruction that it must call subagents and wait for their responses before synthesizing — and end each subagent instruction with a mandatory "return a final text summary to the orchestrator" clause. The deeper design rationale is the isolation argument in [architecture](/overview/architecture.md).

## `Unauthorized: Missing X-API-Key header`

The [A2A server](/protocols/a2a.md) is in BYOK mode (`A2A_KEY_MODE=byok`), where every task request carries the caller's model key. In the default server mode the header is not used; a server that warns "A caller sent X-API-Key" is telling a BYOK client it is talking to a server-mode deployment.

## `Unauthorized: Missing or invalid Authorization Bearer token`

The request carries no bearer, or one the configured `A2A_AUTH` does not accept: the server secret, this caller's token from `A2A_CALLERS` (stored as its SHA-256, so compare hashes, not tokens), or a JWT whose issuer, audience or expiry fails. A refused JWT logs its reason as `resolveRequest refused …`. Send `Authorization: Bearer <credential>`. A server with no credential configured has authentication off and binds `127.0.0.1` only. Thirty failed attempts from one IP in 15 minutes block that IP for the window (`A2A_AUTH_FAILURE_MAX`).

## `STEP_LIMIT`, `DEADLINE_EXCEEDED`, `CANCELED`

A turn stopped by its controls: the YAML's `max_steps` counts model calls across every agent the turn reaches, `A2A_TASK_TIMEOUT_MS` bounds wall-clock time, and `tasks/cancel` stops it. The provider call in flight is aborted, not left running.

## `AdkNotInstalledError` / `UnsupportedOnRuntimeError`

`<feature> needs @google/adk, which is not installed`: something asked for an ADK-only path in a process without the optional `@google/adk` peer ([ADR 0102](/decisions/0102-native-default-and-optional-adk-peer.md)) — the `adk` runtime (`MELCHIZEDEK_RUNTIME=adk` or a turn's `runtime: 'adk'`), `compileGraph`/`compileSubagent`, `compileWorkflow`, the retry plugins or `GEMINI_ADAPTER=adk`. It fails before any model call. Fix: unset `MELCHIZEDEK_RUNTIME` (or set it to `native`, the default), or install `@google/adk@~2.2.0` beside the package. The `adk` runtime and the peer leave at 1.0.0.

`<where>: <feature> is not supported on the <runtime> runtime yet`: a feature that runtime refuses, also before any model call ([native loop](/overview/native-loop.md#the-runtime-flag)). Native refuses a caller's `transformAgent`, an `ask_user` tool on a workflow node's agent (use an `ask_user` node), and an ADK model class from `resolveModel` with no contract adapter behind it (wrap the adapter in `adkShim`). The `adk` runtime refuses approval gates on workflow nodes and resuming an OAuth consent. The message names the other runtime to run it on.

## `Unknown agent '<id>'` (404) and `is unavailable` (503)

A bare id must be a file in the agents directory; examples and templates answer only ids in `A2A_SERVED_AGENTS`, and registry ids need `registry:<id>` or `A2A_REGISTRY_AGENTS`. A 503 means the agent exists but its config is invalid or the registry is unreachable — the server log names which.

## `GATEWAY_HTTP_ERROR` / `GATEWAY_KEY_MISSING` / `GATEWAY_NOT_CONFIGURED`

Only seen when `MODEL_GATEWAY` is set ([provider routing](/models/provider-routing.md)). `GATEWAY_KEY_MISSING`: the gateway is named but `MODEL_GATEWAY_API_KEY` is not set — the registry log says so at startup and the doctor marks every uncovered provider blocked. `GATEWAY_NOT_CONFIGURED`: the value is not `vercel` or `openrouter`. `GATEWAY_HTTP_ERROR` with a 400 or 404 is almost always the wire name — the gateway's id for the model differs from the mapper's guess; fix it once with `MODEL_GATEWAY_MODEL_MAP=<yaml id>=<gateway id>`. A gateway path never carries native search: an agent declaring `web_search` on it runs without search, and that is reported (`capability ·` line at compile time, `llm.capability.dropped` on the span), not a fault.

## `OLLAMA_MAX_TOKENS` / `<PROVIDER>_EMPTY_RESPONSE` — thinking, but no answer

A thinking model (the qwen3 and qwen3.5 families) writes its scratchpad first, and the scratchpad shares the context window with the prompt. Ollama loads a model with a 4,096-token window unless the Modelfile says otherwise, and its OpenAI-compatible `/v1` endpoint — the one the adapter uses — ignores `num_ctx` and the `options` object entirely. On a constraint-dense prompt such as the model zoo's explainer, `qwen3.5:9b` can think for 3,700+ tokens, fill the window and stop with `finish_reason: "length"` before the reply starts. The chat-completions adapter (`lib/models/chatCompletionsAdapter.ts`) turns that into `OLLAMA_MAX_TOKENS` (`<PROVIDER>_MAX_TOKENS` on a gateway) carrying the turn's token usage; a model that stops after thinking with nothing to say gets `<PROVIDER>_EMPTY_RESPONSE`. Without the error, ADK would drop the empty final response, warn "The last event is partial, which is not expected", and the turn would end with empty text. The Ollama adapter first retries the turn once with thinking off (`reasoning: none`, sent as `reasoning_effort: "none"`, both attempts' tokens counted), so on Ollama the error means the retry failed too; `OLLAMA_RETRY_WITHOUT_THINKING=false` turns the retry off. Two remedies work on Ollama: `reasoning: none` on the agent, which turns thinking off (on Ollama 0.31 `"low"` does not bound a qwen3.5 scratchpad, and `think: false` is ignored on `/v1`); or a larger window, set where Ollama reads it — a Modelfile with `PARAMETER num_ctx 32768` built with `ollama create`, or `OLLAMA_CONTEXT_LENGTH=32768` on the `ollama serve` process. `ollama ps` shows the window a loaded model actually has in its CONTEXT column. A reply that started but was cut off keeps its text and is marked `finishReason: MAX_TOKENS`; the `llm.request` span records `llm.finish_reason` either way.

## A turn that fails on malformed or forged input

What a hostile model answer, tool result, message or store can do to the native loop, and what stops it, is [native loop security](/operations/native-loop-security.md). Three failures a caller can see:

- **`IntentMismatchError` (`Tool confirmation rejected for function call '<id>': <reason>.`)**: an approval answer that does not bind to the call it pins. `untrusted_request` means the message carried the request itself; `arguments_mismatch` or `tool_name_mismatch` that the stored request or the call changed. Nothing ran. Over A2A the executor builds the answer, so this means the stored session was altered.
- **`No function call event found for function responses ids: <id>`**: the message carried a function response to a call no agent made, from a library caller's parts. The turn fails on both runtimes; the next message runs.
- **`NO_PENDING_APPROVAL`**: the answer names no approval open in this conversation (a replay, or another session's id).

A nested syndicate that reaches itself fails at compile with `<ref>: a nested syndicate reaches itself (<chain>)`; fix the `yaml_reference` chain.

## Silent degradations worth knowing

Two by design, from [tool contracts](/tools/tool-contracts.md) and [MCP](/protocols/mcp.md): an unknown tool name in YAML resolves to a **warning** and the agent runs without it; an unreachable MCP server yields an **empty tool list**, not a crash. A typo therefore produces a capability-less agent that passes tests — check startup warnings.
