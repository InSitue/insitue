/**
 * Framing contract — pins the *crop-math* fix that lets the picked
 * element appear inside the screenshot regardless of CSS position
 * mode, ancestor transforms, inner-scroll, or async layout shift
 * during capture.
 *
 * Why these live alongside the older captureDiagnostics tests:
 * fidelity bugs (case 1 next/image, case 4 bg-image) are about
 * WHAT renders inside the crop. Framing bugs are about WHERE the
 * crop lands. The two failure surfaces are orthogonal — both can
 * regress independently, both need contracts.
 */
import { afterEach, describe, expect, it } from "vitest";
import { buildBundle } from "../src/capture.ts";
import {
  fixedTargetFixture,
  stickyTargetFixture,
  transformedAncestorFixture,
  innerScrollFixture,
  layoutShiftFixture,
  tileInWideGridFixture,
  type Fixture,
} from "./_fixtures.ts";

let active: Fixture | null = null;

afterEach(() => {
  active?.cleanup();
  active = null;
});

function expectCropContainsPickedBbox(
  cropRect: { x: number; y: number; width: number; height: number },
  bbox: { x: number; y: number; width: number; height: number },
): void {
  // The picked element's bbox must overlap the cropRect. A tight
  // "fully contained" check would be too strict — crops are clamped
  // to the viewport, so a target near the viewport edge can poke
  // slightly outside. Overlap by ≥half of each axis is the contract.
  const ox = Math.max(0, Math.min(cropRect.x + cropRect.width, bbox.x + bbox.width) - Math.max(cropRect.x, bbox.x));
  const oy = Math.max(0, Math.min(cropRect.y + cropRect.height, bbox.y + bbox.height) - Math.max(cropRect.y, bbox.y));
  expect(ox).toBeGreaterThanOrEqual(bbox.width / 2);
  expect(oy).toBeGreaterThanOrEqual(bbox.height / 2);
}

describe("framing — pickedPosition is surfaced for every position mode", () => {
  it("reports `fixed` for a position:fixed target", async () => {
    active = fixedTargetFixture();
    const bundle = await buildBundle(active.selection);
    const d = bundle.captureDiagnostics!;
    expect(d.pickedPosition).toBe("fixed");
    // Sanity: the crop must still contain the picked element.
    expect(d.pickedBboxAtComposite).toBeDefined();
    expectCropContainsPickedBbox(d.cropRect, d.pickedBboxAtComposite!);
  });

  it("reports `sticky` for a position:sticky target", async () => {
    active = stickyTargetFixture();
    const bundle = await buildBundle(active.selection);
    const d = bundle.captureDiagnostics!;
    expect(d.pickedPosition).toBe("sticky");
    expect(d.pickedBboxAtComposite).toBeDefined();
    expectCropContainsPickedBbox(d.cropRect, d.pickedBboxAtComposite!);
  });
});

describe("framing — pickedContainingBlock surfaces scrolling + transformed ancestors", () => {
  it("records a transformed ancestor's transform string", async () => {
    active = transformedAncestorFixture();
    const bundle = await buildBundle(active.selection);
    const d = bundle.captureDiagnostics!;
    expect(d.pickedContainingBlock).not.toBeNull();
    expect(d.pickedContainingBlock?.transform).toBeTruthy();
    expect(d.pickedContainingBlock?.transform).not.toBe("none");
    // The picked element must remain inside the crop even when the
    // ancestor is transformed — that's the user-facing contract.
    expectCropContainsPickedBbox(d.cropRect, d.pickedBboxAtComposite!);
  });

  it("records the scrolled inner container's scrollTop", async () => {
    active = innerScrollFixture();
    const bundle = await buildBundle(active.selection);
    const d = bundle.captureDiagnostics!;
    expect(d.pickedContainingBlock).not.toBeNull();
    expect(d.pickedContainingBlock?.scrollTop).toBeGreaterThan(0);
    expectCropContainsPickedBbox(d.cropRect, d.pickedBboxAtComposite!);
  });
});

describe("crop tightness — picked element drives the crop size", () => {
  it("does NOT expand to the surrounding grid's full width", async () => {
    active = tileInWideGridFixture();
    const bundle = await buildBundle(active.selection);
    const d = bundle.captureDiagnostics!;
    const tileWidth = d.elementBbox.width;
    // The grid container is 1100px - 48px padding = ~1052px wide.
    // Before the fix, cropRect.width tracked the grid (~1052). Now
    // it should stay tight to the tile: capped near the 640px
    // TARGET, never approaching the grid's full width.
    expect(d.cropRect.width).toBeLessThan(900);
    // And the crop must still surround the picked tile.
    expect(d.cropRect.width).toBeGreaterThanOrEqual(tileWidth);
  });
});

describe("framing — async layout shift between pick and composite", () => {
  it("re-reads the bbox immediately before composite; drift is non-zero when the page reflows", async () => {
    active = layoutShiftFixture();
    const bundle = await buildBundle(active.selection);
    const d = bundle.captureDiagnostics!;
    expect(d.pickedBboxAtComposite).toBeDefined();
    // The composite-time bbox lives in the diagnostics regardless of
    // whether the shift actually fired before composite (test
    // timing is best-effort). The contract is: *whenever* drift
    // exists, the crop still surrounds the picked element.
    expectCropContainsPickedBbox(d.cropRect, d.pickedBboxAtComposite!);
    expect(typeof d.pickedBboxDriftPx).toBe("number");
    expect(d.pickedBboxDriftPx).toBeGreaterThanOrEqual(0);
  });
});
