---
type: decision
title: "ADR 0086: A skill script runs with a minimal environment the YAML extends by name, and its output is capped"
description: "WS3-3b answers ADR 0083's open questions 1 and 2. An approved run_skill_script starts from an allowlist the interpreter needs (PATH, HOME, temp, locale, the Windows essentials) plus the names the agent's YAML lists under skills.env; a secret-shaped name is refused there and accepted only under a separate skills.secret_env list. stdout and stderr are each kept to 20,000 characters, with a marker. Inheriting and scrubbing by a denylist, a per-entry secret flag, refusing secret names outright, and a configurable cap were rejected."
tags:
  - decision
  - tools
  - security
status: stable
generated:
  by: claude-code/claude-opus-5-5
  at: 2026-10-08
sources:
  - resource: lib/tools/skills/env.ts
  - resource: lib/tools/skills/executor.ts
  - resource: lib/tools/skills/tools.ts
  - resource: lib/tools/skillToolset.ts
  - resource: lib/syndicateSchema.ts
  - resource: tests/skillScriptEnv.test.ts
---

# ADR 0086: A skill script runs with a minimal environment the YAML extends by name, and its output is capped

## Context

[ADR 0083](/decisions/0083-skills-harness-on-the-own-tool-base.md) ported ADK's local executor with its limits unchanged, and left two questions open. First, an approved `run_skill_script` ([ADR 0029](/decisions/0029-skills-read-like-a-harness.md)) inherited the server's whole environment, so a script could read every provider key, `DATABASE_URL` and the server's bearer secrets. A model chooses a script's arguments, so a model steering a script could too. Second, stdout and stderr were collected whole, so one script could flood the next model request and the server's memory. The approval of each run is a control on *whether* a script runs; it says nothing about what the run can read, and a person approving `scripts/report.py --month 9` does not expect it to hold the gateway key.

## Decision

1. **A script starts from an allowlist, not from `process.env`.** `scriptEnvironment` (`lib/tools/skills/env.ts`) copies only what an interpreter needs to start and behave normally: `PATH`, `HOME`, `USER`, `LOGNAME`, `TMPDIR`, `TEMP`, `TMP`, `LANG`, `LANGUAGE`, `TZ` and every `LC_*`, and on Windows `USERPROFILE`, `USERNAME`, `SystemRoot`, `SystemDrive`, `windir`, `ComSpec`, `PATHEXT`, `HOMEDRIVE`, `HOMEPATH`, `APPDATA`, `LOCALAPPDATA`, `ProgramData`, the `ProgramFiles` and `CommonProgramFiles` family, `NUMBER_OF_PROCESSORS`, `PROCESSOR_ARCHITECTURE` and `OS`. None of them holds a secret, which a test holds.

2. **The YAML extends it by name, under `skills.env`.** An array of variable names, never values, each matching `^[A-Z_][A-Z0-9_]*$`. A listed name the server does not have is absent. The names apply to the agent's skills as a whole, since the YAML declares skills per agent and a script cannot be told apart from its skill's other scripts at review time.

3. **A secret-shaped name is accepted only under `skills.secret_env`.** `skills.env` refuses a name that looks like it holds a secret, with a message pointing at `secret_env`; `secret_env` takes the same names without that check. A name is secret-shaped when one of its underscore-separated segments is a credential word (`KEY`, `TOKEN`, `SECRET`, `PASSWORD`, `PASS`, `PWD`, `CREDENTIAL`, `AUTH`, `BEARER`, `COOKIE`, `SESSION`, `PRIVATE`, `SIGNATURE`, `SALT`, `HEADERS`, `DSN`, `DATABASE`, `REDIS`, `CONNECTION`, plurals and short forms), or it contains `SECRET`, `TOKEN`, `PASSWORD`, `PASSWD`, `APIKEY`, `CREDENTIAL` or `PRIVATE`. The check is deliberately broad, covers every credential in `.env.example`, and compares strings with no regular expression, so nothing backtracks. Both lists need `scripts: local`.

4. **stdout and stderr are each capped at 20,000 characters.** `CappedText` keeps the first 20,000 characters of a stream and counts the rest without holding it. A cut stream ends with `[stdout truncated: N more characters not shown (the limit is 20000)]`. The engine's own lines (a process error, the timeout notice) follow the capped stderr, so they are never cut. Streams are decoded as UTF-8 across chunk boundaries. The limit is a constant (`SCRIPT_OUTPUT_CHAR_LIMIT`), with an executor option for tests and adopters who build their own executor.

5. **One executor, so one behaviour.** The change is in `LocalScriptExecutor`, which both runtimes share; an end-to-end test runs an approved script on each.

## Alternatives considered

- **Inherit and scrub with a denylist.** It keeps more scripts working unchanged, but it fails open: any secret under a name the list did not foresee crosses, and the server's environment is the operator's, not the engine's, to enumerate.
- **A per-entry flag (`env: [{ name, secret: true }]`).** One list instead of two, but a flag inside an entry is easy to miss in review, and the plain-string list is the shape every other name list in the YAML has. A separate `secret_env` makes "this agent's scripts hold a credential" a line a reviewer can grep for.
- **Refuse secret-shaped names outright.** Safest, but a skill that calls an API with its own token would then have no way to run, and an operator would work around it with a renamed variable, which hides the credential from the check entirely.
- **Base the check on the doctor.** The doctor reports provider funding by known names and has no general secret pattern; the redaction patterns in `lib/observability/redact.ts` match values, not names. The pattern lives with the executor and the schema imports it.
- **Make the cap a YAML key.** No skill in view needs more, and every knob on the YAML is a review surface. It can be added with its own record if one does.
- **Cap by bytes.** The model reads characters, and a byte cut can split a character. Characters bound memory to the same order.

## Consequences

- **Breaking for a script that relied on an inherited variable.** It must be named under `skills.env` or `skills.secret_env`. The CHANGELOG says so.
- `NODE_OPTIONS`, `PYTHONPATH`, proxy variables and the like no longer reach a script unless listed.
- A model never reads more than about 40,000 characters of script output per run, plus output files, which keep their 8 MiB per-file bound.
- The script still runs as the server's user with its file and network access: the environment is the part this record closes, not a sandbox.
