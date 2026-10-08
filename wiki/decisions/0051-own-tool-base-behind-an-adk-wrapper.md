---
type: decision
title: 'ADR 0051: Tools are the engine''s own, with a delta-aware context, and reach ADK through one wrapper'
description: A Tool is a name, a declaration in the model contract's shape and execute(args, ctx). The ToolContext shows session state as a view whose writes land in stateDelta. defineTool returns a Tool that is still a ToolContract. lib/tools/adkTool.ts is the one place a Tool becomes an ADK FunctionTool, and toolContract.ts no longer exports toFunctionTool.
tags:
  - decision
  - tools
status: stable
generated:
  by: claude-code/claude-opus-5-5
  at: 2026-10-07
sources:
  - resource: lib/tools/tool.ts
  - resource: lib/tools/toolContract.ts
  - resource: lib/tools/adkTool.ts
  - resource: lib/toolRegistry.ts
  - resource: tests/toolContract.test.ts
---

# ADR 0051: Tools are the engine's own, with a delta-aware context, and reach ADK through one wrapper

## Context

[ADR 0045](/decisions/0045-own-runtime-behind-the-seam.md) has the engine own its runtime in stages, and [ADR 0048](/decisions/0048-engine-owned-model-contract.md) gave it its own model contract, including `ToolDeclaration`. Tools were still ADK objects. Every registry tool was a `FunctionTool`, built by `toFunctionTool` from a `defineTool` contract or written by hand (`generate_image`, `inspect_image`, and `ask_user` as a `LongRunningFunctionTool`). Running one needed ADK's `Context`, which carries the session state, the event's actions and the approval gate.

The native runtime has to run the same tools without ADK, and the ADK runtime has to keep running them unchanged until 1.0.0. Three questions had real alternatives:

- how a tool's context exposes session state;
- what `defineTool` returns, given that consumers already hold its result as a `ToolContract`;
- where the ADK wrapper lives, given that `toFunctionTool` was exported from `lib/tools/toolContract.ts`.

## Decision

1. **A Tool is a name, a declaration and an execute** (`lib/tools/tool.ts`). `declaration()` returns the model contract's `ToolDeclaration`. `execute(args, ctx)` takes the model's arguments, which are untrusted, and returns JSON-serializable data. A throw becomes the call's error, which the runtime reports to the model. A `longRunning` Tool resolves to undefined while its answer is pending, and `requiresApproval` marks a gated copy. The module imports only a type from the model contract.
2. **The context shows state as a view whose writes land in a delta.** `ctx.state` has `get`, `set` and `has`. Reads see the writes this call made, and every `set` is recorded in `ctx.stateDelta`, which the runtime applies to the session with the tool's result. The session state itself is never mutated during the call. The context also carries:
   - the invocation, agent, call, user, app and session ids;
   - `actions.skipSummarization`;
   - `requestConfirmation()` and `confirmation`;
   - the turn's abort `signal`.

   On the ADK runtime the same view reads through to ADK's `State`, whose writes land in the event's `actions.stateDelta`. The stored Event JSON therefore keeps its shape.
3. **`defineTool` returns a Tool that is still a `ToolContract`.** The returned object keeps `name`, `description` and `schema` and adds `declaration()`. Its `execute` validates the arguments against the schema before the handler runs, and returns the readable error string when they do not parse. The handler receives a complete `ToolContext` on every surface, built from whatever identity the caller knew when it is called outside a run. `executeContract` recognises a defined Tool and validates once.
4. **One wrapper at the boundary.** `lib/tools/adkTool.ts` holds `toFunctionTool(tool)`. It builds a `FunctionTool` whose Gemini-dialect parameters come from the Tool's declaration and whose execute hands the Tool a context that reads ADK's `Context`. A long-running Tool becomes a long-running `FunctionTool`. A gated Tool sets `FunctionTool`'s own `requireConfirmation`. The `FunctionTool` carries the Tool under `Symbol.for('melchizedek.tool')`, and `toolOf()` reads it back, keeping a gate that `lib/compile.ts` added on the ADK side. `tool.ts` and `toolContract.ts` load nothing from `@google/*` at runtime. The barrel still exports `toFunctionTool`, now from the wrapper module.
5. **The ADK runtime's words are kept.** `requireApproval` writes the hint and the pending and rejected texts that `FunctionTool`'s gate writes. A long-running description carries the note that `LongRunningFunctionTool` appends. A call therefore stores the same interrupt and the same response on either runtime, and a model reads the same declaration.
6. **Every registry tool that declares a function is a Tool**, except ADK's `load_memory`, which moves with the memory tools. `generate_image`, `inspect_image` and `ask_user` become `defineTool` contracts. The server-side sentinels stay ADK objects until their own ticket.
7. **The schema follow-ups from the declaration work** (WS1-9) land on both paths together:
   - zod schemas are exported with `io: 'input'`, so a field with a default is optional to the model;
   - `toGeminiSchema` walks by schema keyword, so a property named `additionalProperties` or `default` survives;
   - a record keeps its value schema, while a boolean `additionalProperties` is dropped as before.
