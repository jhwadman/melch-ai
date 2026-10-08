---
type: decision
title: "ADR 0062: Server-side tools are markers, and MCP, remote-agent and examples tools are the engine's own"
description: "web_search, x_search, url_context, collections_search and google_search are NativeToolMarkers that declare no function and name their NativeTool under a global symbol; nativeToolOf and the sentinel helpers read the marker, never the class or the shape. The ADK sentinels carry the same marker and toAdkTool hands the ADK runtime the objects it always ran. MCP tools and the remote A2A agent tool are own Tools behind toFunctionTool, and an agent's examples are an InstructionTool writing ExampleTool's block word for word. Detection by name and shape, an own Tool with an empty declaration, moving the sentinel classes into adkTool.ts and keeping MCP's own Gemini conversion were rejected."
tags:
  - decision
  - tools
status: stable
generated:
  by: claude-code/claude-opus-5-5
  at: 2026-10-08
sources:
  - resource: lib/tools/tool.ts
  - resource: lib/tools/nativeTools.ts
  - resource: lib/tools/adkTool.ts
  - resource: lib/tools/webSearchTool.ts
  - resource: lib/tools/xSearchTool.ts
  - resource: lib/tools/urlContextTool.ts
  - resource: lib/tools/collectionsSearchTool.ts
  - resource: lib/tools/mcpToolFactory.ts
  - resource: lib/tools/examples.ts
  - resource: lib/a2a/remoteAgent.ts
  - resource: lib/models/schemaNormalize.ts
  - resource: lib/toolRegistry.ts
  - resource: lib/compile.ts
  - resource: tests/toolBaseRest.test.ts
  - resource: tests/capabilityMatrix.test.ts
---

# ADR 0062: Server-side tools are markers, and MCP, remote-agent and examples tools are the engine's own

## Context

[ADR 0051](/decisions/0051-own-tool-base-behind-an-adk-wrapper.md) made every registry tool that declares a function an own Tool, and [ADR 0059](/decisions/0059-memory-on-the-engines-own-interfaces.md) added the InstructionTool. Four kinds of tool were still ADK objects:

- **The server-side tools.** `web_search`, `x_search`, `url_context` and `collections_search` were ADK `BaseTool` subclasses that declare nothing. `google_search` is ADK's own `GOOGLE_SEARCH`. The request mapping found them with `nativeToolOf` ([ADR 0048](/decisions/0048-engine-owned-model-contract.md)), which matched a known name on a tool that declares no function. The `wants*` and `is*Sentinel` helpers used `instanceof`.
- **MCP tools.** `lib/tools/mcpToolFactory.ts` built each as a `FunctionTool` with its own uppercase conversion of the server's schema.
- **The remote A2A agent tool**, a hand-built `FunctionTool` in `lib/a2a/remoteAgent.ts`.
- **An agent's `examples:`**, ADK's `ExampleTool`.

The native loop has to run all of them without ADK, and the ADK runtime has to keep running them as before.

## Decision

