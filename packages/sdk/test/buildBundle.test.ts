/**
 * Baseline guarantees for `buildBundle` — the structural contract
 * every screenshot path must honour. These tests run in real
 * Chromium via Playwright (see `vitest.config.ts`); they don't try
 * to assert on the pixel content of the rasterised screenshot
 * (that's the layer-2 / getDisplayMedia path's job, and it needs a
 * real desktop session to fire). Instead they pin the SHAPE of the
 * returned bundle — the silent-fallthrough class of bug that's
 * been biting dogfood (bundle with neither `screenshot` nor
 * `screenshotUnavailable`) becomes impossible to ship.
 */
import { afterEach, describe, expect, it } from "vitest";
import { buildBundle } from "../src/capture.ts";
import {
  emptyDivPick,
  sameOriginImage,
  svgGroupPick,
  type Fixture,
} from "./_fixtures.ts";

let active: Fixture | null = null;

afterEach(() => {
  active?.cleanup();
  active = null;
});

describe("buildBundle — structural contract", () => {
  it("same-origin <img> pick → bundle includes screenshot OR screenshotUnavailable, never both undefined", async () => {
    active = sameOriginImage();
    const bundle = await buildBundle(active.selection);
    // The "never silent" invariant — failing this means the widget
    // would render a blank spot with no explanation, which is the
    // failure mode 0.1.5 introduced and the regression net we
    // can never lose.
    const hasResult = !!bundle.screenshot || !!bundle.screenshotUnavailable;
    expect(hasResult).toBe(true);
    // Schema sanity — the cloud receiver pins these.
    expect(bundle.schemaVersion).toBe(3);
    expect(bundle.target).not.toBeNull();
  });

  it("SVG <g> pick is not silently skipped (HTMLElement|SVGElement fix)", async () => {
    active = svgGroupPick();
    const bundle = await buildBundle(active.selection);
    const hasResult = !!bundle.screenshot || !!bundle.screenshotUnavailable;
    expect(hasResult).toBe(true);
    // Target must still resolve even for SVG nodes.
    expect(bundle.target).not.toBeNull();
  });

  it("empty div pick still produces a result (no silent fallthrough)", async () => {
    active = emptyDivPick();
    const bundle = await buildBundle(active.selection);
    const hasResult = !!bundle.screenshot || !!bundle.screenshotUnavailable;
    expect(hasResult).toBe(true);
  });

  it("screenshot, when present, carries the source diagnostic", async () => {
    active = sameOriginImage();
    const bundle = await buildBundle(active.selection);
    if (bundle.screenshot) {
      // The build-time inlined diagnostic — without it the dashboard
      // can't tell rasterise from display-media captures.
      expect(["rasterise", "display-media"]).toContain(
        bundle.screenshot.source,
      );
    }
  });
});
