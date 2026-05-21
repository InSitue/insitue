/**
 * Regression net for the dev-overlay layer-2 prompt bug
 * (2026-05-21). `mountInSitue` sets `disableLayer2: true` on
 * mount so the local agentic loop never hits a tab-share
 * permission prompt mid-pick. Test pins the contract: when the
 * flag is on, `buildBundle` MUST NOT invoke
 * `navigator.mediaDevices.getDisplayMedia` even when layer-1
 * reports an imperfect capture that would normally escalate.
 *
 * Why this matters: the dev tool was unusable while layer-2
 * fired — the picker triggered, but the panel stayed in "..."
 * forever waiting on permission. The flag is the only thing
 * standing between dev mode and that regression.
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

describe("buildBundle — disableLayer2", () => {
  it("never calls getDisplayMedia when disableLayer2 is true", async () => {
    setCaptureSettings({ disableLayer2: true });
    const spy = vi
      .spyOn(navigator.mediaDevices, "getDisplayMedia")
      .mockImplementation(async () => {
        throw new Error("disableLayer2 contract violated — must not prompt");
      });

    active = liveImgUnpaintableHero();
    const bundle = await buildBundle(active.selection);

    expect(spy).not.toHaveBeenCalled();
    const hasResult = !!bundle.screenshot || !!bundle.screenshotUnavailable;
    expect(hasResult).toBe(true);
    if (bundle.screenshot) {
      expect(bundle.screenshot.source).toBe("rasterise");
    }
  });

  it("still calls getDisplayMedia when disableLayer2 is false (SaaS widget path)", async () => {
    setCaptureSettings({ disableLayer2: false, alwaysPixelPerfect: true });
    const spy = vi
      .spyOn(navigator.mediaDevices, "getDisplayMedia")
      .mockImplementation(async () => {
        // Deny — we just want to observe the call, not actually
        // grant permission in a headless browser.
        throw new DOMException("denied", "NotAllowedError");
      });

    active = liveImgUnpaintableHero();
    await buildBundle(active.selection);

    expect(spy).toHaveBeenCalled();
  });
});
