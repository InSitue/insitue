/**
 * Per-capture telemetry (insitue#10) — pins the contract downstream
 * consumers (cloud dashboard, agent context) depend on: every bundle
 * that produced a screenshot OR set `screenshotUnavailable` MUST
 * also carry `captureDiagnostics`.
 *
 * Post-layer-2-removal: there's now only one capture path. The
 * diagnostics still carry per-layer outcomes (always a single
 * layer-1 entry) for backwards-compat with v4 receivers.
 */
import { afterEach, describe, expect, it } from "vitest";
import { buildBundle } from "../src/capture.ts";
import { sameOriginImage, type Fixture } from "./_fixtures.ts";

let active: Fixture | null = null;

afterEach(() => {
  active?.cleanup();
  active = null;
});

describe("captureDiagnostics — pinning the v4 contract (insitue#10)", () => {
  it("ships diagnostics on the happy path (sameOriginImage)", async () => {
    active = sameOriginImage();
    const bundle = await buildBundle(active.selection);
    expect(bundle.captureDiagnostics).toBeDefined();
    const d = bundle.captureDiagnostics!;
    // Single capture path now — exactly one layer attempt.
    expect(d.attemptedLayers.length).toBe(1);
    expect(d.attemptedLayers[0]!.layer).toBe(1);
    expect(["success", "blank", "error"]).toContain(
      d.attemptedLayers[0]!.outcome,
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

  it("records the layer attempt's duration as a number", async () => {
    active = sameOriginImage();
    const bundle = await buildBundle(active.selection);
    const a = bundle.captureDiagnostics!.attemptedLayers[0]!;
    expect(typeof a.durationMs).toBe("number");
    expect(a.durationMs).toBeGreaterThanOrEqual(0);
  });
});
