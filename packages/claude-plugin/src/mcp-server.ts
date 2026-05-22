#!/usr/bin/env node
/**
 * InSitue MCP bridge — connects a `claude` session to the local
 * InSitue companion's pick stream so users can drive Claude Code
 * FROM the browser overlay instead of typing file/line by hand.
 *
 * Lifecycle (per claude session):
 *
 *   1. MCP server boots inside `${CLAUDE_PROJECT_DIR}` (declared by
 *      plugin.json's `cwd: "${CLAUDE_PROJECT_DIR}"`).
 *   2. `ensureCompanion()` checks for an existing companion at
 *      `.insitue/session.json`. If one is alive on its port, reuse
 *      it (the user might've run `insitue dev` themselves and we
 *      don't want to fight them). Otherwise spawn one via
 *      `npx -y @insitue/companion@latest dev` as a child process,
 *      poll for the new session.json, and connect.
 *   3. Spawned children are killed cleanly on `process.exit` and
 *      `SIGTERM`; reused-external companions are left alone.
 *   4. WS subscription drains `broadcast-capture` events into an
 *      in-memory `PickBuffer`. `next_pick` long-polls; claude calls
 *      it in a loop.
 *
 * Picks arrive complete: target, source, screenshot, AND
 * `userNote` (the user's typed description) are all in the same
 * bundle. The widget now defers the broadcast until the user
 * clicks Send, so there's no async join logic on this side.
 *
 * Hard rules: loopback-only, token-auth via `.insitue/session.json`,
 * never writes files (claude does, via its native Edit tool).
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { dirname, join, resolve } from "node:path";
import WebSocket from "ws";
import { z } from "zod";

interface SessionFile {
  token: string;
  port: number;
  pid: number;
}

interface PickEvent {
  id: string;
  at: string;
  /** Resolved source location (file + line) — present when the
   *  companion's source resolver succeeded. Absent for selector-
   *  only picks; in that case the widget normally refuses to
   *  send, but if one slips through claude has the selector
   *  + componentStack to fall back on. */
  source: { file: string; line?: number; column?: number } | null;
  /** Confidence: "exact" / "approximate" / "selector-only". */
  confidence: string;
  /** Component name (e.g. "Badge"), or selector tail if unknown. */
  target: string;
  /** Full CSS selector. */
  selector: string | null;
  /** The user's description (the whole point of the new pipeline). */
  userNote: string | null;
  /** Browser URL at pick time. */
  url: string | null;
  /** Component stack (top-down). */
  componentStack: Array<{ name: string; file?: string; line?: number }>;
}

const MAX_BUFFERED_PICKS = 32;
const NEXT_PICK_DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;
const NEXT_PICK_MAX_TIMEOUT_MS = 30 * 60 * 1000;

/** Walk up from `start` looking for `.insitue/session.json`. */
function findSession(start = process.cwd()): {
  dir: string;
  session: SessionFile;
} | null {
  let dir = resolve(start);
  while (true) {
    const candidate = join(dir, ".insitue", "session.json");
    if (existsSync(candidate)) {
      try {
        const session = JSON.parse(
          readFileSync(candidate, "utf8"),
        ) as SessionFile;
        return { dir, session };
      } catch {
        return null;
      }
    }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function summariseBundle(raw: {
  id: string;
  at: string;
  bundle: {
    target?: {
      source?: { file: string; line?: number; column?: number } | null;
      confidence?: string;
      selector?: string;
      componentStack?: Array<{
        name: string;
        source?: { file: string; line?: number };
      }>;
    } | null;
    userNote?: string;
    runtime?: { url?: string };
  };
  resolved: { file?: string; line?: number; confidence?: string } | null;
}): PickEvent {
  const t = raw.bundle.target ?? null;
  const componentStack = (t?.componentStack ?? []).map((c) => ({
    name: c.name,
    ...(c.source?.file ? { file: c.source.file } : {}),
    ...(c.source?.line ? { line: c.source.line } : {}),
  }));
  const target =
    componentStack[0]?.name ??
    (t?.selector ? t.selector.split(" ").slice(-1)[0]! : "?");
  return {
    id: raw.id,
    at: raw.at,
    source: raw.resolved?.file
      ? {
          file: raw.resolved.file,
          ...(raw.resolved.line ? { line: raw.resolved.line } : {}),
        }
      : t?.source
        ? {
            file: t.source.file,
            ...(t.source.line ? { line: t.source.line } : {}),
          }
        : null,
    confidence: raw.resolved?.confidence ?? t?.confidence ?? "unknown",
    target,
    selector: t?.selector ?? null,
    userNote: raw.bundle.userNote ?? null,
    url: raw.bundle.runtime?.url ?? null,
    componentStack,
  };
}

interface Waiter {
  resolve: (pick: PickEvent | null) => void;
  timer: NodeJS.Timeout;
}

class PickBuffer {
  private picks: PickEvent[] = [];
  private waiters: Waiter[] = [];

  push(p: PickEvent): void {
    this.picks.push(p);
    if (this.picks.length > MAX_BUFFERED_PICKS) {
      this.picks.shift();
    }
    while (this.waiters.length && this.picks.length) {
      const w = this.waiters.shift()!;
      clearTimeout(w.timer);
      w.resolve(this.picks.shift()!);
    }
  }

  next(timeoutMs: number): Promise<PickEvent | null> {
    if (this.picks.length) {
      return Promise.resolve(this.picks.shift()!);
    }
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        const idx = this.waiters.findIndex((w) => w.timer === timer);
        if (idx >= 0) this.waiters.splice(idx, 1);
        resolve(null);
      }, timeoutMs);
      this.waiters.push({ resolve, timer });
    });
  }

  recent(limit: number): PickEvent[] {
    return this.picks.slice(-limit);
  }

  /** WS reconnects — drop pending waiters with a sentinel so claude
   *  sees the disruption instead of hanging forever. */
  rejectAll(reason: string): void {
    for (const w of this.waiters) {
      clearTimeout(w.timer);
      w.resolve({
        id: "reconnect",
        at: new Date().toISOString(),
        source: null,
        confidence: "n/a",
        target: `[insitue] ${reason}`,
        selector: null,
        userNote: null,
        url: null,
        componentStack: [],
      });
    }
    this.waiters.length = 0;
  }
}

