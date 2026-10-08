---
type: decision
title: "ADR 0059: Memory and its tools are the engine's own: one service on both interfaces, recall through the tool context, and tools that write into the instruction"
description: The memory service implements the engine's MemoryService and ADK's BaseMemoryService, with ADK's two methods handing their arguments to the engine's. A tool reaches memory through ToolContext.searchMemory, bound to the run's own silo. A Tool may add text to the instruction, and an InstructionTool only does that. load_memory and preload_memory are the engine's own and send the model what ADK's sent. Renaming the service, the whole service on the context, a per-run tool, a memory special case in the loop, and two parallel implementations were rejected.
tags:
  - decision
  - memory
  - tools
status: stable
generated:
  by: claude-code/claude-opus-5-5
  at: 2026-10-07
sources:
  - resource: lib/memory/supabaseMemoryService.ts
  - resource: lib/memory/namespace.ts
  - resource: lib/runtime/memoryService.ts
  - resource: lib/tools/tool.ts
  - resource: lib/tools/adkTool.ts
  - resource: lib/tools/memoryTools.ts
  - resource: lib/toolRegistry.ts
  - resource: tests/memoryTools.test.ts
---

# ADR 0059: Memory and its tools are the engine's own: one service on both interfaces, recall through the tool context, and tools that write into the instruction

## Context

[ADR 0052](/decisions/0052-sessions-and-events-on-own-interfaces.md) gave the engine its own `MemoryService` (`lib/runtime/memoryService.ts`). The memory service (`lib/memory/supabaseMemoryService.ts`) still implemented only ADK's `BaseMemoryService`. [ADR 0051](/decisions/0051-own-tool-base-behind-an-adk-wrapper.md) made every registry tool the engine's own except the two memory tools, which were ADK's objects:

