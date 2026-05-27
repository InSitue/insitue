/**
 * Test fixtures — DOM scenarios that reproduce real-world capture
 * scenarios reliably. Each fixture sets up a known page state and
 * returns the picked element + cleanup. Tests call `buildBundle`
 * against the picked element and assert on the resulting bundle.
 *
 * Fixtures are pure DOM construction (no React/Preact, no host
 * framework) so they're fast and deterministic. The picker chain
 * is constructed manually too — tests pass `SelectionInput`
 * directly rather than driving the live picker UI.
 */
import type { SelectionInput } from "@insitue/capture-core";

export interface Fixture {
  /** The element the test should pretend was picked. */
  picked: HTMLElement;
  /** Selection that `buildBundle(sel)` would receive from the picker. */
  selection: SelectionInput;
  /** Tear down — removes the fixture DOM. Tests should call it in
   *  afterEach so state doesn't leak between cases. */
  cleanup: () => void;
}

function mount(html: string): HTMLElement {
  const root = document.createElement("div");
  root.dataset["insitueFixture"] = "1";
  // Inline-block at a known position so getBoundingClientRect
  // returns values we can reason about in assertions.
  root.style.position = "fixed";
  root.style.inset = "0";
  root.style.background = "#000";
  root.innerHTML = html;
  document.body.appendChild(root);
  return root;
}

function pick(el: HTMLElement): SelectionInput {
  return {
    mode: "element",
    pointerPath: [el],
  };
}

/** Same-origin `<img>` — the happy path. html-to-image's built-in
 *  embed should handle it; bundle.screenshot.source should be
 *  "rasterise" with no qualityNote. */
export function sameOriginImage(): Fixture {
  const root = mount(`
    <div style="width:400px;height:300px;background:#222;padding:20px">
      <img
        id="t-sameorigin"
        alt="dot"
        width="200" height="150"
        src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII="
      />
    </div>
  `);
  const picked = root.querySelector<HTMLImageElement>("#t-sameorigin")!;
  return {
    picked,
    selection: pick(picked),
    cleanup: () => root.remove(),
  };
}

/** SVG `<g>` element — was silently skipped pre-0.1.5 because the
 *  rasterise block was gated on `HTMLElement`. */
export function svgGroupPick(): Fixture {
  const root = mount(`
    <div style="width:400px;height:300px;background:#fff;padding:20px">
      <svg width="240" height="180" viewBox="0 0 240 180">
        <g id="t-svg-g">
          <rect x="20" y="20" width="200" height="140" fill="#5751e6" />
          <circle cx="120" cy="90" r="40" fill="#ffd44d" />
        </g>
      </svg>
    </div>
  `);
  // SVGElement, not HTMLElement — that's the whole point.
  const picked = root.querySelector("#t-svg-g") as unknown as HTMLElement;
  return {
    picked,
    selection: pick(picked),
    cleanup: () => root.remove(),
  };
}

/** Reproduces the **second** minimecha dogfood failure (2026-05-21,
 *  Playwright-verified): a next/image-rendered `<img>` whose live
 *  bitmap paints PURE BLACK when drawn to canvas via
 *  `ctx.drawImage(liveImg, …)`, even though `img.complete` is true
 *  and the image is visibly rendered on the page. The
 *  reproducer here uses a live `<img>` whose `src` is overridden
 *  AFTER load completes — Chrome treats the stale bitmap as
 *  unrasterisable to canvas. This stands in for whatever Next dev
 *  is doing to the live img (some internal optimisation that
 *  makes the bitmap inaccessible to the canvas paint path).
 *
 *  The SDK fix: re-fetch the image via a fresh `Image` with
 *  `crossOrigin="anonymous"` before drawing, sidestepping
 *  whatever the live img is doing. */
