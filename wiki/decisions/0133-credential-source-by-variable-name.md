---
type: decision
title: "ADR 0133: An embedding application supplies credentials through one source, asked by environment variable name at each use"
description: "setCredentialSource(fn) sets a process-wide source the engine asks for a credential by its environment variable name (ANTHROPIC_API_KEY, MODEL_GATEWAY_API_KEY, …) before reading process.env, at every use and without caching. Every key read goes through credentialValue or credentialEnv: the five adapters, the gateway, provider presence, endpoints, the Gemini image and vision tools, embeddings, memory providers, the A2A storage's memory key and the ChatGPT sign-in routing. A source that throws holds nothing. Writing keys into process.env, a new provider-keyed vocabulary and threading keys through every call were rejected."
tags:
  - decision
  - models
  - operations
status: stable
generated:
  by: claude-code/claude-opus-5-5
  at: 2026-10-15
sources:
  - resource: lib/models/credentialSource.ts
  - resource: lib/models/providerMap.ts
  - resource: lib/index.ts
  - resource: tests/credentialSource.test.ts
---

# ADR 0133: An embedding application supplies credentials through one source, asked by environment variable name at each use

## Context

Every provider key was read from `process.env` at the point of use, in a dozen places: the five adapters, the gateway, the presence check behind `providerStatuses()` and gateway routing, endpoint resolution, the Gemini image and vision tools, embeddings and the memory providers. The per-request `credentials` plug point of `createA2AApp` and the `apiKey` of `resolveModel` cover a served model call, not a tool, an embedding or a presence check. A desktop application that keeps its user's keys in the OS keychain then had to copy them into `process.env`, where every child process, crash report and environment dump would see them, and where removing a key meant restarting.

## Decision

1. **One source, by variable name.** `setCredentialSource((name) => string | undefined)` (exported from the barrel with `credentialValue` and the `CredentialSource` type) sets a process-wide source. The engine asks it for a credential by the environment variable name it already documents, so an application maps its keychain entries to names users already know, and nothing new is learned.
2. **Asked at each use, never cached.** `credentialValue(name)` asks the source, then the environment. A key removed from the keychain stops being sent on the next request. A source that returns undefined or an empty string falls back to `process.env`; a source that throws counts as holding nothing, so a locked keychain degrades to "no key", never to a crash.
3. **Every key read goes through it.** Direct reads call `credentialValue`. Helpers that take an `env` parameter default it to `credentialEnv()`, a view of `process.env` whose reads by name ask the source first; a caller passing its own `env` (tests, the doctor) is unchanged. `lib/models/credentialSource.ts` imports nothing, so `providerMap.ts` stays a leaf.

## Alternatives rejected

- **Copy keys into `process.env`.** Inherited by every child (MCP stdio servers get a minimal environment, ADR 0132, but skill scripts and others may not), visible in diagnostics, and fixed until restart.
- **A provider-keyed source (`(provider) => key`).** It does not cover the gateway, Azure, embeddings or the image tools, which have no provider id of their own; the variable names cover all of them.
- **Threading a key through every call.** Tools, embeddings and presence checks have no request to carry it; the per-request `credentials` plug point stays for what it serves.

## Consequences

- The doctor and the setup guide still report the environment: they describe a CLI user's configuration, not an embedding application's.
- A source sees which variable names the engine asks for; it is the embedder's own code.
