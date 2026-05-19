import { defineConfig } from "tsup";

/**
 * The SDK ships browser-ready ESM. The overlay must run on its OWN
 * Preact (it lives in a Shadow DOM, never sharing the host's React
 * runtime), so Preact + the pure capture-core are BUNDLED in — not
 * left as bare specifiers (which break direct browser import and would
 * risk host-dedupe in a bundler). Only `react` stays external: it's
 * used solely by the thin `<InSitue/>` wrapper, and the consuming app
 * already has React.
 */
export default defineConfig({
  entry: [
    "src/index.ts",
    "src/overlay.ts",
    "src/capture-only.ts",
    "src/babel.ts",
  ],
  format: ["esm"],
  dts: true,
  clean: true,
  external: ["react"],
  noExternal: ["preact", /^preact\//, "@insitue/capture-core", "html-to-image"],
});
