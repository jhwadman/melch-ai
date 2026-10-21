---
type: decision
title: "ADR 0140: End-user feedback is a bearer-guarded A2A route writing adk_labels"
description: "A served syndicate takes a product's thumbs or 1–5 rating of a turn at POST /feedback, behind the same authentication and rate limit as a task, and stores it as an adk_labels row with labeler 'end-user', so every ledger reader sees it beside the turn."
tags:
  - decision
  - a2a
  - observability
status: stable
generated:
  by: claude-code/claude-opus-5-5
  at: 2026-10-20
sources:
  - resource: lib/a2a/feedback.ts
  - resource: lib/a2a/app.ts
  - resource: tests/feedback.test.ts
  - resource: tests/feedbackPostgres.test.ts
---

# ADR 0140: End-user feedback is a bearer-guarded A2A route writing adk_labels

**Decided (2026-10-20):** The A2A server takes end-user ratings at `POST /feedback` and `POST /<agentId>/feedback`, behind the bearer, the authenticator and the task rate limit like a task, with its own 32 KB body limit, the caller's own turns only, and one label per (turn, user) per minute. A rating is an `adk_labels` row with `labeler = 'end-user'`, `fields = { score, userId }` and the redacted comment in `note`: the ledger's existing table for human judgments, keyed by the turn's trace id, which the desktop app, erasure and retention already reach.

**Instead of:** a sibling `adk_feedback` table (a new table, grants and erase step for the same join key); an unauthenticated public endpoint for browsers (spend-free but forgeable; a product's backend relays the click); the A2A message channel (a rating is not a task and must not start one); a shared rate-limit store for the per-turn minute (the task rate limit already bounds the volume across replicas)
**Supersedes:** none
**Open:** a supabase-js feedback store; a per-minute limit shared across replicas; feedback-to-judge agreement (desktop app story 11.4)

How it works: [A2A](/protocols/a2a.md)
