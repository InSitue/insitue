/**
 * Tiny static file server for the screenshot-stress page (insitue#10).
 *
 * Serves `index.html` + maps `/sdk/dist/*` → the workspace
 * `packages/sdk/dist` so the import-map in index.html picks up the
 * locally-built SDK. Run:
 *
 *   pnpm --filter @insitue/sdk build
 *   node examples/screenshot-stress/serve.mjs
 *   # → http://localhost:4555
 *
 * Then attach a companion in another terminal:
 *
 *   pnpm --filter @insitue/companion dev
 *
 * No deps, no bundler — same shape as `examples/playground/serve.mjs`.
 */
import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PORT = Number(process.env.PORT ?? 4555);
const HERE = fileURLToPath(new URL(".", import.meta.url));
const ROOT = resolve(HERE);
const REPO = resolve(HERE, "..", "..");

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".map": "application/json",
  ".wasm": "application/wasm",
};

function tryFile(path) {
  if (!existsSync(path)) return null;
  const st = statSync(path);
  return st.isFile() ? path : null;
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);
  let pathname = url.pathname;
  if (pathname === "/") pathname = "/index.html";

  // Map /sdk/dist/... → packages/sdk/dist/...
  let absolute;
  if (pathname.startsWith("/sdk/")) {
    absolute = join(REPO, "packages", "sdk", pathname.slice("/sdk/".length));
  } else if (pathname.startsWith("/capture-core/")) {
    absolute = join(
      REPO,
      "packages",
      "capture-core",
      pathname.slice("/capture-core/".length),
    );
  } else {
    absolute = join(ROOT, pathname);
  }

  const file = tryFile(absolute);
  if (!file) {
    res.writeHead(404, { "content-type": "text/plain" });
    res.end(`not found: ${pathname}`);
    return;
  }
  const mime = MIME[extname(file).toLowerCase()] ?? "application/octet-stream";
  res.writeHead(200, {
    "content-type": mime,
    "cache-control": "no-cache",
    // Permissive CSP so the cross-origin iframe (case 9) loads.
    "x-content-type-options": "nosniff",
  });
  createReadStream(file).pipe(res);
});

server.listen(PORT, () => {
  console.log(`screenshot-stress page → http://localhost:${PORT}`);
  console.log("Don't forget: pnpm --filter @insitue/sdk build (once)");
});
