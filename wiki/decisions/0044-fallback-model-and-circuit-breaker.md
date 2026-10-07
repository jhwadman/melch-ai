---
type: decision
title: 'ADR 0044: An agent may name a fallback model; a provider that keeps failing is skipped for a cooldown'
description: fallback_model wraps an agent's model so a provider-side failure before any output is answered by the fallback, and a per-provider circuit breaker (MODEL_BREAKER_THRESHOLD, MODEL_BREAKER_COOLDOWN_MS) sends wrapped agents straight to their fallback during an outage; opt-in per agent.
tags:
  - decision
  - models
  - operations
status: stable
generated:
  by: claude-code/claude-opus-5-5
  at: 2026-10-06
sources:
  - resource: lib/models/fallback.ts
  - resource: lib/compile.ts
  - resource: tests/fallback.test.ts
---

# ADR 0044: An agent may name a fallback model; a provider that keeps failing is skipped for a cooldown

## Context

`lib/models/retry.ts` makes one model call survive a blip: bounded,
jittered retries before any output. An enterprise readiness audit
(6 October 2026) noted that nothing handles an outage (OPS-02): every turn
on a provider that is down spends its retries and fails, and the gateway
fallback applies only when a key is missing, never when a provider fails.

## Decision

- **`fallback_model:`**, an agent key. When set, the compiler wraps the
  agent's model in `FallbackLlm` (`lib/models/fallback.ts`), holding the
  primary and the fallback adapters.
- **What redirects.** Only a provider-side failure, which is what
  `retry.ts` classifies retryable, once the adapter's own retries are spent.
  It is redirected only if the primary had produced nothing yet. A 4xx is
  the request's fault and is thrown; a canceled turn is never counted or
  redirected; a stream that failed midway is thrown, never replayed on
  another model.
- **The breaker.** Per provider, shared by every wrapped agent in the
  process: `MODEL_BREAKER_THRESHOLD` consecutive failures (default 5; 0
  disables) open it for `MODEL_BREAKER_COOLDOWN_MS` (default 30 s), during
  which wrapped agents go straight to their fallback. After the cooldown one
  call is let through; a success closes the circuit.

> **Note (2026-10-07):** As shipped in 0.18.0, `FallbackLlm` saw a failure only as a throw, which only Gemini makes; GPT, Grok, Kimi, Ollama and the gateway yield an error response instead, so their fallback never answered and the failed call was counted as a success. The rule now holds for error responses as well as throws: those adapters set `customMetadata['error.retryable']` (and `'error.status'`) from `retry.ts`'s classification (`lib/models/errorResponse.ts`), a retryable one before any output is counted and redirected without being yielded, a non-retryable one is passed on, and only a call that yielded content counts as a success. Claude is excepted until its adapter uses the same helper (ticket WS0-8).

## Alternatives

- **Wrap every agent's model, fallback or not.** A breaker without a
  fallback can only fail faster, and a wrapper on every model changes what
  ADK sees for every agent (some built-in tool paths check the model).
  Opt-in keeps the hot path of every other agent untouched.
- **Fall back inside each adapter.** Five adapters, three retry stacks
  (SDK-native and our own); one wrapper above them is one implementation.
- **Fall back mid-stream.** It would replay text the user has already seen,
  the rule `retry.ts` already holds for retries.

## Consequences

- An agent that names a fallback on another provider keeps answering
  through a provider outage, at that model's quality and price.
- The fallback is another model call, counted under `max_steps`.
