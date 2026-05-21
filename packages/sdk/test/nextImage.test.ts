/**
 * The next/image regression test — pins the actual failure mode
 * that bit dogfood on SDK 0.1.4 → 0.1.7. The user picks the hero
 * image; html-to-image's silent rasterise drops the image (layout
 * break inside `<foreignObject>`); the bundle ships with a
 * screenshot that has the image area as a flat fill instead of
 * the actual image pixels.
 *
 * Assertion is "the rendered screenshot DOES contain the image's
 * colour variance, not just the parent background". The fixture
 * image is deliberately high-variance (gradient + shapes), so a
 * working capture has many distinct colours sampled from the
 * image area; a broken capture has near-zero variance (the parent
 * div's `#0d0d0d` background).
 *
 * If this test fails, the silent-path capture is broken for
 * next/image-style layouts and we have to fix it (or formally
 * give up on the silent path and route everything through
 * `getDisplayMedia` by default).
 */
import { afterEach, describe, expect, it } from "vitest";
import { buildBundle } from "../src/capture.ts";
import { nextImageHeroPick, type Fixture } from "./_fixtures.ts";

let active: Fixture | null = null;

afterEach(() => {
  active?.cleanup();
  active = null;
});

/** Sample N evenly-spaced pixels from a decoded screenshot
 *  (rendered as an Image off the bundle's dataUrl) at the given
 *  bbox (which is in viewport CSS px). Returns the unique colour
 *  count — high count = real image, low count = flat fill. */
async function colourDiversityInRegion(
  dataUrl: string,
  cropBounds: { x: number; y: number; width: number; height: number },
  imgBboxInViewport: DOMRect,
): Promise<number> {
  // The bundle's screenshot is the cropped region; we want to
  // sample within the part of THAT crop that corresponds to the
  // hero image's viewport bbox.
  const img = new Image();
  img.src = dataUrl;
  await img.decode();
  const canvas = document.createElement("canvas");
  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;
  const ctx = canvas.getContext("2d")!;
  ctx.drawImage(img, 0, 0);

  // Map viewport coords → screenshot pixel coords. The screenshot
  // is `cropBounds` (viewport CSS px) rasterised at some pixel
  // ratio; we recover that ratio from naturalWidth/cropBounds.width.
  const ratio = img.naturalWidth / cropBounds.width;
  const sx0 = Math.max(0, (imgBboxInViewport.x - cropBounds.x) * ratio);
  const sy0 = Math.max(0, (imgBboxInViewport.y - cropBounds.y) * ratio);
  const sw = Math.min(
    canvas.width - sx0,
    imgBboxInViewport.width * ratio,
  );
  const sh = Math.min(
    canvas.height - sy0,
    imgBboxInViewport.height * ratio,
  );
  if (sw < 4 || sh < 4) return 0;

  const colours = new Set<string>();
  // 25-point grid; bucket by 16-step so subpixel anti-aliasing
  // doesn't inflate the count past meaningful.
  for (let i = 0; i < 5; i++) {
    for (let j = 0; j < 5; j++) {
      const x = Math.floor(sx0 + (sw * (i + 0.5)) / 5);
      const y = Math.floor(sy0 + (sh * (j + 0.5)) / 5);
      const d = ctx.getImageData(x, y, 1, 1).data;
      colours.add(
        `${d[0] >> 4},${d[1] >> 4},${d[2] >> 4}`,
      );
    }
  }
  return colours.size;
}

describe("next/image-style hero — silent path captures image content", () => {
  it("manual image compositing draws the image pixels into the canvas", async () => {
    active = nextImageHeroPick();
    const imgBbox = active.picked.getBoundingClientRect();
    const bundle = await buildBundle(active.selection);

    // Sanity — the bundle structure invariants from buildBundle.test.ts.
    expect(bundle.screenshot).toBeDefined();
    expect(bundle.screenshot?.source).toBe("rasterise");
    expect(bundle.screenshot?.dataUrl).toMatch(/^data:image\/png/);

    // The real assertion — colour diversity in the image's bbox
    // region of the screenshot. The fixture image is a gradient
    // with extra shapes, so a working capture samples MANY
    // distinct colours; a broken capture (parent bg bleeding
    // through) samples ONE.
    const diversity = await colourDiversityInRegion(
      bundle.screenshot!.dataUrl,
      bundle.screenshot!.bounds,
      imgBbox,
    );
    // Threshold: 5+ distinct buckets out of 25 samples. A flat
    // fill scores 1; a real gradient image scores 15-20+.
    expect(diversity).toBeGreaterThanOrEqual(5);
  });
});
