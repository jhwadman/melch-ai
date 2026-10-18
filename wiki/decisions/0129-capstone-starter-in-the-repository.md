---
type: decision
title: "ADR 0129: The capstone starter is a repository example using MCP"
description: "The course's capstone starter lives in examples/capstone/ as a dependency-free backend in front of the stock A2A server, with its one tool on an MCP endpoint it serves."
tags:
  - decision
  - agents
  - protocols
status: stable
generated:
  by: claude-code/claude-opus-5-5
  at: 2026-10-18
sources:
  - resource: examples/capstone/server.ts
  - resource: examples/capstone/agent.ts
  - resource: examples/capstone/eval/run.ts
  - resource: config/agents/examples/event_assistant.yaml
  - resource: tests/capstoneStarter.test.ts
---

# ADR 0129: The capstone starter is a repository example using MCP

**Decided (2026-10-13):** The lyceumagents capstone starter lives in `examples/capstone/` (repository only, not the package): a dependency-free `node:http` backend in front of the stock A2A server, serving the agent's one read-only tool over MCP, with `event_assistant` keyless on `ollama/qwen3.5:9b`.

**Instead of:** `demo/capstone/`, an OpenAPI tool on loopback, the event facts in the YAML, Express, `ollama/qwen3:8b`

How it works: [Event Assistant](/agents/event_assistant.md)
