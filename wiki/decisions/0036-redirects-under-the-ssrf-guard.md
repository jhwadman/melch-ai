---
type: decision
title: 'ADR 0036: OpenAPI calls follow redirects one hop at a time, under the SSRF guard'
description: ADK's RestApiTool calls globalThis.fetch, which follows redirects past a guard that checked only the configured server; a call now runs in an AsyncLocalStorage context whose fetch follows each hop by hand, same-origin hops under the server's rule and cross-origin hops under the full guard without credentials.
tags:
  - decision
  - tools
  - security
status: stable
generated:
  by: claude-code/claude-opus-5-5
  at: 2026-10-06
sources:
  - resource: lib/net/redirects.ts
  - resource: lib/tools/openapiTools.ts
  - resource: tests/redirects.test.ts
  - resource: tests/openapiTools.test.ts
---

# ADR 0036: OpenAPI calls follow redirects one hop at a time, under the SSRF guard

## Context

[ADR 0032](/decisions/0032-openapi-tools.md) held every OpenAPI server to
`lib/net/addressGuard.ts`: the literal rules at compile time, the full check
with DNS before each call. The check covered the URL a call starts at. ADK's
`RestApiTool.runAsync` then calls `globalThis.fetch` with the default
`redirect: 'follow'`, so a server that answers 302 sends the call wherever it
names. An allowed public API with an open redirect could point a call at
`169.254.169.254` (on AWS with IMDSv1, the instance's credentials come back
to the model), and fetch forwards every header except `Authorization` and
`Cookie` across origins, so an `api_key` sent `in: header` went too. An
enterprise readiness audit (6 October 2026) found it.

`web_extract` and the A2A client already handle redirects: the first follows
them manually, re-checking each hop; the second refuses them. Neither has to
reach into ADK, because both make their own requests.

## Decision

Each OpenAPI call runs inside `withRedirectGuard(policy, fn)`
(`lib/net/redirects.ts`). An AsyncLocalStorage context carries the policy;
a wrapper installed on `globalThis.fetch` applies it only inside such a
context and calls the original fetch untouched everywhere else. Inside, every
request uses `redirect: 'manual'`, each hop's URL goes to the policy before
it is fetched, a hop to another origin keeps only content-negotiation
headers, and more than five hops is an error.

The OpenAPI policy: a hop on the same origin gets the server's own rule
(`ALLOW_PRIVATE_OPENAPI` applies, as it did to the server); a hop to another
origin must pass the full guard with no development exception, because the
variable permits the server an operator configured, not wherever that server
points.

## Alternatives

- **Refuse every redirect** (`redirect: 'error'`, as the A2A client does).
  Simplest, but APIs do redirect legitimately (http to https, a moved path,
  a regional host), and an operator would meet it as a broken tool.
- **Re-implement `RestApiTool.runAsync`** with our own fetch. ADK's request
  builders (`prepareRequestParams`, `applyCredential`) are not public API, so
  this would copy them and drift on every ADK minor, the failure mode the
  genai pin in package.json already documents.
- **Swap `globalThis.fetch` for the duration of a call.** Not safe under
  concurrency: two turns in one process would see each other's policy.

The context-scoped wrapper keeps ADK's request building, is safe under
concurrent turns, and changes nothing for a fetch outside an OpenAPI call.
If something later replaces `globalThis.fetch`, the next guarded call wraps
the new one.

## Consequences

- A refused hop returns `{ error }` to the model ("redirect refused: …"),
  never the redirected response.
- The same helper can guard the MCP SSE client, which also follows redirects
  with the default fetch (open in the audit as SEC-06).
- DNS rebinding between the check and the connect remains open, as before;
  pinning the connection to the vetted address is separate work.