1. **A server-side tool is a NativeToolMarker** (`lib/tools/tool.ts`): a frozen object with a `name`, a `description` for a reader, and its `NativeTool` under the global symbol `melchizedek.nativeTool` (`NATIVE_TOOL`). It declares no function and is never called. `lib/tools/nativeTools.ts` holds the five markers and loads nothing from `@google/*`.
2. **Every reader detects the marker, never the class or the shape.** `nativeToolMarkerOf()` reads the symbol. `nativeToolOf()` reads it first, then ADK's own markers: the built-in code executor, and the in-model marker on `GOOGLE_SEARCH` and ADK's `URL_CONTEXT` by name. A tool that merely declares nothing under a server-side name is no longer a NativeTool. `contractToolDeclaration` and `toolDeclarationFor` declare nothing for a marker. The `wants*` and `is*Sentinel` helpers read the marker.
3. **The ADK runtime keeps its sentinels, marked.** Each sentinel class carries its marker's symbol and description, and keeps its `processLlmRequest`: Gemini's own tool object on Gemini, the sentinel in `toolsDict` elsewhere. `toAdkNativeTool(marker)` (`lib/tools/adkTool.ts`) returns the shared sentinel, or `GOOGLE_SEARCH` for `google_search`. `toAdkTool()` picks the wrapper for a Tool, a contract, an InstructionTool or a marker, and passes an ADK tool through. The registry builds its server-side entries with it, so it holds the same objects as before. `registerTool` takes a marker.
4. **Code execution is not a marker.** It is an agent's `code_execution: gemini`, not a tool it lists. It reaches the request as the agent's code executor, recognised by ADK's marker.
5. **MCP tools are own Tools.** `loadMcpTools()` returns them, and `createMcpTools()` returns the `FunctionTool` that `toFunctionTool` makes of each. The parameters pass through Gemini's dialect once (`mcpToolParameters`), so the native and ADK runtimes declare the same schema.
6. **The remote agent tool is an own Tool** (`remoteAgentOwnTool`). It keys the remote conversation by `ctx.sessionId` and aborts with `ctx.signal`. `remoteAgentTool()` returns its `FunctionTool` and still declares exactly what the hand-built one declared.
7. **An agent's examples are an InstructionTool** (`lib/tools/examples.ts`, named `example_tool`). It writes ExampleTool's block for text examples word for word, only when the run's first message begins with text. `examplesTool()` in `lib/compile.ts` hands the ADK runtime its `toAdkInstructionTool` form.

## Alternatives considered

- **Keep detection by name and shape** (a known name with no declaration). Rejected. Any declaration-less tool registered under one of those names would turn into a provider search, and the ticket asks for a marker. ADK's own built-ins keep their name check, since ADK's marker says only that the model runs the tool.
- **A server-side tool as an own Tool with an empty declaration.** Rejected, as for `preload_memory` in ADR 0059. The model would be told it can call a function that must never be called, and every reader would need a second test to skip it.
- **Move the sentinel classes into `adkTool.ts`** so the sentinel modules load no ADK. Rejected for now. `melchizedek-agents/tools/webSearchTool` and its siblings export the classes and the deployment helpers the adapters read (`xSearchParamsFromEnv`, `collectionIdsFromEnv`), so consumers' imports would move. The markers already give the native runtime an ADK-free module.
- **Keep MCP's own conversion to Gemini's dialect** so the ADK runtime's MCP declarations stay byte for byte. Rejected. The native runtime would declare a different schema than the ADK runtime. The old conversion also uppercased `type` inside data such as `default` and `const`, and sent `propertyNames`, which the Gemini API refuses with a 400.
- **Fold the examples into the compiled instruction string.** Rejected. ExampleTool adds the block per request, only when the message begins with text, and after the other tools' instruction text. A static string would change both the condition and the place.

## Consequences

- The model sees the same declarations and instruction text on the ADK runtime, with one exception: an MCP tool's nested schemas no longer carry `default`, `propertyNames`, `$schema` or a boolean `additionalProperties`. Its top-level property types and descriptions, `enum`, `required` and `items` are unchanged. `tests/toolBaseRest.test.ts` compares the examples block with ADK's `ExampleTool` and the remote agent's declaration with the hand-built one. It also checks that an MCP tool declares the same parameters on both runtimes.
- A foreign copy of a sentinel, carrying only the marker, produces the same request body as the original on every adapter row (`tests/capabilityMatrix.test.ts`) and in the genai request mapping. A client-side tool under the same name stays a function tool.
- `toolOf()` now reads an MCP or remote agent `FunctionTool` back to its own Tool. `require_approval` still gates both, since they remain `FunctionTool`s.
- Consumers see additions only, under the existing `exports` map:
  - `tools/tool` gains `NATIVE_TOOL`, `NativeToolMarker`, `nativeToolMarker`, `nativeToolMarkerOf` and `isNativeToolMarker`;
  - `tools/nativeTools` and `tools/examples` are new;
  - `tools/adkTool` gains `toAdkNativeTool` and `toAdkTool`;
  - `tools/mcpToolFactory` gains `loadMcpTools` and `mcpToolParameters`;
  - `a2a/remote` gains `remoteAgentOwnTool` and `RemoteAgentToolParams`.