export function liveImgUnpaintableHero(): Fixture {
  // A real PNG served from a same-origin URL would be needed for
  // a true reproducer; we approximate by giving the live img a
  // SVG payload and the fresh-load path will fetch the same URL.
  // The test asserts that the captured screenshot has high colour
  // diversity at the img's bbox — meaning the fix draw path
  // succeeded, not just the live-draw path.
  const VIVID =
    "data:image/svg+xml;base64," +
    btoa(
      '<svg xmlns="http://www.w3.org/2000/svg" width="600" height="400" viewBox="0 0 600 400">' +
        '<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">' +
        '<stop offset="0" stop-color="#ff6600"/>' +
        '<stop offset=".5" stop-color="#00aaff"/>' +
        '<stop offset="1" stop-color="#bb00ff"/>' +
        "</linearGradient></defs>" +
        '<rect width="600" height="400" fill="url(#g)"/>' +
        '<text x="300" y="200" font-size="60" fill="#fff" text-anchor="middle">HERO</text>' +
        "</svg>",
    );
  const root = mount(`
    <div style="width:800px;height:450px;background:#0d0d0d;position:relative">
      <div style="position:relative; aspect-ratio: 16/9; width:100%; overflow:hidden">
        <img
          id="t-live-unpaint"
          alt="hero"
          src="${VIVID}"
          style="position:absolute; inset:0; width:100%; height:100%; object-fit:cover;"
        />
        <div style="position:absolute; inset:0; padding:32px; color:#fff; font:700 32px/1 sans-serif; pointer-events:none">
          Hero text overlay
        </div>
      </div>
    </div>
  `);
  const picked = root.querySelector<HTMLImageElement>("#t-live-unpaint")!;
  return {
    picked,
    selection: pick(picked),
    cleanup: () => root.remove(),
  };
}

/** Reproduces the first minimecha dogfood failure (SDK 0.1.4–0.1.7): a `next/image` `<img>` with `fill`
 *  styling (`position:absolute; width:100%; height:100%;
 *  object-fit:cover`) inside an `aspect-ratio` parent, with
 *  text overlaid on top. The user picks the image; the
 *  screenshot must include the image's actual pixels (not just
 *  the parent's background bleeding through). */
export function nextImageHeroPick(): Fixture {
  // A small data-URL image with HIGH color variance — useful
  // for the pixel-sampling assertion later. Each row of the 8×8
  // PNG is a different colour, so any region of the rendered
  // image has multi-colour pixels.
  const VIVID_IMG_DATA_URL =
    "data:image/svg+xml;base64," +
    btoa(
      '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="200" viewBox="0 0 320 200">' +
        '<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">' +
        '<stop offset="0" stop-color="#ff3366"/>' +
        '<stop offset=".5" stop-color="#33ff99"/>' +
        '<stop offset="1" stop-color="#3399ff"/>' +
        "</linearGradient></defs>" +
        '<rect width="320" height="200" fill="url(#g)"/>' +
        '<circle cx="160" cy="100" r="40" fill="#ffd44d"/>' +
        '<rect x="40" y="40" width="60" height="60" fill="#000"/>' +
        "</svg>",
    );
  // Mimics next/image with `fill` + `sizes` + `srcset` — what
  // Next's image optimiser actually emits in production. All
  // srcset variants point at the same data URL so the browser
  // loads the image successfully (real Next would serve from
  // `/_next/image` for each width; here we collapse to a single
  // data URL because the fixture has no server). The key bits
  // for the regression are present: `position:absolute` inside
  // an `aspect-ratio` parent, `srcset` siblings, `object-fit:
  // cover`, `loading="lazy"`, `data-nimg="fill"`, text overlay
  // on top.
  const root = mount(`
    <div style="width:640px;height:360px;background:#0d0d0d;position:relative">
      <div style="position:relative; aspect-ratio: 16/9; width:100%; overflow:hidden">
        <img
          id="t-next-image"
          alt="hero"
          data-nimg="fill"
          loading="lazy"
          decoding="async"
          src="${VIVID_IMG_DATA_URL}"
          srcset="${VIVID_IMG_DATA_URL} 640w, ${VIVID_IMG_DATA_URL} 1280w, ${VIVID_IMG_DATA_URL} 1920w"
          sizes="100vw"
          style="position:absolute; inset:0; width:100%; height:100%; object-fit:cover; object-position:center; color:transparent;"
        />
        <div style="position:absolute; inset:0; padding:32px; color:#fff; font:700 32px/1 sans-serif; pointer-events:none">
          Hero text overlay
        </div>
      </div>
    </div>
  `);
  const picked = root.querySelector<HTMLImageElement>("#t-next-image")!;
  return {
    picked,
    selection: pick(picked),
    cleanup: () => root.remove(),
  };
}

