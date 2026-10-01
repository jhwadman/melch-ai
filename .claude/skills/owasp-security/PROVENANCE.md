# Provenance — owasp-security

| | |
|---|---|
| Upstream | `agamm/claude-code-owasp` → `.claude/skills/owasp-security` |
| Upstream commit | `bfaf257b2859986a6a84d2b7491e1fab2218cd53` (2026-07-27) |
| Licence | MIT |
| Executable code shipped | **none** — three markdown files, no scripts, no hooks, no network calls |
| Vendored | 2026-09-20 |

## Upstream file hashes (sha256), as vendored

```
7c7ee6971d977b301585d03ea570a98621f4eebc8bb63b08287ca83b50f6be80  SKILL.md (upstream portion, above the local-addition marker)
94bc74398b993760ed7ef8e871b255a697568fbabb3a7550de115942fa979df6  reference/languages.md
a736352c8886876fbff26850e707ee356db25ab2e7f8df59f65d29e62e58a6fa  reference/owasp-report.md
```

## What was changed

Nothing upstream was edited. `SKILL.md` carries one appended section below the
marker `<!-- LOCAL ADDITION -->`, which says how this general corpus relates to
this repo's own threat model. The reference files are byte-identical.

To re-sync, diff only the portion above the marker:

```bash
git clone --depth 1 https://github.com/agamm/claude-code-owasp /tmp/owasp
sed '/<!-- LOCAL ADDITION -->/,$d' SKILL.md \
  | diff - <(sed -n '1,303p' /tmp/owasp/.claude/skills/owasp-security/SKILL.md)
diff -r reference /tmp/owasp/.claude/skills/owasp-security/reference
```

## Why this one, and what it is not

It is a **knowledge layer with no tooling**: a triage rubric (attacker-controlled
input → reachable sink → blast radius) that exists to suppress the pattern-match
findings that bury real ones, plus per-language quirks for 20-odd languages.
It runs no scanner and proves nothing.

It does not replace this repo's own `security-final-check`, which encodes the
actual threat model and is the gate. This one is the general background the gate
is applied against — reach for it when a change touches authentication, a trust
boundary, untrusted input, or a new external surface, and you want the
standard's framing rather than only the repo's habits.