8. **Result capping is opt-in.** `capResult` and `MAX_RESULT_CHARS` (20,000, the limit the OpenAPI and MCP tools already use) are shared. A contract sets `maxResultChars` to cap its results, and no built-in tool sets it.

> **Note (2026-10-07):** Item 6's exception is closed. `load_memory` is an own Tool and `preload_memory` an own InstructionTool, and the context gains `userContent` and `searchMemory`, see [ADR 0059](/decisions/0059-memory-on-the-engines-own-interfaces.md).

## Alternatives considered

- **State as a snapshot plus a writable delta record.** The tool would read `ctx.state` (frozen) and write `ctx.stateDelta[key]`. This is simpler to implement, but a tool that writes and then reads its own key sees the old value unless it checks the delta first. ADK's skill toolset already uses `state.get` and `state.set` and relies on reading its own writes.
- **State changes returned with the result** (`{ result, stateDelta }`). This is purely functional, but every tool's return type would change, a string result would need wrapping, and the ADK path would have to unwrap it into `actions`. It also conflicts with `actions.skipSummarization` and `requestConfirmation`, which are side channels in both runtimes anyway.
- **Hand tools ADK's `Context` directly.** No translation would be needed on the ADK path, but the native runtime would have to imitate ADK's class, which keeps ADK's shape in the core after 1.0.0.
- **Keep `defineTool` an identity and add a separate `toTool(contract)`.** This leaves the contract object untouched, but every registry family, the MCP server and consumers would hold two objects per tool. A consumer's `defineTool` result would also not be something the native runtime can run.
- **Name the Tool's method `run` and keep `execute` as the unvalidated handler.** This avoids a dual-purpose `execute`, but the plan and the runtime call the method `execute`, and a `ToolContract` caller already passes raw input through `executeContract`.
- **Keep `toFunctionTool` exported from `toolContract.ts` as a re-export.** No import path would change, but loading `toolContract.ts` would load ADK, and then the native runtime could not use `defineTool` without ADK.
- **Cap every result at 20,000 characters by default.** This is safer for the context window, but `wiki_read` returns up to 40,000 characters and `web_extract` windows its own pages. A default cap would change what the ADK runtime returns today.

## Consequences

- The native loop can run every client-side registry tool through `toolOf(resolveTools(...))` or the Tool itself. Approval and long-running behaviour come with the Tool.
- The ADK runtime runs the same objects as before: `FunctionTool` instances, gated by `lib/compile.ts` as before, with the same interrupts, the same stored events and the same texts.
- Declarations change on every path in three ways. Fields with defaults are optional. A record carries its value schema, including in Gemini's dialect: Gemini's `Schema` type has no `additionalProperties` field, and no registry tool uses a record. The bounds of `ask_user` are integers rather than int64 strings.
- `generate_image` and `inspect_image` now validate their arguments, so a call without a prompt or path returns the readable error instead of calling Gemini. An `ask_user` call with arguments the schema refuses now returns the error to the model. Before, ADK swallowed the throw and paused the turn on the invalid question.
- `melchizedek-agents/tools/toolContract` no longer exports `toFunctionTool`. A consumer imports it from `melchizedek-agents` or `melchizedek-agents/tools/adkTool`. The `exports` map is unchanged. New subpaths, `tools/tool` and `tools/adkTool`, come through its `./tools/*` pattern.
- ADR 0028's gate and ADR 0031's long-running pause still run on ADK's mechanisms on the ADK runtime. Each ADR gets its note when the native runtime takes the mechanism over.
