# @insitue/capture-core

## 0.4.0

- **Schema v4 (additive).** `CAPTURE_SCHEMA_VERSION` bumped 3 → 4
  with a new optional `captureDiagnostics` field on `CaptureBundle`.
  Existing v3 receivers ignore it cleanly.
- New `CaptureDiagnostics` + `CaptureLayerAttempt` types describing
  per-layer screenshot attempts (outcome / duration / error), final-
  output blank verdict + score, crop vs element bbox, content-type
  tripwires (video/canvas/iframe/shadowDOM), pixel ratio used, embed
  failure count. Designed for the InSitue/insitue#10 telemetry-first
  investigation of inconsistent blank screenshots.
- Cloud-side receivers that pin `ACCEPTED_SCHEMA_VERSIONS` should
  bump the capture-core dep to ^0.4.0 BEFORE the SDK bumps to ship
  v4 bundles — otherwise the new bundles will 422 against the old
  accept set `{3, 2}`.

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
