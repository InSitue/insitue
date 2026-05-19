import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
// Built artifact — run `pnpm build` once before `pnpm --filter
// @insitu/example-react dev`.
import insituBabel from "@insitu/sdk/babel";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));

export default defineConfig({
  plugins: [
    react({
      babel: {
        // Exercises BOTH source paths: Vite/React dev gives fiber
        // `_debugSource`; this also stamps `data-insitu-source` so the
        // attribute fallback is covered too.
        plugins: [[insituBabel, { root: repoRoot }]],
      },
    }),
  ],
  server: { host: "127.0.0.1", port: 3100, strictPort: true },
});
