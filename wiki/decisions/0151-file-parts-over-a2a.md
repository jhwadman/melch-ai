---
type: decision
title: "ADR 0151: The A2A server takes inline files, within a size limit and what the model reads"
description: "A2A file parts with inline bytes become blob or text parts when the agent's model reads the type, by one table (attachmentSupport); A2A_MAX_FILE_BYTES (default 10 MiB) bounds a message and sizes the body limit; a file by URL stays refused, and the server converts nothing."
tags:
  - decision
  - a2a
  - models
status: stable
generated:
  by: claude-code/claude-opus-5-5
  at: 2026-11-01
sources:
  - resource: lib/models/attachments.ts
  - resource: lib/a2a/executor.ts
  - resource: tests/filePartsA2a.test.ts
---

# ADR 0151: The A2A server takes inline files, within a size limit and what the model reads

**Decided (2026-11-01):** The refusal of file parts named a missing size policy; this is the policy. `a2aPartsToMessage` takes inline bytes (`raw`, or 0.3's `file.bytes`) up to `A2A_MAX_FILE_BYTES` a message, default 10 MiB, and 0 restores the refusal. Text types go as a text part, types the agent's orchestrator model reads go as blobs, and anything else ends `rejected`, naming what it does read. One table, `attachmentSupport(model)`, says what each path takes and how large, so a caller that converts first (the desktop app) and this server cannot disagree. The body limit defaults to what holds that many bytes as base64, about 15 MB rather than 1 MB; it is parsed before authentication, as it was, and `A2A_BODY_LIMIT` still overrides it.

**Instead of:** fetching a file by URL (an SSRF surface, so still refused); off by default (the protocol would still not take files without an operator's setting, though a server off loopback already needs a credential); converting on the server (images need a native library the package deliberately lacks, so the conversion lives with the caller that has one: the app uses Chromium's)
**Open:** the transport's own limit on a deployed host; files for a subagent (only the orchestrator's message carries them, and the orchestrator's model decides what is read)
