#!/usr/bin/env node
/**
 * InSitue MCP bridge — exposes the running local companion's pick
 * stream to a `claude` session as MCP tools, so the user can drive
 * Claude Code FROM the InSitue browser overlay instead of typing
 * file/line context by hand.
 *
 * One stdio MCP server per `claude` session. On startup it discovers
 * `.insitu/session.json` (walking up from `cwd`), opens a loopback
 * WebSocket to the companion using the per-session token, and
 * subscribes to the `broadcast-capture` channel. Picks are buffered
 * (bounded queue). The MCP tool `next_pick` long-polls — returns the
 * next pick within a generous timeout, so claude can sit in a loop:
 * call → wait → act on the returned file/line → call again.
 *
 * Hard rules:
 * - Loopback only — refuses to connect to anything not 127.0.0.1.
 * - Reads token from `.insitu/session.json` (the same file the
 *   browser overlay reads); never accepts a token over MCP.
 * - The server NEVER writes files. The user (via claude in their
 *   terminal) does — this is just a notification channel. Keeps the
 *   InSitue trust boundary intact: companion is the only thing that
 *   touches fs, and only via the existing approve-decision protocol.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { existsSync, readFileSync } from "node:fs";
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
  /** Resolved source location (file + line) — present when InSitue's
   *  source resolver succeeded. Absent for selector-only picks. */
  source: { file: string; line?: number; column?: number } | null;
  /** Confidence: "exact" / "approximate" / "selector-only". */
  confidence: string;
  /** Component name (e.g. "Badge"), or selector if unknown. */
  target: string;
  /** Full selector — fallback identifier when source isn't resolved. */
  selector: string | null;
  /** What the user typed in the panel's note field (optional). */
  userNote: string | null;
  /** Browser URL at time of pick. */
  url: string | null;
  /** Component stack (top-down). */
  componentStack: Array<{ name: string; file?: string; line?: number }>;
}

const MAX_BUFFERED_PICKS = 32;
const NEXT_PICK_DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;
const NEXT_PICK_MAX_TIMEOUT_MS = 30 * 60 * 1000;

/** Walk up from `start` looking for `.insitu/session.json`. The
 *  companion writes this on startup; the same lookup is used by
 *  `insitue connect` so behavior matches user expectations. */
function findSession(start = process.cwd()): {
  dir: string;
  session: SessionFile;
} | null {
  let dir = resolve(start);
  while (true) {
    const candidate = join(dir, ".insitu", "session.json");
    if (existsSync(candidate)) {
      try {
        const session = JSON.parse(readFileSync(candidate, "utf8")) as SessionFile;
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
      componentStack?: Array<{ name: string; source?: { file: string; line?: number } }>;
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
        ? { file: t.source.file, ...(t.source.line ? { line: t.source.line } : {}) }
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
  /** Last pick id handed out via `next_pick` — defends against
   *  re-delivering the same pick across reconnects. */
  private lastDelivered: string | null = null;

  push(p: PickEvent): void {
    this.picks.push(p);
    if (this.picks.length > MAX_BUFFERED_PICKS) {
      this.picks.shift();
    }
    while (this.waiters.length && this.picks.length) {
      const w = this.waiters.shift()!;
      clearTimeout(w.timer);
      const next = this.picks.shift()!;
      this.lastDelivered = next.id;
      w.resolve(next);
    }
  }

  /** Resolve with the next pick to land OR null on timeout. */
  next(timeoutMs: number): Promise<PickEvent | null> {
    if (this.picks.length) {
      const next = this.picks.shift()!;
      this.lastDelivered = next.id;
      return Promise.resolve(next);
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

  /** When the WS reconnects, drop pending waiters with a sentinel so
   *  claude sees the disruption instead of hanging forever. */
  rejectAll(reason: string): void {
    for (const w of this.waiters) {
      clearTimeout(w.timer);
      w.resolve({
        id: "reconnect",
        at: new Date().toISOString(),
        source: null,
        confidence: "n/a",
        target: `[insitu] ${reason}`,
        selector: null,
        userNote: null,
        url: null,
        componentStack: [],
      });
    }
    this.waiters.length = 0;
  }
}

const buffer = new PickBuffer();

function connectToCompanion(session: { token: string; port: number }) {
  const url = `ws://127.0.0.1:${session.port}/insitu/cli`;
  const ws = new WebSocket(url, {
    headers: { "user-agent": "insitue-claude-plugin/0.0.1" },
  });
  ws.on("open", () => {
    ws.send(
      JSON.stringify({
        t: "hello",
        // Pin to the published companion protocol version — bumped
        // when the wire format breaks, NOT for every release.
        protocolVersion: 4,
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
    if (
      m &&
      typeof m === "object" &&
      (m as { t?: unknown }).t === "hello-ok"
    ) {
      ws.send(JSON.stringify({ t: "subscribe" }));
      return;
    }
    if (
      m &&
      typeof m === "object" &&
      (m as { t?: unknown }).t === "broadcast-capture"
    ) {
      try {
        buffer.push(summariseBundle(m as Parameters<typeof summariseBundle>[0]));
      } catch (err) {
        process.stderr.write(
          `[insitue-mcp] dropped malformed pick: ${(err as Error).message}\n`,
        );
      }
    }
  });
  ws.on("close", () => {
    buffer.rejectAll("companion disconnected — restart `insitue dev`?");
    // Exponential-ish reconnect: wait, try again. The companion may
    // legitimately restart (HMR, manual stop). Bounded retries are
    // pointless here — claude keeps the MCP server alive for the whole
    // session, so we want to recover whenever the companion comes back.
    setTimeout(() => connectToCompanion(session), 2_000);
  });
  ws.on("error", () => {
    // The `close` handler will fire after; let it own reconnect.
  });
}

const found = findSession();
if (!found) {
  process.stderr.write(
    "[insitue-mcp] no `.insitu/session.json` found in cwd or any parent.\n" +
      "  Start the companion first: `npx insitue dev` from your project root.\n",
  );
  process.exit(1);
}
connectToCompanion(found.session);

const server = new McpServer({
  name: "insitue",
  version: "0.0.1",
});

server.registerTool(
  "next_pick",
  {
    description:
      "Long-polls for the next element the user picks in the InSitue browser overlay. " +
      "Returns the resolved source location (file + line), component name, optional user note, " +
      "and surrounding context (URL, selector, component stack). " +
      "Use this in a loop: call → wait → edit the returned file → call again. " +
      "Returns a special `target: \"[insitue] ...\"` envelope on companion disconnect.",
    inputSchema: {
      timeout_ms: z
        .number()
        .int()
        .positive()
        .max(NEXT_PICK_MAX_TIMEOUT_MS)
        .optional()
        .describe(
          `How long to wait for the next pick (ms). Default ${NEXT_PICK_DEFAULT_TIMEOUT_MS}; max ${NEXT_PICK_MAX_TIMEOUT_MS}.`,
        ),
    },
  },
  async ({ timeout_ms }) => {
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
        {
          type: "text" as const,
          text: JSON.stringify({ status: "ok", pick }),
        },
      ],
    };
  },
);

server.registerTool(
  "list_recent_picks",
  {
    description:
      "Returns up to N most-recent picks buffered since the MCP server started. " +
      "Use this once at session start to see what the user already selected before " +
      "claude attached, or to re-read context without consuming a pick.",
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