// ── Companion lifecycle ─────────────────────────────────────────────

/** Probe a companion: process alive AND port responsive. */
async function probeCompanion(
  session: { pid: number; port: number },
): Promise<boolean> {
  try {
    process.kill(session.pid, 0);
  } catch {
    return false;
  }
  return new Promise<boolean>((resolve) => {
    const req = httpRequest(
      {
        host: "127.0.0.1",
        port: session.port,
        path: "/insitue/handshake",
        method: "GET",
        timeout: 1500,
      },
      (res) => {
        // Any HTTP response means the companion is alive; the
        // handshake endpoint 403s without an Origin header, which
        // is the "I'm reachable" signal we want.
        res.resume();
        resolve(true);
      },
    );
    req.on("error", () => resolve(false));
    req.on("timeout", () => {
      req.destroy();
      resolve(false);
    });
    req.end();
  });
}

let ownedChild: ChildProcess | null = null;

/** Find or start a companion; resolve to the session info we'll use. */
async function ensureCompanion(): Promise<SessionFile | null> {
  const existing = findSession();
  if (existing && (await probeCompanion(existing.session))) {
    process.stderr.write(
      `[insitue-mcp] reusing companion at :${existing.session.port} (pid ${existing.session.pid})\n`,
    );
    return existing.session;
  }
  // No usable companion — spawn one. `npx -y` resolves the latest
  // published companion; the user always gets recent fixes without
  // touching their local install.
  process.stderr.write(
    "[insitue-mcp] starting companion via `npx -y @insitue/companion@latest dev`…\n",
  );
  ownedChild = spawn(
    "npx",
    ["-y", "@insitue/companion@latest", "dev"],
    {
      cwd: process.cwd(),
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    },
  );
  ownedChild.stdout?.on("data", (chunk: Buffer) => {
    process.stderr.write(`[companion] ${chunk.toString()}`);
  });
  ownedChild.stderr?.on("data", (chunk: Buffer) => {
    process.stderr.write(`[companion err] ${chunk.toString()}`);
  });
  ownedChild.on("exit", (code, signal) => {
    process.stderr.write(
      `[insitue-mcp] companion exited (code=${code} signal=${signal})\n`,
    );
    ownedChild = null;
  });

  // Poll for session.json. The companion writes it on bind, so
  // appearance + readability means "ready". 5s ceiling — beyond
  // that, npx is probably downloading a lot or something's wrong.
  const start = Date.now();
  while (Date.now() - start < 5000) {
    const found = findSession();
    if (found && (await probeCompanion(found.session))) {
      return found.session;
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  process.stderr.write(
    "[insitue-mcp] companion didn't come up in 5s — see [companion] / [companion err] above\n",
  );
  return null;
}

/** Kill the spawned companion when this process exits. */
function cleanupOwnedChild(): void {
  if (!ownedChild) return;
  const child = ownedChild;
  ownedChild = null;
  try {
    child.kill("SIGTERM");
  } catch {
    /* already dead */
  }
  // Force-kill after 500ms if it didn't shut down on SIGTERM.
  setTimeout(() => {
    try {
      child.kill("SIGKILL");
    } catch {
      /* already dead */
    }
  }, 500).unref();
}

process.on("exit", cleanupOwnedChild);
process.on("SIGINT", () => {
  cleanupOwnedChild();
  process.exit(130);
});
process.on("SIGTERM", () => {
  cleanupOwnedChild();
  process.exit(143);
});

// ── WS subscription ─────────────────────────────────────────────────

const buffer = new PickBuffer();

function connectToCompanion(session: SessionFile): void {
  const url = `ws://127.0.0.1:${session.port}/insitue/cli`;
  const ws = new WebSocket(url, {
    headers: { "user-agent": "insitue-claude-plugin" },
  });
  ws.on("open", () => {
    ws.send(
      JSON.stringify({
        t: "hello",
        // Pin to the companion's pinned protocol version. Bump
        // when the wire format breaks.
        protocolVersion: 5,
        token: session.token,
      }),
    );
  });
  ws.on("message", (data) => {
    let m: unknown;
    try {
      m = JSON.parse(String(data));
    } catch {
      return;
    }
    if (m && typeof m === "object") {
      const tag = (m as { t?: unknown }).t;
      if (tag === "hello-ok") {
        ws.send(JSON.stringify({ t: "subscribe" }));
        return;
      }
      if (tag === "broadcast-capture") {
        try {
          buffer.push(
            summariseBundle(m as Parameters<typeof summariseBundle>[0]),
          );
        } catch (err) {
          process.stderr.write(
            `[insitue-mcp] dropped malformed pick: ${(err as Error).message}\n`,
          );
        }
        return;
      }
      // `broadcast-ask` was used in v5 pre-unified-widget. We keep
      // the handler present but no-op so older browsers don't error
      // out; the unified widget never emits it.
      if (tag === "broadcast-ask") return;
    }
  });
  ws.on("close", () => {
    buffer.rejectAll("companion disconnected — restart `claude` to reconnect");
    // Auto-reconnect. The companion may legitimately restart (HMR,
    // user stopped + restarted). Bounded retries would be wrong:
    // claude keeps the MCP server alive for the whole session, so
    // we want to recover whenever the companion is back.
    setTimeout(() => connectToCompanion(session), 2_000);
  });
  ws.on("error", () => {
    /* close handler owns reconnect */
  });
}

// ── Boot ────────────────────────────────────────────────────────────

const session = await ensureCompanion();
if (!session) {
  process.stderr.write(
    "[insitue-mcp] no companion available — `next_pick` will time out.\n",
  );
}

// Lazy CLI-subscriber attach. We only join the companion's
// subscriber set when the user actually invokes /insitue:connect
// (which kicks off list_recent_picks + next_pick). Attaching on
// MCP boot would light up the browser launcher's "active" purple
// state the instant `claude` is open, even though the user hasn't
// asked for InSitue picks yet — misleading. Lazy attach keeps the
// launcher muted until there's a real listener.
let attached = false;
function ensureSubscriberAttached(): void {
  if (attached || !session) return;
  attached = true;
  connectToCompanion(session);
}

const server = new McpServer({
  name: "insitue",
  version: "0.2.0",
});

server.registerTool(
  "next_pick",
  {
    description:
      "Long-polls until the user clicks Send in the InSitue browser overlay. " +
      "Returns the pick (target, source file:line, screenshot) plus the " +
      "user's typed description (`userNote`). Picks arrive complete — no " +
      "separate ask event. Use in a loop: call → read `pick.source.file` " +
      "around `pick.source.line` → propose an edit → wait for terminal " +
      "approval → apply → loop.",
    inputSchema: {
      timeout_ms: z
        .number()
        .int()
        .positive()
        .max(NEXT_PICK_MAX_TIMEOUT_MS)
        .optional()
        .describe(
          `Long-poll timeout in ms. Default ${NEXT_PICK_DEFAULT_TIMEOUT_MS}; max ${NEXT_PICK_MAX_TIMEOUT_MS}.`,
        ),
    },
  },
  async ({ timeout_ms }) => {
    ensureSubscriberAttached();
    const ms = timeout_ms ?? NEXT_PICK_DEFAULT_TIMEOUT_MS;
    const pick = await buffer.next(ms);
    if (!pick) {
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ status: "timeout", waited_ms: ms }),
          },
        ],
      };
    }
    return {
      content: [
        { type: "text" as const, text: JSON.stringify({ status: "ok", pick }) },
      ],
    };
  },
);

server.registerTool(
  "list_recent_picks",
  {
    description:
      "Returns up to N most-recent picks buffered since this MCP server " +
      "started. Use once at session start (e.g. on /insitue:connect) so " +
      "the user can see if any picks slipped through before claude " +
      "attached.",
    inputSchema: {
      limit: z
        .number()
        .int()
        .positive()
        .max(MAX_BUFFERED_PICKS)
        .optional()
        .describe(`Max picks to return (1..${MAX_BUFFERED_PICKS}). Default 10.`),
    },
  },
  async ({ limit }) => {
    ensureSubscriberAttached();
    const picks = buffer.recent(limit ?? 10);
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({ count: picks.length, picks }),
        },
      ],
    };
  },
);

await server.connect(new StdioServerTransport());
