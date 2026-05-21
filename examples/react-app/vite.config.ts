import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
// Built artifact — run `pnpm build` once before `pnpm --filter
// @insitue/example-react dev`.
import insituBabel from "@insitue/sdk/babel";

// `root` MUST match the directory the companion is scoped to —
// otherwise `data-insitu-source` emits paths relative to the wrong
// base and the companion's source resolver looks in the wrong place
// (e.g. `examples/react-app/examples/react-app/src/App.tsx`).
// `__dirname` here = `examples/react-app`, which is exactly what
// `companion dev --root .` defaults to from this dir.
const appRoot = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  plugins: [
    react({
      babel: {
        // Vite/React dev does not provide React fiber `_debugSource`
        // (Next dev does — example uses Vite so we rely on the
        // attribute fallback). `data-insitu-source` is the source
        // of truth here; the path must be resolvable by the scoped
        // companion.
        plugins: [[insituBabel, { root: appRoot }]],
      },
    }),
  ],
  server: { host: "127.0.0.1", port: 3100, strictPort: true },
});