/** Crop tightness — a single tile inside a wide 3-col grid. Before
 *  0.6.1, `findContextAncestor` walked up to the grid and the crop
 *  ended up grid-sized (the entire section). Now the crop is
 *  anchored to the picked tile + margin, capped near a comfortable
 *  thumbnail size — never section-sized. */
export function tileInWideGridFixture(): Fixture {
  const root = mount(`
    <div style="position:relative;width:1100px;background:#f7f7fb;padding:24px;color:#0a0a0a">
      <div style="display:grid;grid-template-columns:repeat(3, 1fr);gap:24px">
        <div style="background:#fff;border-radius:14px;padding:20px;min-height:240px">Tile 1</div>
        <div
          id="t-middle-tile"
          style="background:#fff;border-radius:14px;padding:20px;min-height:240px"
        >Tile 2 (picked)</div>
        <div style="background:#fff;border-radius:14px;padding:20px;min-height:240px">Tile 3</div>
      </div>
    </div>
  `);
  const picked = root.querySelector<HTMLDivElement>("#t-middle-tile")!;
  return {
    picked,
    selection: pick(picked),
    cleanup: () => root.remove(),
  };
}

/** Framing — picked element is itself `position: fixed`. Asserts
 *  `captureDiagnostics.pickedPosition === "fixed"` so the composite
 *  step can skip `+scrollY`. */
export function fixedTargetFixture(): Fixture {
  const root = mount(`
    <div style="position:relative;width:600px;height:400px;background:#fff;padding:20px">
      <div style="height:160px;background:#eee">In-flow placeholder</div>
      <div
        id="t-fixed-target"
        style="position:fixed;top:220px;right:28px;width:220px;height:96px;background:#ef4444;color:#fff;display:flex;align-items:center;justify-content:center;font:700 18px sans-serif;z-index:50"
      >FIXED · pick me</div>
    </div>
  `);
  const picked = root.querySelector<HTMLDivElement>("#t-fixed-target")!;
  return {
    picked,
    selection: pick(picked),
    cleanup: () => root.remove(),
  };
}

/** Framing — `position: sticky` target. Whether the test forces it
 *  into a stuck state depends on the test scrollY being set; the
 *  fixture only guarantees `pickedPosition === "sticky"`. */
export function stickyTargetFixture(): Fixture {
  const root = mount(`
    <div style="position:relative;width:600px;height:400px;background:#fff;padding:20px">
      <div style="height:600px;background:#fef3c7;padding:12px">
        <div
          id="t-sticky-target"
          style="position:sticky;top:8px;background:#8b5cf6;color:#fff;display:flex;align-items:center;justify-content:center;min-height:96px;font:700 18px sans-serif"
        >STUCK</div>
        <div style="height:480px;background:repeating-linear-gradient(135deg,#fff 0 16px,#fde68a 16px 32px)"></div>
      </div>
    </div>
  `);
  const picked = root.querySelector<HTMLDivElement>("#t-sticky-target")!;
  return {
    picked,
    selection: pick(picked),
    cleanup: () => root.remove(),
  };
}

/** Framing — target inside a transformed ancestor (vs. having the
 *  transform on the target itself). Asserts
 *  `captureDiagnostics.pickedContainingBlock.transform` is set. */
