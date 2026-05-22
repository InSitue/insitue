#!/usr/bin/env node
/**
 * InSitue MCP bridge — connects a `claude` session (Code OR Desktop)
 * to the local InSitue companion's pick stream so users can drive
 * the agent FROM the browser overlay instead of typing file/line
 * by hand.
 *
 * Runtimes:
 *   - Claude Code: installed via the marketplace plugin
 *     (`InSitue/insitue` → `insitue@insitue-plugins`). Plugin.json
 *     pins `cwd: ${CLAUDE_PROJECT_DIR}`; slash command
 *     `/insitue:connect` kicks off the loop.
 *   - Claude Desktop: configured via
 *     `claude_desktop_config.json` with
 *     `INSITUE_PROJECT_DIR` env var (or a `--project-dir` arg).
 *     The user opens a new chat and tells claude to call
 *     `start_session` — same instructions, no slash commands
 *     required.
 *
 * Lifecycle:
 *
 *   1. Resolve the project dir (argv → INSITUE_PROJECT_DIR →
 *      CLAUDE_PROJECT_DIR → walk-up for .insitue/ → walk-up for
 *      package.json → cwd). See `project-dir.ts`.
 *   2. `ensureCompanion()` checks for an existing companion at
 *      `<projectDir>/.insitue/session.json`. If one is alive on
 *      its port, reuse it. Otherwise spawn one via
 *      `npx -y @insitue/companion@latest dev` as a child process,
 *      poll for the new session.json, and connect.
 *   3. Spawned children are killed cleanly on `process.exit` and
 *      `SIGTERM`; reused-external companions are left alone.
 *   4. WS subscription drains `broadcast-capture` events into an
 *      in-memory `PickBuffer`. `next_pick` long-polls; claude calls
 *      it in a loop.
 *
 * Tools exposed:
 *   - start_session     (instructions + state — Desktop entry point)
 *   - list_recent_picks (catch up on buffered picks)
 *   - next_pick         (long-poll for the next pick)
 *   - diagnose          (health check)
 *   - read_file         (project-scoped file read — Desktop fallback)
 *   - apply_edit        (project-scoped string replacement)
 *   - write_file        (project-scoped full-file write)
 *
 * Prompts: `connect` (the same operating instructions).
 * Resources: `insitue://instructions`, `insitue://readme`.
 *
 * Hard rules: loopback-only, token-auth via `.insitue/session.json`,
 * file tools are scoped to the resolved project dir.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import { z } from "zod";
import { diagnose } from "./diagnose.js";
import {
  applyEditInProject,
  readFileInProject,
  writeFileInProject,
} from "./file-tools.js";
import { loadInstructions } from "./instructions.js";
import { resolveProjectDir } from "./project-dir.js";

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
  /** CMS attribution. Present when the picked element (or an
   *  ancestor) carries a `data-insitue-cms` attribute — host
   *  apps stamp this on CMS-rendered roots so reviewers know the
   *  content is editable in the CMS, not in the rendering
   *  component. `handle` is opaque to InSitue (host convention),
   *  e.g. `briefings:hairspray-chipping:body`. */
  cmsSource?: { handle: string; adminUrl?: string };
}

const MAX_BUFFERED_PICKS = 32;
// Short default long-poll. The slash command loops next_pick, so a
// short timeout = claude yields back to the chat regularly and the
// user's other questions get answered between calls instead of
// being queued for 5 minutes. Picks arrive instantly via WS push
// regardless of the timeout — the long-poll is just claude's way
// of saying "ping me when something happens".
const NEXT_PICK_DEFAULT_TIMEOUT_MS = 25 * 1000;
const NEXT_PICK_MAX_TIMEOUT_MS = 30 * 60 * 1000;

/** Load the session file from the resolved project dir. No walk-up
 *  needed — `resolveProjectDir()` already picked our anchor; we
 *  just look in its `.insitue/` subdirectory. */
