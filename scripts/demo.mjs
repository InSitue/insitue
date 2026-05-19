/**
 * One-command demo: companion + the Vite React example, together.
 * Run via `pnpm demo` (builds first, then this).
 *
 * Companion is scoped to the repo root so it can resolve the example's
 * source; the example serves on :3100, so the companion's Origin
 * allowlist is pinned to :3100.
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const EXAMPLE_PORT = 3100;

const procs = [
  {
    name: "companion",
    color: "\x1b[36m",
    cmd: process.execPath,
    args: [
      "packages/companion/dist/cli.js",
      "--root",
      root,
      "-o",
      `http://localhost:${EXAMPLE_PORT}`,
      `http://127.0.0.1:${EXAMPLE_PORT}`,
    ],
  },
  {
    name: "example",
    color: "\x1b[35m",
    cmd: "pnpm",
    args: ["--filter", "@insitue/example-react", "dev"],
  },
];

const children = [];
let shuttingDown = false;

function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const c of children) c.kill("SIGTERM");
  setTimeout(() => process.exit(code), 300);
}

for (const p of procs) {
  const child = spawn(p.cmd, p.args, { cwd: root, env: process.env });
  children.push(child);
  const tag = `${p.color}[${p.name}]\x1b[0m `;
  const pipe = (stream) => {
    let buf = "";
    stream.on("data", (d) => {
      buf += d.toString();
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const l of lines) console.log(tag + l);
    });
  };
  pipe(child.stdout);
  pipe(child.stderr);
  child.on("exit", (code) => {
    console.log(tag + `exited (${code})`);
    shutdown(code ?? 0);
  });
}

console.log(
  "\x1b[32m[demo]\x1b[0m InSitue demo starting…\n" +
    `\x1b[32m[demo]\x1b[0m open http://localhost:${EXAMPLE_PORT} — click "Select" in the InSitue pill\n` +
    "\x1b[32m[demo]\x1b[0m Ctrl+C to stop both processes",
);

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));
