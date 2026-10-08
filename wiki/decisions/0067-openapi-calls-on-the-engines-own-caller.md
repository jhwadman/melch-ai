---
type: decision
title: "ADR 0067: The engine calls OpenAPI operations itself, by RestApiTool's rules, with the guard as a parameter"
description: "lib/tools/openapi/call.ts builds and sends each OpenAPI call: the request RestApiTool built, held to it by a differential test, sent through the SSRF guard with redirects followed by hand under the policy passed to the call. Each operation is an own Tool, run on the ADK path through toFunctionTool, and require_approval gates it with the one gate every registry tool takes. The context-scoped fetch wrapper of ADR 0036 is retired. A credential's value is replaced in every error the model reads, at most 8 MiB of a response is read, and an operation whose spec requires a credential the entry does not configure is not called. Keeping RestApiTool under the wrapper, a cleaner request builder, keeping the OpenAPI-only gate, raising adk_request_credential and calling without the credential were rejected."
tags:
  - decision
  - tools
  - security
status: stable
generated:
  by: claude-code/claude-opus-5-5
  at: 2026-10-08
sources:
  - resource: lib/tools/openapi/call.ts
  - resource: lib/tools/openapiTools.ts
  - resource: lib/net/redirects.ts
  - resource: lib/compile.ts
  - resource: tests/openapiTools.test.ts
  - resource: tests/redirects.test.ts
---

# ADR 0067: The engine calls OpenAPI operations itself, by RestApiTool's rules, with the guard as a parameter

## Context

[ADR 0063](/decisions/0063-openapi-parser-on-the-engines-own-types.md) gave the engine its own OpenAPI parser, but each call still went through ADK's `RestApiTool`, built from the parse. `RestApiTool.runAsync` calls `globalThis.fetch` itself, so [ADR 0036](/decisions/0036-redirects-under-the-ssrf-guard.md) held its redirects to the SSRF guard by installing a wrapper on `globalThis.fetch` that applied a policy inside an AsyncLocalStorage context. An approval on an OpenAPI operation used its own gate in `lib/compile.ts` (`requireApprovalOnBaseTool`), with texts of its own, because the tool was a `BaseTool` rather than a `FunctionTool`. The native runtime ([ADR 0045](/decisions/0045-own-runtime-behind-the-seam.md)) runs own Tools ([ADR 0051](/decisions/0051-own-tool-base-behind-an-adk-wrapper.md)), so it can run neither `RestApiTool` nor that gate.

Five questions had real alternatives:

- how the engine's request is built;
- where the redirect policy lives once the engine makes the request;
- which gate an OpenAPI operation takes;
- what a call does when the spec requires a credential and the entry configures none (RestApiTool raised ADK's `adk_request_credential`, which the engine does not handle);
- what the engine adds to the call beyond what RestApiTool did.

## Decision

1. **The request is RestApiTool's (ADK 2.2), rule for rule** (`buildRequest` in `lib/tools/openapi/call.ts`). Each argument goes where its parameter says: a path argument is URL-encoded whole and `.` or `..` is refused; a query argument that is undefined, null or empty is left out; header and cookie arguments are sent as text, the cookies joined into one `Cookie` header unless a header argument already set one. The body is encoded by the request body's first media type (JSON and `+json`, form, multipart, octet-stream, plain text), or as JSON when the spec has no request body. The credential is applied after the arguments, so a spec parameter named `Authorization` cannot replace it. A status of 400 or more returns RestApiTool's error text with the body; any other body is its JSON, else `{ text }`. A differential test sends the same operations and arguments through ADK's `RestApiTool` and the engine's caller, and holds the requests and the results equal.
2. **The redirect policy is a parameter of the call.** `callOperation` sends through `fetchWithRedirectPolicy` with `OPENAPI_REDIRECTS`: a hop on the server's origin gets the server's own check, a hop to another origin the full guard with no development exception, and only content-negotiation headers cross origins. `withRedirectGuard` and its wrapper on `globalThis.fetch` are removed; nothing in the engine patches a global.
3. **One gate.** An operation is an own Tool (`buildOpenApiOwnTools`), and the ADK runtime runs it through `toFunctionTool` (`buildOpenApiTools`). `gateTools` gates it with `requireApprovalOn`, as it gates every registry tool, and `toolOf` reads the gated Tool back for the native runtime. The approval texts are ADK's FunctionTool texts (`APPROVAL_TEXTS`), the same on both runtimes. The tool carries its operationId under `OPENAPI_TOOL`, so `require_approval` may still name it by operationId. `requireApprovalOnBaseTool` stays exported, deprecated and unused.
4. **No credential, no call.** When the spec's security requirement names a scheme and the entry sets no `auth`, the call returns `{ error }` saying the spec requires a credential and the entry configures none. Nothing is sent, as before.
5. **What the engine adds:**
   - the credential's value, plain and URL-encoded, is replaced with `[redacted]` in every error the model reads (a fetch error can quote the URL, which carries a query key, and an API's error body can echo the key it refused);
   - at most `MAX_RESPONSE_BYTES` (8 MiB) of a response body is read, and the rest is cancelled;
   - the turn's abort signal reaches the request.

## Alternatives considered

- **Keep RestApiTool under the wrapper.** Zero request code, but the native runtime cannot run it, and the global wrapper stays.
- **A cleaner request builder.** An array query argument could be repeated keys instead of `a,b`, and a query key could go through `URLSearchParams`. Each is a change an API sees, and this change's acceptance is that no API sees a different request. Either is now one line in `call.ts`.
- **Keep the OpenAPI-only gate.** It kept the old texts (`Approval is required before …`), but it overrode `runAsync`, which the native runtime never calls, so the native runtime would have run a gated operation ungated. The texts differ only in the words a person and the model read; the interrupt name and the stored call are the same.
- **Raise `adk_request_credential`.** The engine handles two interrupts, `adk_request_confirmation` and `ask_user`, and adding a third changes the A2A surface. An agent with a credential gets it from `auth`, from the environment.
- **Call without the credential.** Some specs mark security that is optional, but sending a request that the spec says needs a credential changes what an API receives, and RestApiTool never sent one.
- **Redact the whole result.** A success body that quotes the key is rare and would need a JSON walk of every result; the error paths are where a key appears.

## Consequences

- No runtime code imports ADK's `OpenAPIToolset`, `RestApiTool`, `createRestApiTool` or `tokenToSchemeCredential`; a test reads `lib/` for the imports. The tests import them only as the reference.
- An approval on an OpenAPI operation reads as any other tool's: the hint `Please approve or reject the tool call create_pet() …`, then `This tool call requires confirmation, please approve or reject.` or `This tool call is rejected.`
- A response over 8 MiB is cut while it is read. It no longer parses as JSON, so the model receives the start of `{ text }`, marked as cut. Before, the whole body was read and its JSON cut.
- `ADR 0036`'s policy is unchanged. Only its mechanism, the wrapper on `globalThis.fetch`, is retired.
- DNS rebinding between the check and the connect remains open, as ADR 0036 states.
- Two of ADR 0063's open items close with this change: a `$ref`'s JSON-pointer escapes (`~1`, `~0`) are unescaped, and a spec that is not OpenAPI 3.x (Swagger 2.0, or no `openapi` version) fails the compile with a readable error. Its declaration clean-ups stay open.
