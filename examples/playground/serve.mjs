/**
 * Zero-dependency static server for the InSitue playground.
 *
 * Serves the playground page on http://localhost:3000 (which matches
 * the companion's default Origin allowlist) and maps `/sdk/*` to the
 * built @insitue/sdk dist so the page can import the vanilla overlay
 * (`mountInSitue`) with no bundler and no React.
 *
 * Usage:  pnpm build  &&  pnpm example   (then, in another terminal)
 *         pnpm companion
 */
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));
const sdkDist = join(here, "..", "..", "packages", "sdk", "dist");
const PORT = 3000;

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".map": "application/json",
};

const server = createServer(async (req, res) => {
  try {
    const url = (req.url ?? "/").split("?")[0];
    let file;
    if (url === "/" || url === "/index.html") {
      file = join(here, "index.html");
    } else if (url.startsWith("/sdk/")) {
      // Restrict to the sdk dist dir; block traversal.
      const rel = normalize(url.slice("/sdk/".length)).replace(/^(\.\.[/\\])+/, "");
      file = join(sdkDist, rel);
    } else {
      res.writeHead(404).end("not found");
      return;
    }
    const body = await readFile(file);
    res.writeHead(200, {
      "content-type": TYPES[extname(file)] ?? "application/octet-stream",
      "cache-control": "no-store",
    });
    res.end(body);
  } catch {
    res.writeHead(404).end("not found");
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(
    `[insitu playground] http://localhost:${PORT}\n` +
      `  1. keep \`pnpm dev\` (or run \`pnpm build\`) so packages/sdk/dist exists\n` +
      `  2. in another terminal: \`pnpm companion\`\n` +
      `  3. open the URL above — the InSitue pill should go green and Ping should work`,
  );
});
