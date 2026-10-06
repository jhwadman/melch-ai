## What and why

<!-- One paragraph. Link the issue or the audit item. -->

## Checks

- [ ] `npx tsc --noEmit` and `npm test` pass
- [ ] Tests fail without the change and pass with it
- [ ] Docs and wiki describe the new state (`npm run wiki:check`)
- [ ] CHANGELOG entry for anything a package consumer can see; version bump if the exports map or barrel changed
- [ ] An ADR for a choice between real alternatives
- [ ] No secrets in code, tests, fixtures or logs
