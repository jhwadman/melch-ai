---
type: decision
title: "ADR 0063: The engine parses OpenAPI specs itself, by ADK's rules, with bounds"
description: "lib/tools/openapi/parse.ts reads an OpenAPI 3 spec into the engine's own operations, parameters and ToolDeclarations, reproducing ADK 2.2's naming, argument and declaration rules exactly, so every tool keeps its name and the model reads the same declaration. ADK's RestApiTool is built from the parse and still makes the call. A spec is bounded: 4 MiB, 100 YAML aliases, a million values once refs are resolved, 128 levels. YAML is read with the package's own yaml reader. Fixing ADK's declaration quirks, keeping OpenAPIToolset as the parser, and depending on js-yaml were rejected."
tags:
  - decision
  - tools
status: stable
generated:
  by: claude-code/claude-opus-5-5
  at: 2026-10-08
sources:
  - resource: lib/tools/openapi/parse.ts
  - resource: lib/tools/openapiTools.ts
  - resource: tests/openapiTools.test.ts
---

# ADR 0063: The engine parses OpenAPI specs itself, by ADK's rules, with bounds

## Context

[ADR 0032](/decisions/0032-openapi-tools.md) turned an agent's `openapi:` entries into tools through ADK's `OpenAPIToolset`, which parsed the spec, named each operation's tool, split its parameters and request body into arguments, and declared them in Gemini's dialect. [ADR 0045](/decisions/0045-own-runtime-behind-the-seam.md) has the engine own its runtime in stages, and [ADR 0051](/decisions/0051-own-tool-base-behind-an-adk-wrapper.md) gave it its own tool base. The native runtime needs an OpenAPI operation as the engine's own types: a name, the arguments and where each goes, and a `ToolDeclaration`.

ADK's parser also had no bounds. A spec is reviewed configuration, but a registry-stored YAML can point at one, and the parser copied every `$ref` use in full, so a small file whose schemas each use the one below twice expanded exponentially. Its YAML reader expanded aliases without a limit, and its snake_case helper used a regular expression that backtracks quadratically on a long run of capitals.

Three questions had real alternatives:

- whether the engine's parser declares exactly what ADK declared, quirks included, or a cleaner schema;
- how the ADK runtime's tools relate to the new parse during the dual-runtime period;
- which YAML reader reads a spec.

## Decision

1. **The parser reproduces ADK 2.2's rules exactly** (`lib/tools/openapi/parse.ts`). Ref resolution order and cycle handling, type sanitising, operation order, the operationId made from path and method, snake_case names with Python keywords prefixed `param_`, the 60-character cut before and after the prefix, argument order and dedupe, request-body splitting, and the declared schema (Gemini's keywords less `title`, `default` and `format`, a missing type an object, an empty object given the `dummy_DO_NOT_GENERATE` placeholder) all match. Every tool keeps its name and every declaration is unchanged. The example specs' declarations are pinned in `tests/openapiTools.test.ts`, and a differential test holds the parser to ADK's own parse on a spec that exercises every rule.
2. **The ADK runtime's tools are built from the parse.** `buildOpenApiTools` parses with the engine, filters (`operationNamed`, GET-only by default), and builds each tool with ADK's `createRestApiTool` from the parsed parameters. This is the same `RestApiTool` that `OpenAPIToolset` built. ADK still makes the HTTP call, under the engine's SSRF guard and redirect policy, until WS3-4b. `toSnake` and `namesTool` move into the parser and are re-exported from `openapiTools.ts`.
3. **A spec is bounded.** These limits apply:
   - a file over `MAX_SPEC_BYTES` (4 MiB) is refused before it is read;
   - YAML aliases are capped at 100;
   - resolving refs counts every value it produces and stops at `MAX_SPEC_NODES` (1,000,000);
   - nesting deeper than `MAX_SPEC_DEPTH` (128) is refused, and following a ref counts as a level, so a long chain of refs is bounded too;
   - a ref cycle ends where it closes, as before.

   Each failure is an `Error` with a readable message, which fails the compile. The snake_case helpers are single passes, linear in the input, and a test holds them equal to the regular expressions they replace.
4. **YAML is read with the package's own `yaml` dependency.** Merge keys and the timestamp tag are on, so the document matches the one ADK's js-yaml produced (a date becomes its ISO string). A key named `__proto__` stays a key, and a ref resolves only through own keys.

## Alternatives considered

- **Declare a cleaner schema.** The parser could drop the empty-object placeholder, send a query parameter's own `description` (ADK leaves it out), carry `type: [string, null]` instead of `type_unspecified`, and leave out the `object` type that ADK adds beside an `anyOf`. All four would improve what the model reads. But every changed declaration changes what an agent does, and this ticket's acceptance is that nothing a model reads changes. Each one is a separate, reviewable change, now one line in the parser.
- **Keep `OpenAPIToolset` as the parser and read the declarations off its tools.** No parser code would be needed, but the native runtime would keep ADK in the tool path, and the bounds could not be added.
- **Parse twice, using ADK's tools and the engine's parse side by side.** This needs no `createRestApiTool`, but the two parses could drift silently, and the call's arguments would come from a parse the declaration did not.
- **Depend on js-yaml directly**, the reader ADK uses. This gives identical YAML semantics by construction, but adds a dependency for a reader the package already has, and js-yaml has no alias limit.

## Consequences

- An operation is the engine's `OpenApiOperation`, carrying its `ToolDeclaration`. WS3-4b can make it an own Tool without touching the parse.
- A spec that used to compile and now exceeds a bound fails the compile with a message naming the bound. Real specs trimmed to an agent's operations, as the docs advise, are far below them.
- A spec that is not an object, or whose schema node is not an object, fails the compile with a readable error. Before, it produced no tools, or a tool that declared nothing.
- With no `prefix` set, matching an `operations:` entry no longer strips the text `undefined_` from a tool name. That stripping was an artefact of a template string.
- Open: the declaration clean-ups listed above, JSON-pointer escapes (`~1`) in refs, which ADK did not unescape and the parser does not either, and Swagger 2 specs, which neither refuses.
