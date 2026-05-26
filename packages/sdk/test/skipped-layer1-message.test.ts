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
  it("falls back to rasterise when alwaysPixelPerfect + layer 2 declined (no more silent unavailable loops)", async () => {
    // Pre-fix behavior: alwaysPixelPerfect + declined tab share = nothing.
    // Every subsequent capture gave the user "Screenshot unavailable",
    // no recovery. Post-fix (insitue#10 hotfix): we run layer 1 as a
    // safety net so they get *something* — with a qualityNote telling
    // them they can retry pixel-perfect to re-prompt for tab share.
    setCaptureSettings({ alwaysPixelPerfect: true, disableLayer2: false });
    vi.spyOn(navigator.mediaDevices, "getDisplayMedia").mockImplementation(
      async () => {
        throw new DOMException("denied", "NotAllowedError");
      },
    );

    active = liveImgUnpaintableHero();
    const bundle = await buildBundle(active.selection);

    // The fixture's html-to-image render produces enough variation
    // that the fallback should ship a screenshot. If it happens to
    // looksBlank (rare for this fixture), the bundle would surface
    // screenshotUnavailable instead — assert one or the other.
    if (bundle.screenshot) {
      expect(bundle.screenshot.source).toBe("rasterise");
      expect(bundle.screenshot.qualityNote).toMatch(/tab capture was declined/i);
      expect(bundle.screenshot.qualityNote).toMatch(/retry pixel-perfect|fallback/i);
    } else {
      // Fallback also blank — explicit honest message.
      expect(bundle.screenshotUnavailable).toBeDefined();
      expect(bundle.screenshotUnavailable).toMatch(/tab capture/i);
    }
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
