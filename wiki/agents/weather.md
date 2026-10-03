---
type: syndicate
title: Weather
description: The Weather syndicate.
tags:
  - syndicate
generated:
  by: process:wiki-build
  at: 2026-10-03
sources:
  - resource: config/agents/examples/weather.yaml
---

# Weather

<!-- wiki:fill slot="charter" -->
Weather is the starter pack's specimen of [OpenAPI tools](/tools/openapi-tools.md): an HTTP API as an agent's tools with no tool code. Its one agent, the Forecaster, lists two spec files under `openapi:`, hand-written subsets of Open-Meteo's keyless geocoding and forecast APIs in `examples/specs/`, and each operation becomes a tool: `find_place` turns a name into a latitude, longitude and timezone, and `get_forecast` returns current conditions and the daily forecast. The instruction fixes the order (find, then forecast), the variables to request, and the rule that every figure comes from a tool result in the turn; weather codes are translated to words. Because no `operations` are named, only GET operations are exposed, which is all these specs hold. Copy it to put any API behind an agent: swap in that API's spec, trim it to the operations needed, name write operations explicitly (and under `require_approval` if a person should approve them), and give credentials as environment variables ([ADR 0032](/decisions/0032-openapi-tools.md)). Run `npm run syndicate:weather`.
<!-- /wiki:fill -->

<!-- wiki:generated section="composition" source="config/agents/examples/weather.yaml" -->
Run: `npm run syndicate:weather`

- memory: `internal-only`
- orchestrator: **Forecaster** (`gemini-3.8-flash`) · openapi: `specs/open-meteo-geocoding.json` (GET operations), `specs/open-meteo-forecast.json` (GET operations)

| Subagent | Model | Tools | MCP |
|---|---|---|---|
<!-- /wiki:generated -->