function findSession(projectDir: string): {
  dir: string;
  session: SessionFile;
} | null {
  const candidate = join(projectDir, ".insitue", "session.json");
  if (!existsSync(candidate)) return null;
  try {
    const session = JSON.parse(
      readFileSync(candidate, "utf8"),
    ) as SessionFile;
    return { dir: projectDir, session };
  } catch {
    return null;
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
      cmsSource?: { handle: string; adminUrl?: string };
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
    ...(t?.cmsSource ? { cmsSource: t.cmsSource } : {}),
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

  /** WS dropped — release pending waiters silently. They resolve to
   *  `null` (same shape as a natural timeout), so the agent's
   *  next_pick loop just calls again and the auto-reconnect 2s
   *  timer heals the bridge invisibly. We previously synthesized a
   *  fake "reconnect" pick here; that surfaced HMR / plugin-reload
   *  blips to the user as if they were real picks and trained the
   *  agent to stop looping. The stderr trace at the close call site
   *  is the operator-visible signal; the agent stays quiet. */
  dropWaiters(): void {
    for (const w of this.waiters) {
      clearTimeout(w.timer);
      w.resolve(null);
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

/** Find or start a companion; resolve to the session info we'll use.
 *  Spawned companions inherit the resolved project dir as their cwd
 *  so they create `.insitue/` (and resolve customer source paths)
 *  in the right place even when claude was started from a parent
 *  directory or `$HOME`. */
async function ensureCompanion(projectDir: string): Promise<SessionFile | null> {
  const existing = findSession(projectDir);
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
    `[insitue-mcp] starting companion via \`npx -y @insitue/companion@latest dev\` in ${projectDir}…\n`,
  );
  ownedChild = spawn(
    "npx",
    ["-y", "@insitue/companion@latest", "dev"],
    {
      cwd: projectDir,
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
  // appearance + readability means "ready". 8s ceiling — beyond
  // that, npx is probably downloading a lot or something's wrong.
  // (Wider than 5s because cold `npx -y` on a fresh Desktop machine
  // legitimately takes longer than on a developer's CLI where npx
  // is hot.)
  const start = Date.now();
  while (Date.now() - start < 8000) {
    const found = findSession(projectDir);
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

// Module-level WS state — `endSession()` needs to close the active
// socket and cancel pending reconnects when the user disconnects.
let activeWs: WebSocket | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let disconnecting = false;

function connectToCompanion(s: SessionFile): void {
  const url = `ws://127.0.0.1:${s.port}/insitue/cli`;
  const ws = new WebSocket(url, {
    headers: { "user-agent": "insitue-claude-plugin" },
  });
  activeWs = ws;
  ws.on("open", () => {
    ws.send(
      JSON.stringify({
        t: "hello",
        // Pin to the companion's pinned protocol version. Bump
        // when the wire format breaks.
        protocolVersion: 5,
        token: s.token,
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
          const summary = summariseBundle(
            m as Parameters<typeof summariseBundle>[0],
          );
          buffer.push(summary);
          // Stderr ack so the user sees confirmation in their claude
          // transcript the moment the pick lands — they no longer
          // have to wait for the next_pick tool call to finish to
          // know it arrived.
          const note = summary.userNote
            ? summary.userNote.length > 60
              ? `${summary.userNote.slice(0, 57)}…`
              : summary.userNote
            : "(no description)";
          const where = summary.source
            ? `${summary.source.file}:${summary.source.line}`
            : summary.target;
          process.stderr.write(
            `[insitue] 📥 pick received — "${note}" @ ${where}\n`,
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
    if (activeWs === ws) activeWs = null;
    // Release pending waiters with `null` so the agent's next_pick
    // loop quietly polls again. No synthetic pick, no chat noise.
    buffer.dropWaiters();
    // User-initiated disconnect suppresses the reconnect loop —
    // otherwise endSession()'s close would just re-tether 2s later.
    if (disconnecting) return;
    // Observable in the user's CLI without bubbling up as a pick.
    process.stderr.write(
      "[insitue-mcp] companion link dropped — reconnecting in 2s\n",
    );
    // Auto-reconnect. The companion may legitimately restart (HMR,
    // user stopped + restarted, plugin reload). Bounded retries
    // would be wrong: claude keeps the MCP server alive for the
    // whole session, so we want to recover whenever the companion
    // is back.
    reconnectTimer = setTimeout(() => connectToCompanion(s), 2_000);
  });
  ws.on("error", () => {
    /* close handler owns reconnect */
  });
}

// ── Boot ────────────────────────────────────────────────────────────

const projectDir = resolveProjectDir();
process.stderr.write(
  `[insitue-mcp] project dir: ${projectDir.dir} (via ${projectDir.source})\n`,
);

let session: SessionFile | null = await ensureCompanion(projectDir.dir);
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
//
// After an `end_session` teardown we also use this on next attach
// to re-spawn the companion if needed (the user might've blown the
// session away and want to reconnect later in the same chat).
let attached = false;
/**
 * Two attach modes:
 *
 *   - `explicit: true`   — called from `start_session` or
 *     `list_recent_picks` (the user's "I want to connect" verbs).
 *     Clears the `disconnecting` flag and respawns the companion
 *     if needed. This is how reconnect-after-disconnect works.
 *
 *   - `explicit: false`  — called from `next_pick` (the loop).
 *     If `disconnecting` is set (user ran `end_session` /
 *     `/insitue:disconnect`), this is a NO-OP. We don't want a
 *     stale loop call to silently respawn the companion and
 *     re-light the browser launcher right after the user asked
 *     us to disconnect.
 */
async function ensureSubscriberAttached(
  opts: { explicit?: boolean } = {},
): Promise<void> {
  if (attached) return;
  if (disconnecting && !opts.explicit) return;
  disconnecting = false;
  if (!session) {
    session = await ensureCompanion(projectDir.dir);
    if (!session) return;
  }
  attached = true;
  connectToCompanion(session);
}

/** Symmetric teardown for the connect lifecycle. Closes the WS
 *  (subscriber count drops → browser launcher mutes), suppresses
 *  the auto-reconnect, kills the companion if we spawned it, and
 *  drops the stale session file. Safe to call multiple times. */
function endSession(): {
  closedWs: boolean;
  killedCompanion: boolean;
  removedSessionFile: boolean;
} {
  disconnecting = true;
  attached = false;
  let closedWs = false;
  let killedCompanion = false;
  let removedSessionFile = false;

  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  if (activeWs) {
    try {
      activeWs.close();
      closedWs = true;
    } catch {
      /* already closed */
    }
    activeWs = null;
  }
  if (ownedChild) {
    killedCompanion = true;
    cleanupOwnedChild();
  }
  // Clean up the session file IF we owned the companion that wrote
  // it. Without this, a future `/insitue:connect` would probe the
  // stale file, find the PID dead, and respawn — which works, but
  // is slower than a clean start. Reused-external companions
  // (cases where the user ran `insitue dev` themselves) keep their
  // session file: we didn't write it, we don't delete it.
  if (killedCompanion) {
    const f = join(projectDir.dir, ".insitue", "session.json");
    if (existsSync(f)) {
      try {
        rmSync(f);
        removedSessionFile = true;
      } catch {
        /* best-effort */
      }
    }
  }
  session = null;
  return { closedWs, killedCompanion, removedSessionFile };
}

const server = new McpServer({
  name: "insitue",
  version: "0.3.0",
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
    await ensureSubscriberAttached();
    if (disconnecting) {
      // The user ran `end_session` / `/insitue:disconnect`. Don't
      // silently respawn the companion just because the loop kept
      // calling next_pick. Surface a clear status so claude exits
      // the loop and tells the user how to reconnect.
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              status: "disconnected",
              message:
                "InSitue session was disconnected. Run /insitue:connect (Code) or call start_session (Desktop) to reattach.",
            }),
          },
        ],
      };
    }
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
    await ensureSubscriberAttached({ explicit: true });
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

// ── Desktop entry-point tool ────────────────────────────────────────

server.registerTool(
  "start_session",
  {
    description:
      "Returns the operating instructions for InSitue + current state " +
      "(project dir, companion reachable, buffered pick count). On " +
      "Claude Code you typically don't need this — the slash command " +
      "`/insitue:connect` already loaded the instructions. On Claude " +
      "Desktop there are no slash commands, so call this once at the " +
      "start of every session before entering the next_pick loop.",
    inputSchema: {},
  },
  async () => {
    await ensureSubscriberAttached({ explicit: true });
    const instructions = loadInstructions();
    const buffered = buffer.recent(32).length;
    const status =
      `\n\n---\n\n**Current state**\n\n` +
      `- Project: \`${projectDir.dir}\` (resolved via ${projectDir.source})\n` +
      `- Companion: ${session ? `reachable on port ${session.port}` : "NOT reachable"}\n` +
      `- Buffered picks waiting: ${buffered}\n\n` +
      "Begin the loop by calling `list_recent_picks` once, then loop " +
      "on `next_pick`.";
    return {
      content: [
        { type: "text" as const, text: instructions + status },
      ],
    };
  },
);

// ── Disconnect ──────────────────────────────────────────────────────

server.registerTool(
  "end_session",
  {
    description:
      "Cleanly disconnect this MCP from the InSitue companion: close " +
      "the WS subscriber (browser launcher mutes immediately), " +
      "suppress auto-reconnect, kill the companion if we spawned it, " +
      "and remove the stale session file. The user can reconnect " +
      "later in the same claude session via `/insitue:connect` " +
      "(Code) or by calling `start_session` again (Desktop). Safe " +
      "to call repeatedly. Returns what was actually torn down.",
    inputSchema: {},
  },
  async () => {
    const r = endSession();
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({ status: "disconnected", ...r }),
        },
      ],
    };
  },
);

// ── Diagnostics ─────────────────────────────────────────────────────

server.registerTool(
  "diagnose",
  {
    description:
      "Run a health check on the local InSitue setup — companion " +
      "reachability, SDK install, SWC plugin install + wiring, " +
      "session file freshness. Returns a structured report plus " +
      "human-readable recommendations. Use when picks don't seem to " +
      "be flowing.",
    inputSchema: {},
  },
  async () => {
    const report = await diagnose(projectDir);
    return {
      content: [
        { type: "text" as const, text: JSON.stringify(report, null, 2) },
      ],
    };
  },
);

// ── Project-scoped file tools (Desktop-first, harmless on Code) ─────

server.registerTool(
  "read_file",
  {
    description:
      "Read a file from the resolved project directory. Paths are " +
      "relative to the project root (or absolute, in which case " +
      "they must still live inside the project). Optional " +
      "`startLine`/`endLine` for partial reads. On Claude Code, " +
      "prefer the built-in Read tool — this exists primarily for " +
      "Claude Desktop, where no built-in file tools are available.",
    inputSchema: {
      path: z.string().describe("Project-relative or absolute path."),
      startLine: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("1-indexed start line (inclusive)."),
      endLine: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("1-indexed end line (inclusive)."),
    },
  },
  async ({ path, startLine, endLine }) => {
    const opts: { startLine?: number; endLine?: number } = {};
    if (startLine !== undefined) opts.startLine = startLine;
    if (endLine !== undefined) opts.endLine = endLine;
    const r = readFileInProject(projectDir.dir, path, opts);
    return {
      content: [
        { type: "text" as const, text: JSON.stringify(r) },
      ],
    };
  },
);

server.registerTool(
  "apply_edit",
  {
    description:
      "Apply a string-replacement edit to a file inside the project. " +
      "`oldString` must occur exactly once in the file (otherwise " +
      "pass `replaceAll: true`). Returns a status + brief summary. " +
      "ALWAYS ask the user for explicit approval before calling " +
      "this — InSitue's contract is human-in-the-loop on every " +
      "write. On Claude Code, prefer the built-in Edit tool.",
    inputSchema: {
      path: z.string().describe("Project-relative or absolute path."),
      oldString: z.string().describe("Exact text to replace."),
      newString: z.string().describe("Replacement text."),
      replaceAll: z
        .boolean()
        .optional()
        .describe(
          "Replace every occurrence of `oldString` instead of refusing on ambiguity.",
        ),
    },
  },
  async ({ path, oldString, newString, replaceAll }) => {
    const opts: { replaceAll?: boolean } = {};
    if (replaceAll !== undefined) opts.replaceAll = replaceAll;
    const r = applyEditInProject(
      projectDir.dir,
      path,
      oldString,
      newString,
      opts,
    );
    return {
      content: [
        { type: "text" as const, text: JSON.stringify(r) },
      ],
    };
  },
);

server.registerTool(
  "write_file",
  {
    description:
      "Write the full contents of a file inside the project. Use " +
      "for new files or full rewrites where `apply_edit`'s string " +
      "match isn't a good fit. ALWAYS ask the user for explicit " +
      "approval before calling. On Claude Code, prefer the built-in " +
      "Write tool.",
    inputSchema: {
      path: z.string().describe("Project-relative or absolute path."),
      content: z.string().describe("Full file contents to write."),
      createParents: z
        .boolean()
        .optional()
        .describe("Create parent directories if they don't exist."),
    },
  },
  async ({ path, content, createParents }) => {
    const opts: { createParents?: boolean } = {};
    if (createParents !== undefined) opts.createParents = createParents;
    const r = writeFileInProject(projectDir.dir, path, content, opts);
    return {
      content: [
        { type: "text" as const, text: JSON.stringify(r) },
      ],
    };
  },
);

// ── MCP prompts (Claude Desktop surfaces these natively) ────────────

server.registerPrompt(
  "connect",
  {
    title: "Connect to InSitue",
    description:
      "Loads the operating instructions and begins the pick → edit loop.",
  },
  () => ({
    messages: [
      {
        role: "user",
        content: { type: "text", text: loadInstructions() },
      },
    ],
  }),
);

// ── MCP resources — let Desktop render the docs in-app ──────────────

function readPkgFile(rel: string): string | null {
  const here = dirname(fileURLToPath(import.meta.url));
  for (const base of [join(here, ".."), here]) {
    const p = join(base, rel);
    if (existsSync(p)) {
      try {
        return readFileSync(p, "utf8");
      } catch {
        return null;
      }
    }
  }
  return null;
}

server.registerResource(
  "instructions",
  "insitue://instructions",
  {
    title: "InSitue operating instructions",
    description:
      "The same content that drives `/insitue:connect` on Code and `start_session` on Desktop.",
    mimeType: "text/markdown",
  },
  async () => ({
    contents: [
      {
        uri: "insitue://instructions",
        mimeType: "text/markdown",
        text: loadInstructions(),
      },
    ],
  }),
);

server.registerResource(
  "readme",
  "insitue://readme",
  {
    title: "@insitue/claude-plugin README",
    description: "Package overview, setup steps, and runtime notes.",
    mimeType: "text/markdown",
  },
  async () => ({
    contents: [
      {
        uri: "insitue://readme",
        mimeType: "text/markdown",
        text:
          readPkgFile("README.md") ??
          "README not bundled — see https://github.com/InSitue/insitue/tree/main/packages/claude-plugin",
      },
    ],
  }),
);

await server.connect(new StdioServerTransport());
