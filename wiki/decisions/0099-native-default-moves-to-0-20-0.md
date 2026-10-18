---
type: decision
title: "ADR 0099: 0.19.0 ships native as an opt-in; the native default moves to 0.20.0"
description: "Release 0.19.0 shipped the native runtime as an opt-in, and the native default moved to 0.20.0."
tags:
  - decision
  - runtime
  - release
status: deprecated
generated:
  by: claude-code/claude-opus-5-5
  at: 2026-10-18
sources:
  - resource: CHANGELOG.md
  - resource: package.json
  - resource: lib/runtime/runtimeFlag.ts
---

# ADR 0099: 0.19.0 ships native as an opt-in; the native default moves to 0.20.0

**Decided (2026-10-08):** 0.19.0 shipped the native runtime as an opt-in, with the native default moved to 0.20.0 behind gate G3 and ADR 0045's stop rule.

**Superseded by:** [ADR 0102](/decisions/0102-native-default-and-optional-adk-peer.md), [ADR 0107](/decisions/0107-release-1-0-0-removes-adk.md)
