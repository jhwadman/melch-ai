---
type: decision
title: "ADR 0132: Local MCP servers run over stdio from an mcp_servers entry's command, only when the operator lists the command, with the environment named by the entry"
description: "An mcp_servers entry gives url or command. A command entry (args, env, pass_env, cwd) is started over the MCP SDK's stdio transport, one process per distinct spec reused by every compile, and its tools go through the same declaration and result bounds as a remote server's. It runs only when MELCHIZEDEK_STDIO_MCP lists the exact command; the child gets the SDK's minimal environment plus pass_env by name and literal env, and a credential-looking env key is refused at load. Allowing any command, passing the whole environment, a per-turn process and a separate stdio key on the agent were rejected."
tags:
  - decision
  - protocols
  - tools
status: stable
generated:
  by: claude-code/claude-opus-5-5
  at: 2026-10-15
sources:
  - resource: lib/tools/mcpToolFactory.ts
  - resource: lib/syndicateSchema.ts
  - resource: lib/compile.ts
  - resource: lib/loadSyndicate.ts
  - resource: tests/mcpStdio.test.ts
---

# ADR 0132: Local MCP servers run over stdio from an mcp_servers entry's command, only when the operator lists the command, with the environment named by the entry

## Context

The MCP client reached servers over Streamable HTTP or SSE only (ADR 0124). Most MCP servers people install are local programs spoken to over stdio (`npx -y <server>`, `uvx <server>`), and the engine's own `melchizedek-mcp` serves stdio. A desktop application embedding the engine needs its users to add such servers. Starting a program is a larger power than calling a URL: it is code execution on the host, and the program inherits whatever environment it is given.

## Decision

1. **`mcp_servers` entries take `url` or `command`.** A command entry adds `args`, `env` (non-secret literals), `pass_env` (names of the engine's variables to copy in) and `cwd` (relative to the YAML file, as an OpenAPI spec is). It takes no `transport` or `auth`, and a url entry takes none of the command keys; the loader refuses each by key path. `tools` stays required: the agent gets only the tools the entry names.
2. **The operator allows each command.** `MELCHIZEDEK_STDIO_MCP` is a comma-separated list of exact `command` values. A command not on it fails the compile, naming the variable. It is read at each connect, so an embedding application sets it as its user approves a server. This is the same shape as `MELCHIZEDEK_OAUTH_HOSTS` and `MELCHIZEDEK_CREDENTIAL_HOSTS` (ADR 0114, ADR 0122): YAML can come from a registry, so YAML alone never grants a new power.
3. **The child's environment is named, not inherited.** It gets the MCP SDK's default set (PATH, HOME and the like), then each `pass_env` variable from the engine's environment, then `env`. An unset `pass_env` name fails the compile, naming the variable and no value. An `env` key that names a credential (KEY, TOKEN, SECRET, PASSWORD, CREDENTIAL, AUTH) is refused at load: its value belongs in the engine's environment, passed by name.
4. **One process per spec, for the life of the engine.** The engine compiles an agent every turn; a process per turn would cost a start-up each time and leak children. Connections are kept by the exact spec (command, args, env, pass_env names, cwd); a server that exits is started again by the next compile that needs it; `closeMcpConnections()` ends them all. A server that cannot start, or cannot list, yields no tools and a warning naming the entry and the last lines of its stderr, as an unreachable remote server does.
5. **One tool mapping for every transport.** A stdio server's tools are made by the same `listedTool` as a remote server's: the declaration bounded at 1,000 characters, results at 20,000, errors returned as `[MCP ERROR]` text. Its results are data, never instructions.

## Alternatives rejected

- **Run any command the YAML names.** Registry-stored YAML would then be remote code execution on the server.
- **Pass the engine's whole environment.** Every provider key and database URL would reach a third-party program.
- **A process per turn.** Start-up on every message and a child left behind by each compile.
- **A separate agent key (`mcp_stdio:`).** `mcp_servers` already carries the per-server tool list, uniqueness rules and approval gates; a second list would repeat them.

## Consequences

- `ALLOW_PRIVATE_MCP` and the SSRF guard do not apply to stdio entries; the allowlist does.
- A stdio server holds whatever its `pass_env` gives it for as long as the engine runs.