- **`load_memory`** (ADK's `LoadMemoryTool`) declares a `query` argument and returns the recalled memories as text. While the run has a memory service, it also appends a note to the system instruction saying that memory exists.
- **`preload_memory`** (ADK's `PreloadMemoryTool`) declares nothing and is never called. Before each request it searches memory with the first text part of the message that started the run and appends the results to the system instruction in a `<PAST_CONVERSATIONS>` block.

Both reach memory through ADK's `Context.searchMemory`, which the engine's `ToolContext` does not have. The `Tool` interface has no way to write into the instruction, and a tool that declares nothing is not a `Tool`.

`runSyndicateTurn` and `createA2AApp` take an ADK `BaseMemoryService`, and a consumer may pass their own. The `runSyndicateTurn` signature is fixed ([ADR 0045](/decisions/0045-own-runtime-behind-the-seam.md) item 4).

Three questions had real alternatives:

- how one service serves both runtimes;
- how a tool reaches memory;
- how a tool writes into the instruction, and what `preload_memory` becomes.

## Decision

1. **One service implements both interfaces.** `SupabaseVectorMemoryService` implements `MemoryService` and `BaseMemoryService`:
   - `ingest(session, { extractionRules, extractionModel })` and `search(request)` hold the logic.
   - ADK's `addSessionToMemory(session, rules, { extractionModel })` and `searchMemory(request)` each hand their arguments to the engine's method and return its result.
   - `deleteUserMemory`, `pruneExpired` and `verifyEmbeddingDimensions` keep the names the A2A server calls them by, which are the interface's names.

   The ADK runtime, `ingestTurnMemory` and the A2A server keep calling ADK's names, and their option types stay `BaseMemoryService`, so a consumer's own ADK memory service keeps working. `namespacedMemoryService` pins the root namespace on `search` and `ingest` as it does on ADK's two methods ([ADR 0020](/decisions/0020-memory-contract.md) item 3). Erase and retention pass through it unchanged, since they name their key or namespace themselves.
2. **A tool recalls through its context, from the run's own silo only.** `ToolContext` gains two members:
   - `searchMemory(query)`, present only when the run has a memory service. It searches the context's own `<appName>/<userId>` silo, so a tool chooses what to recall but never whose.
   - `userContent`, the message that started the run.

   `createToolContext` takes the run's `memory` (already pinned to the namespace) and `userContent`. Its search refuses to run when the context does not know the app name and user id, rather than search a key nobody writes to. On the ADK runtime the context reads through to ADK's `Context.searchMemory`, so the search reaches the same service with the same request ADK's own tools made.
3. **A tool may write into the instruction.**
   - `Tool.instruction(ctx)` returns text for the system instruction of each model request made for an agent that lists the tool, or undefined to add nothing.
   - An **`InstructionTool`** has only a `name` and an `instruction(ctx)`: it declares no function and the model never calls it.

   Both run before the request is sent, in the order the agent lists its tools. On the ADK runtime, `lib/tools/adkTool.ts` appends the text in the tool's `processLlmRequest`, joined exactly as ADK's own `appendInstructions` joins it:
   - a Tool with an `instruction` becomes a `FunctionTool` subclass;
   - an InstructionTool becomes a `BaseTool` that declares nothing (`toAdkInstructionTool`), which `instructionToolOf()` reads back.

   `registerTool` takes an InstructionTool, and `contractToolDeclaration` declares nothing for one.
4. **The memory tools are the engine's own** (`lib/tools/memoryTools.ts`):
   - `load_memory` is a `defineTool` Tool with an `instruction`.
   - `preload_memory` is an InstructionTool.

   Their declaration, note, result and recalled block are ADK's, word for word. The registry holds them, and nothing in `lib/` imports ADK's `LOAD_MEMORY` or `PRELOAD_MEMORY`.

## Alternatives considered

- **Rename the service's methods to the engine's, and adapt at the Runner.** Rejected. A consumer's own `BaseMemoryService`, such as a managed memory product, would then need an adapter. The A2A server's option type would change, and the `runSyndicateTurn` signature is fixed.
- **A separate adapter object** that wraps an engine service as a `BaseMemoryService`. Rejected. Every service would become two objects, and the A2A server's by-name checks (`verifyEmbeddingDimensions`, `pruneExpired`) would have to see through the wrapper.
- **The whole `MemoryService` on the tool context.** Rejected. A tool could then ingest, erase, or search any user's key. A search bound to the run's own silo is all either memory tool needs.
- **A memory tool built per run** around the run's service. Rejected. The registry is static and compiled agents share tool objects, so the compile step would have to carry the memory service.
- **Memory as a special case in the loop.** The native loop would read the service, inject the preload block and add the note itself. Rejected. That couples the loop to one subsystem, and every other tool that writes into the instruction would become another special case. ADK's `ExampleTool`, which a YAML's `examples:` uses, is the next one.
- **ADK's tools on the ADK runtime and separate engine tools on the native runtime.** Rejected. Two implementations of texts that must stay identical would drift, which is what ADR 0051 set out to end.
- **`preload_memory` as a Tool with an empty declaration.** Rejected. The model would be told it can call a function that must never be called.
- **An ADK `BaseTool` for `load_memory` instead of a `FunctionTool`,** so a failed call reads exactly as ADK's did. Rejected. Approval gating (`lib/compile.ts` gates `FunctionTool`s) and `toolOf` would each need `load_memory` as a special case. The cost of rejecting it is FunctionTool's prefix on a failed call's error.

## Consequences

- On the ADK runtime the model sees the same declaration, the same note, the same recalled block in the same place, and the same results. `tests/memoryTools.test.ts` compares each tool with ADK's own, case by case, and runs one whole turn with each pair, comparing the requests the model received, the searches made and the stored responses.
- Through the engine's interface alone, the same tools read the same silo and write the same text. `tests/memoryTools.test.ts` and the Postgres integration suite drive `ingest`, `search`, erase and retention directly, pinned to a namespace and scoped per user. `tests/memoryIngestion.test.ts` runs every at-least-once test through both `addSessionToMemory` and `ingest`.
- A failed `load_memory` call's error reads `Error in tool 'load_memory': <message>`, FunctionTool's wording (ADR 0051 item 4), where ADK's tool gave the message alone. The self-correction plugin's reflection ([ADR 0034](/decisions/0034-self-correction.md)) carries that text.
- `load_memory` validates its arguments. A call without a string `query` returns the readable error instead of searching.
- `load_memory` is a `FunctionTool`, so `require_approval` can gate it ([ADR 0028](/decisions/0028-approval-gates.md)). Before, compile refused the gate.
- No log line holds the user's words. A failed `preload_memory` search logs the error and not the query, where ADK's tool logged the query. A failed `load_memory` search logs the error message.
- Extraction still calls ADK-shaped adapters (`lib/memory/providers.ts`), so the memory service loads ADK through that module. It stops when the extraction call moves onto the model contract. The session services move in WS2-2.
- Consumers see additions only, all under the existing `exports` map:
  - `melchizedek-agents/tools/tool` gains `Tool.instruction`, `InstructionTool`, `isInstructionTool`, `instructionToolOf`, and `ToolContext.userContent` and `searchMemory`;
  - `tools/adkTool` gains `toAdkInstructionTool`;
  - `tools/memoryTools` is new;
  - `registerTool` takes an InstructionTool;
  - `namespacedMemoryService` takes a `MemoryService`.
