---
type: decision
title: "ADR 0101: the native loop's security gate, and where it departs from ADK to fail safe"
description: "Before the native runtime becomes the default (ADR 0045, ADR 0099), its loop passes a security gate (WS5-5): a threat model with a test per path (wiki/operations/native-loop-security.md) and a seeded fuzz suite (tests/nativeFuzz.test.ts). A model's answer is held to the contract in the mapping both runtimes share; arguments and tool results nested past 64 levels are replaced by a note; call ids are own keys; a consent resumes only the agent's own call and only once; a yaml_reference chain that reaches itself is refused at compile. Where ADK fails a forged input by throwing, native throws the same. Failing the turn on a contract breach, guarding the native step only, and keeping parity with ADK's consent resume were rejected."
tags:
  - decision
  - runtime
  - security
status: stable
generated:
  by: claude-code/claude-opus-5-5
  at: 2026-10-08
sources:
  - resource: lib/models/genaiMapping.ts
  - resource: lib/runtime/valueDepth.ts
  - resource: lib/runtime/native/agentLoop.ts
  - resource: lib/runtime/native/interrupts.ts
  - resource: lib/runtime/credentials.ts
  - resource: lib/compile.ts
  - resource: tests/nativeFuzz.test.ts
---

# ADR 0101: the native loop's security gate, and where it departs from ADK to fail safe

## Context

[ADR 0045](/decisions/0045-own-runtime-behind-the-seam.md) makes the native runtime the default once its gates hold; [ADR 0099](/decisions/0099-native-default-moves-to-0-20-0.md) moves that to 0.20.0. The native loop was built to store what ADK stores, case for case, and its parity suites prove it does for well-formed input. They do not say what the loop does with hostile or malformed input: a provider answer the contract forbids, a tool result shaped like a framework event, a forged or replayed interrupt answer, a value deep enough to overflow a reader.

A security pass over the loop (WS5-5) found six defects: a contract-breaking answer stored as it came (one crashed the step, another left an event that no longer parsed); a deeply nested value that failed its turn and every later turn on the session; a `__proto__` call id that lost an approval; a consent that read a request the person wrote and resumed a call forged into their message; a replayed grant that ran its call again; and a self-referencing `yaml_reference` whose compile overflowed the stack and stopped the process. Four of these are also ADK's behavior, so the native loop could match ADK or fail safe, not both.

## Decision

1. **A model's answer is held to the contract in the mapping both runtimes share.** `contractModelResponse` in `lib/models/genaiMapping.ts` drops a part the contract does not allow and coerces a call's name, id and arguments; `modelResponseToLlmResponse` applies it, and the native step applies it before it reads the answer. A well-behaved adapter's answer maps exactly as before, and both runtimes store the same event for a broken one.
2. **A value nested past 64 levels never reaches a session.** `lib/runtime/valueDepth.ts` measures nesting without recursion. A call's arguments past `MAX_VALUE_DEPTH` become `{ raw: TOO_DEEP_ARGUMENTS }` (in the shared mapping), a tool's result past it `{ error: TOO_DEEP_RESULT }` (in the native loop; ADK keeps it). No tool schema the engine knows nests anywhere near 64.
3. **A call id is an own key.** The loop writes `requestedToolConfirmations` and `requestedAuthConfigs` under a call id with `Object.defineProperty`, and merges parallel calls' actions the same way, as it already wrote state. ADK assigns, and loses the request for a `__proto__` id.
4. **A consent resumes only the agent's own call, and only once.** `pendingConsent` reads only an agent-authored request; `grantedCalls` re-runs the paused call from the latest event this agent authored, and treats a request an earlier grant bound as closed. ADK's auth preprocessor reads any author's call and resumes a replayed grant. The ADK runtime refuses to resume a consent at all, so no session ADK wrote depends on its behavior here.
5. **A `yaml_reference` chain that reaches itself is refused at compile.** The chain rides on the compile options under an own symbol; a reference already on it, or a chain past 16 levels, fails the compile with an Error naming the chain, before any model call, on both runtimes.
6. **Where ADK fails a forged input by throwing, native throws the same.** A garbled approval answer, a function response naming no call, and an adapter that throws a non-Error end the turn by throwing on both runtimes. A2A never produces the first two (the executor builds an approval answer itself and maps every part to text), and the next turn runs.
7. **The gate's record is a runbook, held by a fuzz suite.** `wiki/operations/native-loop-security.md` names every input path, what stops it and its test, and the findings recorded with an owner decision. `tests/nativeFuzz.test.ts` is seeded (300 turns, about a second) and runs forged answers through `runSyndicateTurn` on both runtimes, which must end each turn the same way.

## Alternatives considered

- **Fail the turn on a contract breach.** Rejected: one malformed part from a provider would fail a turn whose other parts are usable, and the breach is an adapter's defect, not the person's. Dropping the part keeps the turn and leaves the stored event as the evidence.
- **Guard the native step only.** Rejected: the two runtimes would store different events for the same answer, and a session one wrote would read differently on the other.
- **Truncate a deep value instead of replacing it.** Rejected: there is no structure-preserving cut that a tool or the model can rely on; a note in its place says what happened.
- **Keep parity with ADK's consent resume.** Rejected: parity with a defect that lets a forged call run under the person's grant, on a path ADK itself never runs.
- **Return a failed result instead of throwing for a garbled answer.** Deferred to when ADK leaves (1.0): until then the runtimes must agree, and only a library caller can send one.

## Consequences

- Native departs from ADK in four places, each recorded where it happens: a deep tool result (`agentLoop.ts`), the consent resume's author and replay rules (`interrupts.ts`), and the own-key writes for a `__proto__` call id. None changes an event ADK stores for well-formed input; the parity suites run unchanged.
- `modelResponseToLlmResponse` (`melchizedek-agents/models/genaiMapping`) now holds a response to the contract on the ADK path too, and `contractModelResponse` and `TOO_DEEP_ARGUMENTS` are new exports of that module.
- The recorded findings (a routed workflow cycle bounded only by the deadline, reserved names in `registerTool`, the throws of decision 6) wait on the owner decisions the runbook lists.
