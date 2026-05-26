# @insitue/sdk

## 0.4.18

- **Hotfix: no more "Screenshot unavailable" loops.** Real-world
  dogfooding surfaced a UX dead-end on companion sink: with
  `alwaysPixelPerfect: true` (default) and the user declining the
  tab-share prompt once, EVERY subsequent capture surfaced
  `screenshotUnavailable: "tab capture declined"` with no recovery
  path. Now: layer-1 rasterise runs as a safety net so the user
  gets *something* + a qualityNote pointing at the retry affordance.
- **Retry button now fires on `screenshotUnavailable`**, not just
  `qualityNote`. Previously: when the SDK couldn't get any
  screenshot at all (the worst case), the retry button was hidden
  — gating logic was on `screenshot.qualityNote` which didn't exist.
  Now: any `screenshotUnavailable` mentioning tab capture surfaces
  a "Retry pixel-perfect" affordance regardless of sink.

## 0.4.17

- **Capture telemetry (insitue#10 Phase 1).** Every bundle now ships
  with a `captureDiagnostics` field describing the per-layer attempt
  outcomes (success/blank/error/skipped + duration), the final-output
  blank verdict + score, the crop rect vs picked-element bbox, and
  in-crop content tripwires (video/canvas/iframe/Shadow DOM depth).
  Lets us debug single bad captures in isolation AND aggregate to
  find the patterns driving inconsistent blank screenshots.
- **Schema v4 (additive).** `CAPTURE_SCHEMA_VERSION = 4`. Existing v3
  receivers ignore the new field. Cloud receivers must be on
  `@insitue/capture-core@^0.4.0` (or accept v4 via the
  `ACCEPTED_SCHEMA_VERSIONS` widening) to ingest these bundles.
- **Silent blanks now surfaced.** When the shipped screenshot
  `looksBlank` (the 16-pixel sample heuristic that previously only
  gated layer-2 escalation), the bundle's `screenshot.qualityNote`
  says so — three branches updated. Reviewers no longer see a
  silent blank thumbnail.
- **Layer-2 blank check.** `getDisplayMedia` output now runs through
  the same sample heuristic. Chrome/macOS Sonoma can return all-
  black streams under certain conditions; previously the SDK
  reported `source: "display-media", success`. Now it falls through
  to the degrade path with a `looksBlank` note.
- **Retry button on blank (cloud sink).** End users seeing a blank
  thumbnail get a "Retry pixel-perfect" affordance — fires
  `getDisplayMedia` then re-picks. Dev-sink behavior unchanged.
- **`window.__insitueDebug__ = true`** draws the actual crop rect on
  screen for ~500ms after every capture. Lets a dogfooder
  immediately distinguish "the crop missed the element" from "the
  rasterise was empty." No-op when unset.

## 0.4.16

- **Docs:** added Public API, Stability, Versioning, Security, and
  Tests sections to the README. The package was already well-
  documented for usage; the audit-template gaps were policy + scope
  surfaces consumers need before committing to a pin.
- **Code quality:** each `eslint-disable-next-line` now carries an
  inline justification (browser API gaps in `lib.dom`,
  intentional dev console output, stable-closure dep exclusion).
- **Cleanup:** swept past-tense storytelling and internal references
  from `capture.ts` JSDoc — removed a `~/.claude/plans/...` local-
  machine path leak, removed dated "verified on `<internal-app>`
  YYYY-MM-DD" annotations, and rewrote the "removed feature" comment
  block as a forward-looking explanation of the current design.
- **Metadata:** included `CHANGELOG.md` in the published tarball.

## 0.4.x and earlier

Pre-launch versions — see [git history](https://github.com/InSitue/insitue/commits/main/packages/sdk)
for changes. Real entries start at the next minor bump.
