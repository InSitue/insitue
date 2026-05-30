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
import { readFileSync } from "node:fs";
import { defineConfig } from "vitest/config";

// Mirror tsup's build-time inline of `__SDK_VERSION__` so source that
// self-identifies (capture widget footer, the #83 heartbeat body) runs
// under test instead of throwing a ReferenceError that gets swallowed.
const PKG_VERSION = JSON.parse(
  readFileSync(new URL("./package.json", import.meta.url), "utf-8"),
).version as string;

export default defineConfig({
  define: {
    __SDK_VERSION__: JSON.stringify(PKG_VERSION),
  },
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
