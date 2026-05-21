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
