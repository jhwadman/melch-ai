---
type: decision
title: "ADR 0010: A judgment counts only with a confidence interval, human check and hash"
description: "Verdicts are persisted with provenance, judges are calibrated against human labels before gating, every number carries uncertainty, and the deploy step consults a gate."
tags:
  - decision
  - evals
  - observability
status: stable
generated:
  by: claude-code/claude-opus-5-5
  at: 2026-10-18
sources:
  - resource: db/telemetry.sql
  - resource: lib/runtime/syndicateTurn.ts
---

# ADR 0010: A judgment counts only with a confidence interval, human check and hash

**Decided (2026-08-22):** Five rules: bootstrap confidence intervals on every number, judges calibrated against human labels (Cohen's kappa) before they may gate, additive provenance-stamped verdicts, order-swapped pairwise comparisons, and a deploy gate; the harness that applies them lives in a separate evaluation repository, this one ships the tables.

**Instead of:** uncalibrated LLM judges, absolute scores without uncertainty
**Open:** replay with recorded tool responses has no hook on the native runtime (`transformAgent` is refused since 1.0.0)

How it works: [Setup paths](/operations/setup.md)
