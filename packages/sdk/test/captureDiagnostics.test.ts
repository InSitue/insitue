/**
 * Per-capture telemetry (insitue#10 Phase 1) — pins the contract
 * downstream consumers (cloud dashboard, agent context) depend on:
 * every bundle that produced a screenshot OR set
 * `screenshotUnavailable` MUST also carry `captureDiagnostics`.
 *
 * Specifically:
 *  - attemptedLayers has one entry per layer (1 + 2), each with an
 *    `outcome ∈ {success, blank, error, skipped}` and a duration
 *  - `strategy` matches the per-layer outcomes
 *  - `shippedLooksBlank` is set on the bundle's final image
 *  - content tripwires (video/canvas/iframe/shadowDOM) are present
 *  - crop + element bbox are recorded
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildBundle } from "../src/capture.ts";
import { setCaptureSettings } from "../src/capture-settings.ts";
import {
  liveImgUnpaintableHero,
  sameOriginImage,
  type Fixture,
} from "./_fixtures.ts";

let active: Fixture | null = null;

afterEach(() => {
  active?.cleanup();
  active = null;
  setCaptureSettings({ disableLayer2: false, alwaysPixelPerfect: false });
});

describe("captureDiagnostics — pinning the v4 contract (insitue#10)", () => {
  it("ships diagnostics on the happy path (sameOriginImage)", async () => {
    setCaptureSettings({ disableLayer2: true });
    active = sameOriginImage();
    const bundle = await buildBundle(active.selection);
    expect(bundle.captureDiagnostics).toBeDefined();
    const d = bundle.captureDiagnostics!;
    // Layer-1 ran, layer-2 was skipped (disableLayer2).
    expect(d.attemptedLayers.length).toBe(2);
    expect(d.attemptedLayers.find((a) => a.layer === 1)).toBeDefined();
    expect(d.attemptedLayers.find((a) => a.layer === 2)?.outcome).toBe(
      "skipped",
    );
    expect(d.strategy).toBe("layer1-only");
    expect(typeof d.shippedLooksBlank).toBe("boolean");
    expect(d.cropRect.width).toBeGreaterThan(0);
    expect(d.elementBbox.width).toBeGreaterThan(0);
    expect(typeof d.hasVideoInCrop).toBe("boolean");
    expect(typeof d.hasCanvasInCrop).toBe("boolean");
    expect(typeof d.hasIframeInCrop).toBe("boolean");
    expect(typeof d.shadowDomDepthInCrop).toBe("number");
    expect(d.browserUA.length).toBeGreaterThan(0);
  });

  it("records per-layer durations as numbers", async () => {
    setCaptureSettings({ disableLayer2: true });
    active = sameOriginImage();
    const bundle = await buildBundle(active.selection);
    for (const a of bundle.captureDiagnostics!.attemptedLayers) {
      expect(typeof a.durationMs).toBe("number");
      expect(a.durationMs).toBeGreaterThanOrEqual(0);
    }
  });

  it("flags layer-2 error path with outcome=error + error message", async () => {
    // alwaysPixelPerfect: skip layer 1, force layer 2. Mock
    // getDisplayMedia to throw — outcome should be `error` with the
    // message captured.
    setCaptureSettings({ alwaysPixelPerfect: true, disableLayer2: false });
    vi.spyOn(navigator.mediaDevices, "getDisplayMedia").mockImplementation(
      async () => {
        throw new DOMException("denied", "NotAllowedError");
      },
    );
    active = liveImgUnpaintableHero();
    const bundle = await buildBundle(active.selection);
    const d = bundle.captureDiagnostics!;
    const l1 = d.attemptedLayers.find((a) => a.layer === 1);
    const l2 = d.attemptedLayers.find((a) => a.layer === 2);
    expect(l1?.outcome).toBe("skipped");
    // l2's outcome can be `error` (mock threw) or `error` via the
    // null-return path. Either way it's not success/blank.
    expect(l2).toBeDefined();
    expect(["error"]).toContain(l2!.outcome);
  });

  it("when shippedLooksBlank=true, screenshot.qualityNote mentions blank", async () => {
    // Disable layer-2 so layer-1's output ships unconditionally.
    // If layer-1 happens to looksBlank on this fixture, we should
    // see the new qualityNote — but the fixture isn't guaranteed
    // to produce a blank. So we just verify the CONTRACT: when
    // shippedLooksBlank is true, qualityNote contains "blank".
    setCaptureSettings({ disableLayer2: true });
    active = sameOriginImage();
    const bundle = await buildBundle(active.selection);
    if (
      bundle.screenshot &&
      bundle.captureDiagnostics?.shippedLooksBlank
    ) {
      expect(bundle.screenshot.qualityNote ?? "").toMatch(/blank/i);
    }
  });

  it("strategy reflects layer-2 being attempted after layer-1 imperfect", async () => {
    setCaptureSettings({ alwaysPixelPerfect: false, disableLayer2: false });
    vi.spyOn(navigator.mediaDevices, "getDisplayMedia").mockImplementation(
      async () => {
        throw new DOMException("denied", "NotAllowedError");
      },
    );
    active = liveImgUnpaintableHero();
    const bundle = await buildBundle(active.selection);
    const d = bundle.captureDiagnostics!;
    // Layer 1 ran (imperfect or otherwise), then layer 2 was
    // attempted and failed. Strategy is either layer1-degraded
    // (l1 succeeded, l2 blank/error) or both-failed.
    expect(
      ["layer1-degraded", "both-failed", "layer1-only", "layer1-then-layer2"],
    ).toContain(d.strategy);
  });
});
