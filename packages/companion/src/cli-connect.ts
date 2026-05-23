/**
 * `insitue connect` (#147 M1).
 *
 * Attaches a developer's terminal to a running `insitue dev`
 * companion as a read-only subscriber. Every browser pick is
 * formatted and printed to stdout — pretty text by default,
 * NDJSON with `--json`. Designed to be piped:
 *
 *   $ insitue connect | claude --continue
 *   $ insitue connect --json | jq '.resolved.file'
 *
 * Auth: same loopback + session-token model the browser uses.
 * The companion writes the token to `<root>/.insitue/session.json`
 * when it starts; we look it up from the cwd by walking up to find
 * the nearest `.insitue` directory. No new persistent secret.
 *
 * `--mcp` is a follow-up commit (M1.5) — it wraps the existing
 * MCP-server module so the dev's Claude session can pull the
 * latest selection as a tool call.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { WebSocket } from "ws";

/** v1 protocol number — must match server.PROTOCOL_VERSION. We
 *  re-declare here rather than importing from server.ts to keep
 *  the CLI bundle independent of the orchestrator + zod tree
 *  (faster cold start). The version check in the hello handshake
 *  catches a mismatch loudly. */
const PROTOCOL_VERSION = 2;

interface SessionFile {
  token: string;
  port: number;
  pid: number;
}

interface BroadcastCapture {
  t: "broadcast-capture";
  id: string;
  bundle: {
    target?: {
      selector?: string;
      componentStack?: { name: string }[];
      source?: { file?: string; line?: number; col?: number };
    } | null;
    userNote?: string | null;
    runtime?: { url?: string };
  };
  resolved: { file?: string; line?: number; confidence?: string } | null;
  note: string;
  at: string;
}

/** Walk up from cwd to find the nearest `.insitue/session.json`. */
function findSession(start = process.cwd()): {
  dir: string;
  session: SessionFile;
} | null {
  let dir = resolve(start);
  while (true) {
    const candidate = join(dir, ".insitue", "session.json");
    if (existsSync(candidate)) {
      try {
        const session = JSON.parse(readFileSync(candidate, "utf8")) as SessionFile;
        return { dir, session };
      } catch {
        return null;
      }
    }
    const parent = dirname(dir);
    if (parent === dir) return null; // hit filesystem root
    dir = parent;
  }
}

export interface ConnectOpts {
  json: boolean;
}

export async function runConnect(opts: ConnectOpts): Promise<void> {
  const found = findSession();
  if (!found) {
    process.stderr.write(
      "[insitue] no running companion found.\n" +
        "  Start one in your project root: npx @insitue/companion dev\n",
    );
    process.exit(1);
  }
  const { dir, session } = found;

  const url = `ws://127.0.0.1:${session.port}/insitue/cli`;
  const ws = new WebSocket(url, {
    headers: {
      // Loopback + token are the real auth boundary; the
      // user-agent is informational so admins can see who's
      // connected in their logs.
      "user-agent": `insitue-cli/${PROTOCOL_VERSION}`,
    },
  });

  let helloSent = false;

  ws.on("open", () => {
    ws.send(
      JSON.stringify({
        t: "hello",
        protocolVersion: PROTOCOL_VERSION,
        token: session.token,
      }),
    );
    helloSent = true;
  });

  ws.on("message", (raw) => {
    let parsed: { t?: string } & Record<string, unknown>;
    try {
      parsed = JSON.parse(String(raw));
    } catch {
      return;
    }
    if (parsed.t === "hello-ok") {
      ws.send(JSON.stringify({ t: "subscribe" }));
      return;
    }
    if (parsed.t === "subscribe-ok") {
      if (!opts.json) {
        process.stderr.write(
          `\x1b[32m✓\x1b[0m connected to insitue dev (project: ${dir})\n` +
            `  selections will print here as they happen\n\n`,
        );
      }
      return;
    }
    if (parsed.t === "error") {
      process.stderr.write(
        `[insitue] error from companion: ${parsed.message ?? "(unknown)"}\n`,
      );
      process.exit(1);
    }
    if (parsed.t === "broadcast-capture") {
      const evt = parsed as unknown as BroadcastCapture;
      if (opts.json) {
        process.stdout.write(JSON.stringify(evt) + "\n");
      } else {
        process.stdout.write(formatPretty(evt) + "\n");
      }
    }
  });

  ws.on("error", (err) => {
    if (!helloSent) {
      process.stderr.write(
        `[insitue] couldn't connect to companion at ${url}\n` +
          `  ${err.message}\n` +
          `  Is the companion still running in this project root?\n`,
      );
      process.exit(1);
    }
    process.stderr.write(`[insitue] ws error: ${err.message}\n`);
  });

  ws.on("close", () => {
    process.stderr.write("[insitue] companion disconnected.\n");
    process.exit(0);
  });

  // Clean shutdown on Ctrl-C so we don't leave a dangling WS in
  // the subscribers set (server cleans up too, but explicit close
  // gets the exit fast).
  process.on("SIGINT", () => {
    ws.close();
    process.exit(0);
  });
}

function formatPretty(evt: BroadcastCapture): string {
  const t = evt.bundle.target ?? null;
  const tag =
    t?.componentStack?.[0]?.name ??
    (t?.selector ? t.selector.split(" ").slice(-1)[0] : "?");
  const where = evt.resolved?.file
    ? `${evt.resolved.file}${evt.resolved.line ? `:${evt.resolved.line}` : ""}`
    : t?.selector
      ? `selector: ${t.selector.slice(0, 80)}`
      : "(unknown target)";
  const note = evt.bundle.userNote
    ? `\n   ── User note ──\n   ${evt.bundle.userNote.split("\n").join("\n   ")}`
    : "";
  const url = evt.bundle.runtime?.url ? `\n   URL: ${evt.bundle.runtime.url}` : "";
  return (
    `\x1b[1m📌 Selected at ${evt.at}\x1b[0m\n` +
    `   <${tag}>\n` +
    `   ${where}` +
    url +
    note
  );
}
