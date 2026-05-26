# @insitue/sdk

## 0.5.0 — Layer-1-only capture (breaking)

Layer 2 (`getDisplayMedia` tab capture) is gone. The widget now has
ONE capture path: html-to-image rasterise. No permission prompts.
No "tab share declined" dead-ends. No retry buttons. No
"alwaysPixelPerfect" toggle. Every click captures.

When html-to-image can't faithfully capture a region (cross-origin
iframe content, video frames, canvas pixels, non-CORS images), the
existing manual-overlay path inside `renderViewportCrop` shows a
placeholder for that region while the rest of the screenshot still
ships. A `qualityNote` describes what got placeholdered so reviewers
know the capture is structurally complete but visually imperfect on
those specific regions.

### Why

Real-world dogfooding showed the layer-2-first approach (companion
sink default) creates a UX dead-end: decline tab share once and
every subsequent capture produces nothing for 60 seconds. The
permission-based escalation was the dominant source of "the widget
doesn't work" reports. For a product whose core flow rides on the
widget being seamless, that trade was wrong.

Layer 1 covers ~90% of real customer pages cleanly. The remaining
~10% (video/canvas/iframe-heavy pages) get a placeholder for those
specific regions, not a blank screenshot. Pixel-perfect capture of
those regions can be re-introduced behind an explicit opt-in
(browser extension, customer-controlled mount option) in the future
— not as a permission-based escalation in the default flow.

### Breaking changes (no consumers should be using these but they're gone)

- `setCaptureSettings({ alwaysPixelPerfect, disableLayer2 })` —
  module removed. Settings were per-host localStorage and only
  controlled the layer-2 escalation.
- `mountCaptureOnly({ defaultPixelPerfect })` — option removed.
- `onDisplayMediaChange`, `retryDisplayMedia`, `stopDisplayMedia` —
  exports removed.
- `screenshot.source: "display-media"` — never emitted now. Type
  union still allows it for v3/v4 receiver compat.
- `captureDiagnostics.strategy` is now always `"layer1-only"` or
  `"both-failed"`. The other variants in the type union remain for
  schema compat.

### Kept

- `captureDiagnostics` (insitue#11) — still populated, single layer
  entry. Aggregates of failure modes drive Phase 3 fixes.
- `window.__insitueDebug__` crop overlay (insitue#12).
- Manual-overlay fix for next/image (`renderViewportCrop`).
- Schema v4 from capture-core 0.4.0.

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
