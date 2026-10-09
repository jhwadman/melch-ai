---
name: melchizedek-onboard-serve
description: "Onboard an operator who will serve Melchizedek agents to other people or backends over A2A: who pays for model calls (the server's keys or each caller's own, BYOK), who a caller is (A2A_AUTH: caller tokens, JWT, a gateway header, or one shared secret), the public-URL posture, and OAuth tool grants that act for each end user. Use when someone asks to deploy or expose the server, to let customers bring their own key, to issue tokens to calling backends, or to connect a tool to a user's third-party account."
---

## The levels

| Level | Id | Settles |
|---|---|---|
| 6 | `byok` | callers fund their own model calls with `X-API-Key` and `X-Provider` |
| 7 | `caller-tokens` | who a caller is: `A2A_AUTH=callers`, `jwt`, `header` or `secret` |
| 8 | `oauth-grants` | tools that send a third-party token for each end user |

They sit on top of a model level (1 to 5): settle how the server's own models are paid for first. Print a guide with `npx melchizedek-setup --level <id>` (in a clone, `npm run setup -- --level <id>`).

## Identity first (level 7)

1. Pick the mode with the operator. Prefer `callers` (one token per calling backend) or `jwt` (their identity provider) on anything public. `header` is for an authenticating gateway in front. `secret` is one shared secret: any holder can act as any user.
2. For `callers`, mint a token per backend so it never lands in a transcript:

   ```bash
   npx melchizedek-serve --new-caller my-backend --token-file "$HOME/my-backend.token"
   ```

   It writes the token to a new mode-600 file and prints only the `A2A_CALLERS` entry, which holds the token's SHA-256. The operator adds that entry to `.env`, moves the token into the calling backend's secret store, and deletes the file. Do not run `--new-caller` without `--token-file` in an agent session.
3. On a public deployment, `PUBLIC_URL` makes the server refuse to start until `A2A_AUTH`, `A2A_SERVED_AGENTS` and `A2A_TRUST_PROXY` are set explicitly. That is intended; set them, do not work around it.
4. Run `npx melchizedek-doctor`: the `serving` line names the mode and, with a ✗, any variable the server would stop on.

## Who pays (level 6)

`A2A_KEY_MODE=byok` makes each caller's `X-API-Key` fund agents on the provider named by `X-Provider`. Agents on other providers, tools and memory extraction still use the server's keys. Under `A2A_AUTH=secret` only, byok also scopes data by a hash of the caller's key; with caller tokens or JWTs, the identity scopes data and byok only pays.

## OAuth tool grants (level 8)

1. The operator generates the sealing key themselves (`openssl rand -base64 32`) and types it into `MELCHIZEDEK_CREDENTIAL_KEY`. It must stay out of the database and its backups.
2. `OAUTH_REDIRECT_URI` is the https callback registered at every provider, with no query string.
3. `MELCHIZEDEK_OAUTH_HOSTS` binds each provider to the hosts its tokens may reach (`provider=host,host;provider=host`). Unset, authorization-code grants are refused.
4. The default callback identity (`OAUTH_CALLBACK_IDENTITY=required`) needs `A2A_AUTH=header` behind a gateway; `state` relaxes it, and a forwarded consent link can then connect the wrong account. Say so before choosing it.
5. Each grant's client id and secret come from variables the YAML names; the doctor lists them by name for every `⚿` line. `systems_operator` carries a commented `mcp_auth` block to start from.

## Done when

The doctor's `serving` (and, for level 8, `oauth`) lines show no ✗, the server starts, and one authenticated call answers: `node demo/a2a_demo.mjs` is a two-turn client for the secret mode.