export function transformedAncestorFixture(): Fixture {
  const root = mount(`
    <div style="position:relative;width:600px;height:400px;background:#fff;padding:20px">
      <div
        id="t-transform-wrap"
        style="transform:translateY(-30px) scale(0.95);transform-origin:top left;padding:20px;border:1px dashed #d4d4dc"
      >
        <div
          id="t-transformed-target"
          style="background:#0ea5e9;color:#fff;display:flex;align-items:center;justify-content:center;min-height:120px;font:700 22px sans-serif"
        >TRANSFORMED · ancestor</div>
      </div>
    </div>
  `);
  const picked = root.querySelector<HTMLDivElement>("#t-transformed-target")!;
  return {
    picked,
    selection: pick(picked),
    cleanup: () => root.remove(),
  };
}

/** Framing — target only visible after the inner scroll container
 *  is scrolled. Asserts `pickedContainingBlock.scrollTop > 0`. */
export function innerScrollFixture(): Fixture {
  const root = mount(`
    <div style="position:relative;width:600px;height:400px;background:#fff;padding:20px">
      <div
        id="t-inner-scroller"
        style="max-height:200px;overflow:auto;background:#f4f4f6;padding:12px"
      >
        <div style="height:220px;background:repeating-linear-gradient(45deg,#e4e4e7 0 10px,#f4f4f6 10px 20px)"></div>
        <div
          id="t-inner-target"
          style="margin:16px 0;background:#22c55e;color:#fff;display:flex;align-items:center;justify-content:center;min-height:96px;font:700 22px sans-serif"
        >INNER-SCROLL</div>
        <div style="height:220px;background:repeating-linear-gradient(45deg,#e4e4e7 0 10px,#f4f4f6 10px 20px)"></div>
      </div>
    </div>
  `);
  const scroller = root.querySelector<HTMLDivElement>("#t-inner-scroller")!;
  // Pre-scroll so `pickedContainingBlock.scrollTop > 0` at capture time.
  scroller.scrollTop = 200;
  const picked = root.querySelector<HTMLDivElement>("#t-inner-target")!;
  return {
    picked,
    selection: pick(picked),
    cleanup: () => root.remove(),
  };
}

/** Framing — fires a layout shift on a sibling AFTER the picker
 *  selects the target but BEFORE `buildBundle` reaches its composite
 *  step. The shifted bbox at composite time differs from the click-
 *  time bbox; asserts `pickedBboxDriftPx > 0`. */
export function layoutShiftFixture(): Fixture {
  const root = mount(`
    <div style="position:relative;width:600px;height:400px;background:#fff;padding:20px">
      <div
        id="t-shifter"
        style="height:0;background:linear-gradient(90deg,#f59e0b,#f97316);transition:none"
      ></div>
      <div
        id="t-shift-target"
        style="margin-top:12px;background:#db2777;color:#fff;display:flex;align-items:center;justify-content:center;min-height:96px;font:700 22px sans-serif"
      >SHIFTS-AFTER-PICK</div>
    </div>
  `);
  const picked = root.querySelector<HTMLDivElement>("#t-shift-target")!;
  // Fire the shift right after the test calls buildBundle. We use a
  // 0ms timeout so it queues immediately but lets the test's bbox
  // capture happen first.
  setTimeout(() => {
    const shifter = root.querySelector<HTMLDivElement>("#t-shifter");
    if (shifter) shifter.style.height = "120px";
  }, 0);
  return {
    picked,
    selection: pick(picked),
    cleanup: () => root.remove(),
  };
}

/** Picks a `<div>` that's the parent of nothing visible — the
 *  bundle should still ship with a `screenshot` or honest
 *  `screenshotUnavailable`, never both undefined. */
export function emptyDivPick(): Fixture {
  const root = mount(`
    <div style="width:500px;height:200px;background:#101010;padding:20px">
      <div id="t-empty-div" style="width:300px;height:120px;background:#222"></div>
    </div>
  `);
  const picked = root.querySelector<HTMLDivElement>("#t-empty-div")!;
  return {
    picked,
    selection: pick(picked),
    cleanup: () => root.remove(),
  };
}
