# @insitue/companion

## 0.4.4

- **Fix (`insitue connect`):** the CLI hardcoded `PROTOCOL_VERSION = 2`
  while the wire protocol has been at 5 since the agent edit-loop +
  session undo + agent-activity work landed. The subscriber CLI would
  be rejected at the handshake with "protocol 5 required" on every
  attempt. Now imports `PROTOCOL_VERSION` from `@insitue/capture-core`
  (same source of truth `server.ts` uses), so a future bump can't
  re-introduce the drift.
- **Docs:** rewrote the README to add Public API (the programmatic
  `startCompanion()` surface), Stability, Versioning, Tests, Security
  sections, and an explicit `@insitue/agent-core` (closed-source)
  dependency disclosure so OSS readers know which part of the loop
  isn't auditable in this repo.
- **Comments:** swept an unresolved "NOTE (M1):" futurism out of
  `server.ts` token-delivery commentary and rewrote it as a clean
  description of the actual trust model.
- **Metadata:** added `keywords`, `homepage`, `bugs` to `package.json`;
  explicitly included `README.md`, `LICENSE`, and `CHANGELOG.md` in
  the published tarball (previously relying on npm's implicit
  inclusion).
- Bumped 0.4.3 → 0.4.4.

## 0.4.x and earlier

Pre-launch versions — see [git history](https://github.com/InSitue/insitue/commits/main/packages/companion)
for changes. Real entries start at the next minor bump.
