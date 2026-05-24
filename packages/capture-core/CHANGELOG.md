# @insitue/capture-core

## 0.3.5

- Docs: rewrote README to the OSS-readiness template — install, 30-second
  usage, full public API surface, stability, versioning policy, security,
  tests.
- Docs: added one-line JSDoc to every public WS envelope type and the
  `ClientMessage` / `ServerMessage` discriminated unions.
- Internal: renamed misleading `toLoc` parameter (`workspaceCwdRelative`
  → `src`); the value has never been cwd-relative.
- Metadata: added `keywords`, `homepage`, `bugs` to `package.json` for
  npm/GitHub discoverability.

## 0.3.x and earlier

Pre-launch versions — see [git history](https://github.com/InSitue/insitue/commits/main/packages/capture-core)
for changes. Real entries start at the next minor bump.
