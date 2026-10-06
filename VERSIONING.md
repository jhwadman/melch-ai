# Versioning and compatibility

`melchizedek-agents` is **pre-1.0**. This page says what that means for an
upgrade, so you can plan one.

## What a version number tells you

- **Patch (0.17.0 → 0.17.1):** fixes and additions only. No setting,
  default, export or YAML key changes meaning. Upgrade without reading
  more than the CHANGELOG entry.
- **Minor (0.17.x → 0.18.0):** may break things. Every breaking change is
  listed first in the CHANGELOG under **Breaking — read before upgrading**,
  with what to change. A change that makes a deployment refuse to start
  names the fix in its boot message.
- **1.0:** from then on, breaking changes only in a major version.

## What counts as public

The public API is what `package.json`'s `exports` map and the
`lib/index.ts` barrel export, the bins and their environment variables, the
syndicate YAML schema (`config/agents/syndicate.schema.json`), and the SQL
schema in `db/migrations/`. Anything else (file layout under `lib/`,
internal helpers, log wording) can change in any release.

## Deprecation

Where practical, a removal is announced at least one minor release ahead: the
CHANGELOG marks it **Deprecated**, and the code warns at startup or at the
first use. Security fixes are the exception: a default that is unsafe can
change in the next minor without a deprecation period.

## Database migrations

Migrations only move forward and are idempotent. The server refuses to start
against a database behind the migrations it ships and names
`npx melchizedek-db apply`. To undo a migration that succeeded, restore from
backup (DOCUMENTATION §6).

## Which versions get fixes

- **Security fixes** land on the latest minor. When a new minor ships, the
  previous minor also gets security fixes for **30 days**, so you have time
  to plan the upgrade.
- **Other fixes** land on the latest minor only.

## Runtimes and dependencies

- **Node.js:** the active LTS lines, 22 and 24. CI runs both.
- **`@google/adk`** is a peer dependency. The range covers the minor that
  has been tested, and widens only after a release is tested against the
  new one.
