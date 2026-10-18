---
type: decision
title: "ADR 0034: Self-correction on by default; url_context and examples join the agent surface"
description: "A malformed model reply and a throwing tool are retried with guidance by default, tunable or off through retries:; url_context is safe to declare on any provider; examples: adds few-shot pairs from YAML."
tags:
  - decision
  - runtime
  - tools
status: stable
generated:
  by: claude-code/claude-opus-5-5
  at: 2026-10-18
sources:
  - resource: lib/runtime/syndicateTurn.ts
  - resource: lib/tools/urlContextTool.ts
  - resource: lib/compile.ts
  - resource: tests/selfCorrection.test.ts
---

# ADR 0034: Self-correction on by default; url_context and examples join the agent surface

**Decided (2026-10-02):** Self-correction is on by default: a malformed model reply and a throwing tool are retried with guidance, and a root `retries:` key tunes or turns off either. `url_context` is a registry tool that is safe to declare on any provider, and `examples:` adds few-shot pairs from YAML.

**Instead of:** retries off by default, ADK's `URL_CONTEXT` as it ships, examples only in instruction prose
**Superseded by:** [ADR 0075](/decisions/0075-native-self-correction-ports-adk-plugins.md) (the native loop does the retries in place of ADK's plugins)

How it works: [Native loop](/overview/native-loop.md)
