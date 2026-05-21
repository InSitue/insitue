/**
 * Vitest + browser provider config for `@insitue/sdk`.
 *
 * The screenshot path lives entirely in the browser — `document`,
 * `Canvas`, `html-to-image`, `navigator.mediaDevices.getDisplayMedia`
 * etc. Mocking that stack in jsdom would catch the type-shaped bugs
 * but miss everything that actually matters (rasterise quality, CORS
 * behaviour, foreignObject quirks, next/image-style layouts). So
 * every capture.ts test runs in real Chromium via Playwright.
 *
 * Rule established 2026-05-21: no `packages/sdk/src/capture.ts`
 * change ships without a green test here. Patches we ship without
 * verification end up as dogfood-found regressions.
 */
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    browser: {
      enabled: true,
      provider: "playwright",
      headless: true,
      instances: [{ browser: "chromium" }],
      // Each test fixture mounts the SDK into a fresh page so state
      // (display-media stream cache, capture settings) doesn't leak
      // across tests.
      isolate: true,
    },
  },
});
