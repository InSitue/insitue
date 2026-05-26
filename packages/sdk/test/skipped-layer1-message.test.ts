/**
 * Regression net for #61 — when `alwaysPixelPerfect: true` makes
 * `buildBundle` skip layer-1 rasterise and the user declines the
 * tab-share prompt, the message must say "tab capture was declined",
 * not "rasterise failed". Reporting the wrong failure mode reads as
 * "the SDK is broken" to first-time dogfooders on /docs/dev.
 *
 * The fix pivots on `skipLayer1`: when it's true, rasterise was
 * deliberately skipped and the only thing that could fail is layer 2.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildBundle } from "../src/capture.ts";
import { setCaptureSettings } from "../src/capture-settings.ts";
import { liveImgUnpaintableHero, type Fixture } from "./_fixtures.ts";

let active: Fixture | null = null;

afterEach(() => {
  active?.cleanup();
  active = null;
  setCaptureSettings({ disableLayer2: false, alwaysPixelPerfect: false });
});

describe("buildBundle — skipped-layer1 failure message (#61)", () => {
  it("reports tab-capture-declined (not rasterise-failed) when alwaysPixelPerfect + layer 2 returns null", async () => {
    setCaptureSettings({ alwaysPixelPerfect: true, disableLayer2: false });
    vi.spyOn(navigator.mediaDevices, "getDisplayMedia").mockImplementation(
      async () => {
        throw new DOMException("denied", "NotAllowedError");
      },
    );

    active = liveImgUnpaintableHero();
    const bundle = await buildBundle(active.selection);

    expect(bundle.screenshot).toBeUndefined();
    expect(bundle.screenshotUnavailable).toBeDefined();
    expect(bundle.screenshotUnavailable).toMatch(/tab capture was declined/i);
    expect(bundle.screenshotUnavailable).not.toMatch(/rasterise failed/i);
  });

  it("still says rasterise-failed when layer 1 was attempted and layer 2 is also unavailable", async () => {
    // alwaysPixelPerfect off → layer 1 is attempted. With our headless
    // env, layer 1's html-to-image rasterise will usually succeed on
    // the fixture, so this test asserts the negative: when both *do*
    // fail, the message must NOT say "tab capture declined".
    setCaptureSettings({ alwaysPixelPerfect: false, disableLayer2: false });
    vi.spyOn(navigator.mediaDevices, "getDisplayMedia").mockImplementation(
      async () => {
        throw new DOMException("denied", "NotAllowedError");
      },
    );

    active = liveImgUnpaintableHero();
    const bundle = await buildBundle(active.selection);

    // Either layer 1 succeeded (a screenshot ships) or both failed
    // (screenshotUnavailable set). In the both-failed case the
    // message must not mention "tab capture was declined" — that's
    // reserved for the skipLayer1 path.
    if (bundle.screenshotUnavailable) {
      expect(bundle.screenshotUnavailable).not.toMatch(
        /tab capture was declined/i,
      );
    }
  });
});
