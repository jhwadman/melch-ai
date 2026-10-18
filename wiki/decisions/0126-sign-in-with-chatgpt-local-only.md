---
type: decision
title: "ADR 0126: Sign in with ChatGPT as a local-only OpenAI credential"
description: "The engine implements OpenAI's Sign in with ChatGPT plan-usage flow as its own client, used only locally and refused on served surfaces."
tags:
  - decision
  - models
  - openai
  - onboarding
  - security
status: stable
generated:
  by: claude-code/claude-opus-5-5
  at: 2026-10-18
sources:
  - resource: lib/chatgpt/oauth.ts
  - resource: lib/chatgpt/state.ts
  - resource: lib/chatgpt/store.ts
  - resource: lib/chatgpt/adapter.ts
  - resource: lib/chatgpt/cli.ts
  - resource: lib/models/adapterResolver.ts
  - resource: lib/models/gateway.ts
  - resource: lib/doctor.ts
  - resource: lib/onboarding.ts
  - resource: lib/a2a/app.ts
  - resource: tests/chatgptSignIn.test.ts
  - resource: https://developers.openai.com/siwc
  - resource: https://developers.openai.com/siwc/token-sharing-open-source
  - resource: https://developers.openai.com/siwc/token-sharing-open-source/sign-in
  - resource: https://developers.openai.com/siwc/token-sharing-open-source/profiles-and-sessions
  - resource: https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference
  - resource: https://developers.openai.com/siwc/token-sharing-open-source/token-reference
  - resource: https://developers.openai.com/siwc/token-sharing-open-source/errors-and-recovery
  - resource: https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations
  - resource: https://developers.openai.com/siwc/token-sharing-open-source/self-hosted-vms
  - resource: https://developers.openai.com/cookbook/articles/sign-in-with-chatgpt
  - resource: https://github.com/openai/sign-in-with-chatgpt-devkit
---

# ADR 0126: Sign in with ChatGPT as a local-only OpenAI credential

**Decided (2026-10-09):** The engine implements OpenAI's documented Sign in with ChatGPT flow as its own dynamically registered public client, a local OpenAI credential ranked after `OPENAI_API_KEY` and before the gateway. Served surfaces (the A2A server, the worker, MCP over HTTP) refuse to start while it is the OpenAI path.

**Instead of:** reusing the Codex CLI's client id or tokens, depending on OpenAI's DevKit, an owner-registered client id, the OS keychain or the credential cipher, the gateway before the sign-in, serving behind an opt-in
**Supersedes:** [ADR 0123](/decisions/0123-onboarding-levels-from-one-generator.md) (the ChatGPT half of the unsupported subscription entry, and its open question)
**Open:** confirm live the unit of `earliest_refresh_at`; whether the route accepts `reasoning.encrypted_content` and a strict `text.format`

How it works: [Sign in with ChatGPT](/models/chatgpt-signin.md)
