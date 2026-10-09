# AGENTS.md

Instructions for coding agents (Codex, Cursor, OpenCode, Gemini CLI, Claude
Code) working in this repository, the source of the `melchizedek-agents`
engine and npm package.

- **Contributing to the engine:** read `CLAUDE.md` first. It sets the
  mandatory workflow for every change, and its skills live in
  `.claude/skills/` (`wiki-first`, `package-surface`, `secrets-hygiene`,
  `sync-wiki`, `security-final-check` and the rest). They apply to every
  agent, not only Claude Code.
- **The shipped skill suite** is `skills/` (it ships in the package and
  `npx melchizedek-skills install` copies it into a user's project).
- **Onboarding a user** (which keys, which level): `.agents/skills/` holds
  the onboarding skills, a copy of `skills/melchizedek-onboard*` that
  `tests/onboarding.test.ts` keeps identical. Start with
  `melchizedek-onboard`, or run `npm run setup -- --auto`.

<!-- melchizedek-skills:begin -->
## Melchizedek agent skills

The melchizedek-agents skills are installed in `.agents/skills/`, one directory per skill with a SKILL.md.
To onboard someone, start with `melchizedek-onboard/SKILL.md`, or run `npx melchizedek-setup --auto`.
Never ask for an API key in chat and never print a value from `.env`: the person types keys into `.env` themselves.
<!-- melchizedek-skills:end -->
