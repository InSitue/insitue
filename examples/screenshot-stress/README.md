# screenshot-stress

Deterministic test battery for the InSitue screenshot pipeline. Filed
under insitue#10 — the inconsistent-blank-capture investigation.

## What's here

11 cases, each a clearly-labeled `.target` element designed to
exercise a known-or-suspected failure surface of the layered
capture pipeline:

| # | Case | What it tests |
|---|---|---|
| 1 | next/image fill-pattern | The manual-overlay fix in `renderViewportCrop` |
| 2 | Same-origin `<img>` | Baseline happy path |
| 3 | CORS-friendly cross-origin `<img>` | html-to-image `embedImages` fetch path |
| 4 | CSS `background-image` | Background images aren't embedded by html-to-image |
| 5 | `<video>` | Tripwire for the `hasVideo` quality flag |
| 6 | Live `<canvas>` | Tripwire for `hasCanvas`; readback security |
| 7 | Animated background | Mid-paint capture + blank-detection escalation |
| 8 | Element in open Shadow DOM | html-to-image doesn't walk shadowRoots |
| 9 | Cross-origin `<iframe>` | Iframe-as-opaque-rectangle; layer-2-only |
| 10 | Sticky element partially out of viewport | Crop coordinate math |
| 11 | `transform: scale()` parent | Transform-vs-bbox mismatch |

## Run

```sh
# 1. Build the SDK once
pnpm --filter @insitue/sdk build

# 2. Start the static server
node examples/screenshot-stress/serve.mjs
# → http://localhost:4555

# 3. Attach a companion in another terminal
pnpm --filter @insitue/companion dev
```

Open <http://localhost:4555> and pick each `.target` with the
InSitue dot. Record:

- The bundle's `captureDiagnostics` field (via
  `__insitue_capture__.bundle.captureDiagnostics` in the console)
- Whether the rendered thumbnail looks blank vs the live element
- Browser + viewport size

## Debug mode

```js
window.__insitueDebug__ = true;
```

Each subsequent pick draws the actual crop rect on screen for ~500ms
(insitue#10 PR 2). Tells you immediately whether "blank screenshot"
means "the crop missed the element" vs "the rasterise was empty."

## Expected outcomes (today)

Pin these in a follow-up `expected-outcomes.md` once we run the
battery on the current SDK. The point of the battery isn't a
pass/fail — it's a stable surface that captures regressions as we
iterate on the fix patterns.
