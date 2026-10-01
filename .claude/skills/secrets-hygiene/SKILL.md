---
name: secrets-hygiene
description: Never emit a secret value — how to inspect presence without printing, the filter shape that cannot leak, and what to do after an exposure. Use BEFORE any task touching .env, a key, a token, or a deployment's config.
---

# Secrets hygiene

A project's `.env` holds provider keys, a database credential and the server's
bearer secrets. **Everything you type into a tool call, and everything it
prints, is permanently in the transcript.** A secret printed once is a secret
rotated; there is no unprinting.

## The rule

**Never emit a secret value.** Not truncated, not "just to check", not inside
an error message, not in a tool result, not in an answer an agent returns.

A value moves from one store to another **without passing through your
output**: capture it into a shell variable, pipe it, or let the target's own
setter carry it. Inspect *presence*, never content — a length and a boolean
answer almost every question you actually have. A short hash prefix tells two
values apart without revealing either.

## The failure mode to expect

The dangerous command is the one whose author believes it prints only
metadata. `cut -d= -f1 .env`, run to list variable *names*, prints every
comment line whole — and a `.env` that keeps an old key in a comment leaks it.

So a filter must be **allowlist-shaped** — print only what matches
`^[A-Z_][A-Z0-9_]*=` and only the part before the `=` — never
denylist-shaped:

```bash
# names and lengths only; comments can never survive this
grep -E '^[A-Z_][A-Z0-9_]*=' .env | awk -F= '{printf "%s  len=%d\n", $1, length($0)-length($1)-1}'
```

## Working rules

- Ask whether the task needs the live credential at all. Most do not.
- Before writing any credential to disk, check the ignore rule:
  `git check-ignore -v .env` — and read the **pattern**, not just the verdict.
  Then `chmod 600`.
- Never back a secrets file up inside the repository.
- A tool must not return a key in an error string (`tool-contract`): a model
  that receives one will quote it back.
- `.env.example` documents **names and shapes** only; keep it current. It is
  the one inventory that is safe to read.
- Test fixtures never look like real keys (`sk-`, `AIza`, `xai-`, `ghp_`…):
  use obviously fake values, so a secret scanner stays meaningful.
- A database service-role key bypasses row-level security. Anything holding it
  is fully privileged; give read-only consumers their own role.

## After an exposure

Own it in the same turn.

1. **Scope it:** which key, where it is used, what it grants, and whether it
   went public (a pushed commit) or private (a transcript).
2. **Find every copy:** local files, deployment config, git history.
3. **Hand the owner the rotation steps.** Creating keys and entering
   credentials is theirs to do.
4. **Close the hole** — a guard, a rule, a safe helper. An apology is not a fix.
