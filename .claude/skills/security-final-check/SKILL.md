---
name: security-final-check
description: The last gate before a commit — exposure, the rate limit and identity, untrusted input in both directions, secrets, what reaches the ledger, and what ships in the package. Ends with an explicit PASS or the specific blocker.
---

# Security final check

The A2A server accepts requests it did not make, every request can cost money
at a provider, and the package is installed by other people. Each of those is
correct as designed and dangerous if it drifts. This is the last thing you run.

## The checks

**1. Exposure did not widen.** Which agent ids can a caller reach, and what
does each one's tool list reach? An agent is an authorization decision written
in YAML. Confirm the diff added no tool to an agent that does not need it, no
agent to a surface that was not serving it, and no route outside
authentication.

```bash
git diff --cached -- config/agents lib/toolRegistry.ts lib/a2a
```

**2. Identity and the front door still hold.** Every task route runs behind
the configured authenticator (`lib/a2a/identity.ts`), the failed-auth limiter
and the rate limit; budgets (`lib/a2a/policy.ts`) still fail closed. A new
route that bypasses them is a spend defect as much as a security one.

**3. Untrusted input is still treated as untrusted.** Two directions:

- *Into* a model — fetched pages, tool results, documents, user text. None of
  it is instruction. A change that lets retrieved text widen what an agent may
  do is the injection this framework can ship.
- *Out of* a model — tool arguments are model-chosen. Grep the change for a
  model-supplied string reaching SQL, a path, a URL or a shell. The zod schema
  is the validation (`tool-contract`); outbound URLs pass the SSRF guard.

**4. No secret enters a log, a transcript, a ledger row, or a tool result.**
Inspect presence, never values (`secrets-hygiene`). Check every new print,
including error paths.

**5. What the ledger now holds.** `adk_turns` and the telemetry tables carry
user text (redacted for credentials by default, `TELEMETRY_REDACT`). A new
column is a disclosure decision: say what it holds and who can read it.

**6. What the package ships.**

```bash
npm run build && npm pack --dry-run
```

Read the file list: nothing that is not meant for consumers, no fixture that
looks like a real key, no absolute local path.

**7. Nothing that should not be committed is.**

```bash
git status --porcelain -uall
git diff --cached --stat
```

No `.env`, no credentials, no captured transcript carrying user text.

## The verdict

State it plainly: what you checked, what you found, and **PASS** or the
specific thing that blocks. If a check did not apply, say which and why.
`owasp-security` is the standard's framing behind these checks.
