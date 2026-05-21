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
  root.dataset["insituFixture"] = "1";
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
