---
type: decision
title: 'ADR 0046: Provider reasoning state rides on the content part it belongs before'
description: An adapter carries provider-opaque reasoning state from one model step to the next as a providerState field on a part the model produced, replayed only by an adapter of the same provider; Claude uses it to replay signed thinking blocks within the turn's tool loop.
tags:
  - decision
  - models
status: stable
generated:
  by: claude-code/claude-opus-5-5
  at: 2026-10-07
sources:
  - resource: lib/models/providerState.ts
  - resource: lib/models/claudeLlm.ts
  - resource: lib/session/transcript.ts
  - resource: tests/reasoningState.test.ts
---

# ADR 0046: Provider reasoning state rides on the content part it belongs before

## Context

Some providers want state back on the next request of a tool loop that only
they can read. Anthropic is the strict case: with thinking on, the assistant
message holding a `tool_use` must open with the signed `thinking` and
`redacted_thinking` blocks the model returned, unmodified, or the request is
rejected. OpenAI and xAI return reasoning items, and Moonshot returns
`reasoning_content`, that they ask to have sent back across tool calls.

The Claude adapter kept the signed blocks in the final event's
`customMetadata['anthropic.thinking']`. ADK builds `LlmRequest.contents` from
each event's `content` alone (`getContents` deep-clones `event.content`), so
the blocks never reached the next request, and the capability matrix marked
thinking with tool use on Claude unsupported (ADR 0019).

## Decision

- **The convention.** A content part may carry
  `providerState: { provider, kind, model?, payload }`
  (`lib/models/providerState.ts`). The adapter that produced the response
  writes it. Only an adapter of the same `provider` replays it, and only the
  `kind` it wrote; every other adapter ignores the field, so a model switch
  between steps drops the state. `model` is set when the provider binds the
  state to the model that produced it, and a reader then skips another
  model's state. `payload` is opaque and replayed verbatim.
- **Claude binds to the model.** Signed thinking is bound to the model that
  produced it, so the Claude adapter writes `model` and replays only its own
  model's blocks: a fallback from one Claude model to another drops them.
- **Placement.** The field rides on a part the model produced: a
  `functionCall` or `text` part, never a part of its own. Claude puts each
  run of signed blocks on the part that follows it in the response and, on
  replay, emits them immediately before that part, so their order relative
  to text and `tool_use` blocks is the order the model produced.
- **Replay scope.** Claude replays signed blocks only on assistant messages
  of the current turn: those after the last user message that is not purely
  tool results. Earlier turns' blocks are left out.
- **An unsigned tool loop.** With a thinking budget configured, a step whose
  pending tool call sits in an assistant message without a signed block
  (another provider or model made the call, or the state was lost) is sent without
  thinking, and the span carries `llm.thinking.omitted`. The forced
  structured-output `tool_choice` rule still follows the agent's configured
  budget.
- **Storage.** `trimEventForStorage` and the session services keep the field
  whole; the transcript projection drops it with the rest of a past turn.
  The `customMetadata['anthropic.thinking']` stash is retired: nothing read
  it, and the same blocks now live on the part.

## Alternatives

- **A part of its own (`{ providerState }`).** `@google/genai` serializes a
  part field by field, so a state-only part reaches Gemini as an empty part
  and the request fails, which matters when a fallback (ADR 0044) or a later
  agent is Gemini. Every chat-completions adapter would also have to learn
  to skip it.
- **Event `customMetadata`.** It is not part of the request ADK builds.
- **An in-process cache keyed by tool call id.** Lost on restart and across
  processes, and absent from the stored session that resuming an approval
  (ADR 0028) replays.
- **Replaying every turn's blocks.** The stored history is not what the
  model saw: tool payloads are elided before storage and plan-dispatch
  projects history. Claude models that bind a thinking block to the
  conversation before it reject such a block, and models that keep earlier
  turns' thinking in context bill it as input. Dropping blocks from the
  front of the history is allowed.
- **Scope Claude's state to the provider alone.** A fallback between two
  Claude models would replay one model's signed blocks to the other, and
  current Claude models ignore blocks another model produced, so the replay
  buys nothing.
- **All blocks at the start of the message.** Correct for the common
  `[thinking, tool_use]` reply, but it reorders blocks when a reply
  interleaves thinking and text.

## Consequences

- Thinking with tool use on Claude is supported, asserted against the
  outgoing request in `tests/capabilityMatrix.test.ts`, and driven through a
  real ADK runner on both the streamed and non-streamed paths in
  `tests/reasoningState.test.ts`.
- The GPT, Grok and Kimi adapters carry their reasoning state through the
  same field under their own provider ids (`openai`, `xai`, `moonshot`).
- Stored bytes are unchanged: the blocks moved from the event to the part.
- Resuming an interrupted turn replays its stored events, whose tool
  payloads over 2,000 characters were elided. A signed block produced after
  such a payload in the same turn no longer matches what preceded it, and
  Claude models that enforce the conversation check reject it.
