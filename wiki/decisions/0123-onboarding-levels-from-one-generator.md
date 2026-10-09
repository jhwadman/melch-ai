---
type: decision
title: "ADR 0123: Onboarding by authentication level, from one generator, detected by the doctor"
description: "melchizedek-setup routes a newcomer by what they have to one of nine authentication levels and prints a startup guide per level. The levels and guides live once in lib/onboarding.ts; the menu prints them, ONBOARDING.md is generated from the same function and a test holds the two equal. --auto reads the doctor's result rather than the environment. Onboarding skills are hand-written procedures that print the guides, installed to .claude/skills and .agents/skills, with an opt-in AGENTS.md pointer; the repository commits an .agents/skills copy held equal by a test. Consumer subscription sign-ins (ChatGPT / Codex, Claude.ai, Gemini CLI) get an honest entry, not a code path. Hand-written guide docs, a second detector, Scribe-written onboarding skills, an always-on AGENTS.md write, symlinks for the repository copy, and reusing subscription tokens were rejected."
tags:
  - decision
  - operations
  - onboarding
  - skills
status: stable
generated:
  by: claude-code/claude-opus-5-5
  at: 2026-10-09
sources:
  - resource: lib/onboarding.ts
  - resource: scripts/setup.ts
  - resource: lib/doctor.ts
  - resource: lib/skills.ts
  - resource: scripts/skills_install.ts
  - resource: ONBOARDING.md
  - resource: AGENTS.md
  - resource: tests/onboarding.test.ts
---

# ADR 0123: Onboarding by authentication level, from one generator, detected by the doctor

## Context

The engine supports many ways to pay for and secure a model call: local Ollama, five providers' direct keys, a gateway key ([ADR 0012](/decisions/0012-direct-adapters-canonical.md)), Vertex AI, Bedrock and Azure ([ADR 0023](/decisions/0023-bring-your-own-endpoint.md)), per-caller keys and four caller identity modes on the A2A server ([ADR 0025](/decisions/0025-built-in-authenticators.md)), and OAuth grants for tools ([ADR 0112](/decisions/0112-oauth-grants-declared-beside-the-tool.md), [ADR 0114](/decisions/0114-oauth-tokens-go-only-to-hosts-the-operator-binds.md)). The doctor answers "is this file ready?", but a newcomer first asks "I have X: where do I start?", and the answer was spread across README, QUICKSTART, AGENT_SETUP, DOCUMENTATION and `.env.example`. Newcomers also arrive signed in to a consumer subscription (a Codex login, a Claude.ai plan) and expect that to fund the engine.

## Decision

1. **Nine levels, named once.** `lib/onboarding.ts` holds the levels as data: local, one provider, several, gateway, cloud platform, BYOK, caller tokens, OAuth grants, and subscription sign-ins. Each carries its variables (names and shapes, never values), the doctor's confirmation, the first commands per spelling (installed package or clone), notes, and its onboarding skill. The shipped files that run at a level come from the doctor's own tier diagnosis (`diagnoseSyndicate`), so a new template appears in the guides without an edit.
2. **One generator for the menu and the docs.** `renderGuide` is what `melchizedek-setup` prints and what `renderOnboardingDoc` concatenates into `ONBOARDING.md` (`npm run setup -- --markdown`). `tests/onboarding.test.ts` fails when the file differs from the generator, and checks that every variable a guide names is documented in `.env.example`, that every provider key and cloud platform the engine routes to is in a guide, and that every first command's template ships.
3. **Detection is the doctor's.** `--auto` calls `runDoctor` and reads its result: the providers line (now `providers`, `providerPaths()`), the gateway, the cloud endpoints, the OAuth line, and a new `serving` line (`servingReport()`: the `A2A_AUTH` mode, `A2A_KEY_MODE`, which serving variables are set, what the server would stop on). The highest detected level's guide is printed after the names-only detection list. Caller tokens are detected only when `A2A_AUTH` is set explicitly; a bare shared secret is the default, not a level.
4. **`.env` is written only blank and only when ignored.** `--write-env` copies `.env.example` and appends the level's names that the template does not assign, blank, mode 600. It never overwrites an existing `.env` and refuses unless `git check-ignore` confirms the file is ignored, including outside a git repository.
5. **Skills as procedures over the generator.** Five onboarding skills (`melchizedek-onboard` triages, four own the level families) ship in `skills/` and tell the agent to print the guide with `--level`, never to ask for a key in chat or print a value. They are hand-written, not Scribe-written ([ADR 0014](/decisions/0014-agent-skills-suite.md)): their facts are the generator's, so a brief would be a second copy of them.
6. **Where agents find them.** `melchizedek-skills install` already writes `.claude/skills/` and `.agents/skills/`, the shared location Codex, Cursor, OpenCode and Gemini CLI read; that stays the default. `--agents-md` additionally writes a marker-delimited pointer block into the project's `AGENTS.md`, creating it when absent and afterwards rewriting only between the markers. This repository commits `.agents/skills/` (the installer's copy of the onboarding skills) and a contributor `AGENTS.md` pointing at `CLAUDE.md` and `.claude/skills/`; a test holds the copy byte-equal to `skills/`.
7. **Subscription sign-ins are an entry, not a path.** Level 9 says what is and is not supported and routes to each vendor's API key or cloud platform. The engine reads, reuses and relays no ChatGPT / Codex, Claude.ai or Gemini CLI token: Anthropic's and Google's terms forbid third-party use of those sign-ins, and OpenAI's Sign in with ChatGPT plan-usage flow is a preview for eligible apps that the engine has not integrated. The level is never detected.

## Alternatives considered

- **Hand-written guides in DOCUMENTATION.md.** Cheapest, and exactly the drift the doctor was built to end: five documents already restated the keys. A generated file with an equality test cannot drift.
- **A second detector reading the environment in the setup command.** It would duplicate the rules for "funded" (placeholders, `GEMINI_API_KEY`, cloud platforms that need no key, gateway fallback) and could disagree with the doctor. Reading `runDoctor` costs one more line in the doctor (`serving`) and keeps one truth.
- **Scribe-written onboarding skills from briefs.** The suite's other skills are, but these would restate variables and commands that already live in the generator, and a brief would be a third copy. Procedures that print the guide stay correct when a level changes.
- **Write AGENTS.md on every install.** It is the user's own instructions file; an installer that edits it unasked surprises them. The skills are discovered from the skills directories without it, so the pointer is opt-in and confined to its markers.
- **Symlink `.agents/skills/` to `skills/` in the repository.** No drift, but symlinks are unreliable on Windows checkouts and the installer itself refuses to follow them. A committed copy with a test is portable and fails loudly.
- **Reuse subscription OAuth tokens (read the Codex CLI's `auth.json`, the Claude Code keychain entry, Gemini CLI's credentials).** It would let a newcomer start without an API key, but it violates Anthropic's and Google's terms, risks the user's account, and is not OpenAI's sanctioned flow either. Integrating OpenAI's documented plan-usage flow is left as an open question for the owner.

## Consequences

- `npx melchizedek-setup` is a new bin (a package surface change, recorded in the CHANGELOG) and `ONBOARDING.md` ships in the package.
- `DoctorResult` gains `providers` and an optional `serving`; `npm run doctor` prints a `serving` line when any A2A identity or billing variable is set. `--json` consumers see the new fields.
- A new level, variable or platform is a change to `LEVELS` and a regenerated `ONBOARDING.md`; the test names the command.
- The onboarding skills' wording is reviewed by hand; the Scribe procedure does not cover them.
