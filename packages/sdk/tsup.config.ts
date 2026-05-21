import { readFileSync } from "node:fs";
import { defineConfig } from "tsup";

// Inline the package version so the SDK can self-identify at
// runtime (capture widget footer, `SDK_VERSION` export). Reading
// at build time keeps source-vs-published drift impossible: bump
// package.json → next build picks it up automatically.
const PKG_VERSION = JSON.parse(
  readFileSync(new URL("./package.json", import.meta.url), "utf-8"),
).version as string;

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
  define: {
    __SDK_VERSION__: JSON.stringify(PKG_VERSION),
  },
});
