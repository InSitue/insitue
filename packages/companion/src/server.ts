/**
 * InSitue companion server — the trust boundary.
 *
 * Hard rules (M0): bind loopback ONLY; pin Origin to the dev app;
 * require a per-session token; validate every client message with zod
 * against the pinned protocol version; refuse to run under a prod
 * build. The browser never touches fs/git — that lives behind the
 * (future) EditGateway, never here in the transport layer.
 */
import { createServer, type IncomingMessage, type Server } from "node:http";
import { randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { WebSocketServer, type WebSocket } from "ws";
import { z } from "zod";
import {
  PROTOCOL_VERSION,
  type AgentCancelMsg,
  type AgentCommitSessionMsg,
  type AgentDecisionMsg,
  type AgentTurnMsg,
  type AgentUndoMsg,
  type AgentUndoSessionMsg,
  type CaptureBundle,
  type ServerMessage,
} from "@insitue/capture-core";
import { resolveCapture } from "./capture.js";
import { AgentOrchestrator } from "./agent/orchestrator.js";

export const COMPANION_VERSION = "0.0.0";

export type AgentTransport = "cli-headless" | "mcp" | "sdk";

// Re-export so callers (tests, embedders) can construct providers
// without reaching into agent-core's deep path.
export type { AgentProvider } from "@insitue/agent-core/orchestrator";
import type { AgentProvider } from "@insitue/agent-core/orchestrator";

export interface CompanionOptions {
  port: number;
  /** Agent transport (default cli-headless). */
  transport?: AgentTransport;
  /** Allow ANTHROPIC_API_KEY to reach the agent (bills API, not Max). */
  allowApiKey?: boolean;
  /** Allowed browser Origins (the running dev app). */
  origins: string[];
  /** Absolute project root the companion is scoped to. */
  root: string;
  /** Test seam — inject a deterministic `AgentProvider` for e2e tests
   *  that can't depend on Claude Max billing. Plumbed through to
   *  `AgentOrchestrator` for each WS session. Undefined in production. */
  provider?: AgentProvider;
}

const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

function isLoopback(req: IncomingMessage): boolean {
  const addr = req.socket.remoteAddress ?? "";
  return LOOPBACK.has(addr);
}

const clientMessage = z.discriminatedUnion("t", [
  z.object({
    t: z.literal("hello"),
    protocolVersion: z.number(),
    token: z.string().min(1),
  }),
  z.object({ t: z.literal("ping"), nonce: z.string().min(1) }),
  z.object({
    t: z.literal("capture"),
    // Bundle is large/nested; validate only what we act on, pass the
    // rest through untouched.
    bundle: z
      .object({ id: z.string().min(1) })
      .passthrough(),
  }),
  z.object({
    t: z.literal("agent-turn"),
    turnId: z.string().min(1),
    bundleId: z.string().min(1),
    userMessage: z.string(),
  }),
  // #162: routes the user's ASK Send through CLI/MCP subscribers
  // instead of spawning the in-overlay headless agent. Only valid
  // when subscribers.size > 0; the browser checks first.
  z.object({
    t: z.literal("agent-ask-external"),
    turnId: z.string().min(1),
    bundleId: z.string().min(1),
    text: z.string(),
  }),
  z.object({
    t: z.literal("agent-decision"),
    turnId: z.string().min(1),
    decision: z.enum(["approve", "reject"]),
    files: z.array(z.string()).optional(),
    reason: z.string().optional(),
  }),
  z.object({ t: z.literal("agent-cancel"), turnId: z.string().min(1) }),
  z.object({ t: z.literal("agent-undo"), turnId: z.string().min(1) }),
  z.object({ t: z.literal("agent-undo-session") }),
  z.object({
    t: z.literal("agent-commit-session"),
    message: z.string().optional(),
  }),
  // #147 M1: terminal-pipe subscribers (`insitue connect`).
  // Subscribers are read-only listeners on the same loopback +
  // token-auth path browsers use; they receive a broadcast event
  // every time a browser pick lands so the dev's CLI / claude /
  // aider can consume the selection.
  z.object({ t: z.literal("subscribe") }),
]);

function send(ws: WebSocket, msg: ServerMessage): void {
  ws.send(JSON.stringify(msg));
}

export function startCompanion(opts: CompanionOptions): Server {
  if (process.env.NODE_ENV === "production") {
    throw new Error(
      "[insitu] refusing to start under NODE_ENV=production — InSitue is a localhost dev tool.",
    );
  }

  // Per-session token. Written to .insitu/session.json (gitignored) so
  // the dev app can read it; printed too. NOTE (M1): tighten delivery
  // so only the dev server — not any local process — can obtain it.
  const token = randomBytes(24).toString("base64url");
  const sessionDir = join(opts.root, ".insitu");
  mkdirSync(sessionDir, { recursive: true });
  writeFileSync(
    join(sessionDir, "session.json"),
    JSON.stringify({ token, port: opts.port, pid: process.pid }, null, 2),
  );

  const originOk = (req: IncomingMessage): boolean => {
    const origin = req.headers.origin;
    return typeof origin === "string" && opts.origins.includes(origin);
  };

  const http = createServer((req, res) => {
    // Loopback-only, Origin-pinned token handshake.
    if (req.method === "GET" && req.url === "/insitu/handshake") {
      if (!isLoopback(req) || !originOk(req)) {
        res.writeHead(403).end("forbidden");
        return;
      }
      res.writeHead(200, {
        "content-type": "application/json",
        "access-control-allow-origin": req.headers.origin as string,
        "cache-control": "no-store",
      });
      res.end(JSON.stringify({ token, companionVersion: COMPANION_VERSION }));
      return;
    }
    res.writeHead(404).end("not found");
  });

  const wss = new WebSocketServer({ noServer: true });

  // #147 M1: terminal-pipe subscribers (`insitue connect`). Set of
  // authed WS connections that want a copy of every capture event
  // (the dev's CLI prints/forwards them). Loopback + token is the
  // auth boundary; the URL path is just the "I'm a CLI, skip the
  // browser Origin check that doesn't apply to me" signal.
  const subscribers = new Set<WebSocket>();
  // #162: authed browser clients we send `subscribers-attached`
  // presence pushes to. The overlay listens for these to toggle
  // its "→ claude in terminal" badge and route Send to external.
  const browserClients = new Set<WebSocket>();
  const CLI_PATH = "/insitu/cli";

  function broadcastSubscriberCount(): void {
    const msg = JSON.stringify({
      t: "subscribers-attached",
      count: subscribers.size,
    });
    for (const c of browserClients) {
      if (c.readyState === c.OPEN) c.send(msg);
    }
  }

  http.on("upgrade", (req, socket, head) => {
    if (!isLoopback(req)) {
      socket.destroy();
      return;
    }
    const isCli = req.url === CLI_PATH;
    // Browser connections must pass the Origin allowlist
    // (anti-DNS-rebinding). CLI connections are loopback + token-
    // gated below (no browser Origin to check; the dev opted into
    // the connection from their own terminal).
    if (!isCli && !originOk(req)) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      let authed = false;
      let orchestrator: AgentOrchestrator | null = null;
      ws.on("message", (raw) => {
        let parsed: unknown;
        try {
          parsed = JSON.parse(String(raw));
        } catch {
          send(ws, { t: "error", code: "internal", message: "bad json" });
          return;
        }
        const r = clientMessage.safeParse(parsed);
        if (!r.success) {
          send(ws, {
            t: "error",
            code: "bad-protocol",
            message: "unrecognized message",
          });
          return;
        }
        const msg = r.data;
        if (msg.t === "hello") {
          if (msg.protocolVersion !== PROTOCOL_VERSION) {
            send(ws, {
              t: "error",
              code: "bad-protocol",
              message: `protocol ${PROTOCOL_VERSION} required`,
            });
            ws.close();
            return;
          }
          if (msg.token !== token) {
            send(ws, {
              t: "error",
              code: "bad-token",
              message: "invalid session token",
            });
            ws.close();
            return;
          }
          authed = true;
          send(ws, { t: "hello-ok", companionVersion: COMPANION_VERSION });
          // #162: track browser clients (NOT CLI subscribers) so we
          // can push subscribers-attached presence updates to them
          // when CLI subscribers come and go. Browser clients are
          // identified by NOT being on the CLI path.
          if (!isCli) {
            browserClients.add(ws);
            // Initial sync so the badge reflects current state
            // even if the subscriber connected before the browser.
            send(ws, {
              t: "subscribers-attached",
              count: subscribers.size,
            } as unknown as ServerMessage);
          }
          orchestrator = new AgentOrchestrator({
            root: opts.root,
            transport: opts.transport ?? "cli-headless",
            allowApiKey: opts.allowApiKey ?? false,
            send: (m) => send(ws, m),
            // exactOptionalPropertyTypes: don't pass `provider: undefined`,
            // omit the key entirely if no override.
            ...(opts.provider ? { provider: opts.provider } : {}),
          });
          void orchestrator.announce();
          return;
        }
        if (!authed) {
          send(ws, {
            t: "error",
            code: "bad-token",
            message: "say hello first",
          });
          ws.close();
          return;
        }
        if (msg.t === "ping") {
          send(ws, { t: "pong", nonce: msg.nonce });
          return;
        }
        if (msg.t === "capture") {
          const bundle = msg.bundle as unknown as CaptureBundle;
          const { resolved, note } = resolveCapture(opts.root, bundle);
          console.log(`[insitu] capture ${bundle.id}: ${note}`);
          orchestrator?.registerBundle(bundle, resolved);
          send(ws, {
            t: "capture-resolved",
            id: bundle.id,
            resolved,
            note,
          });
          // Fan out to terminal-pipe subscribers (`insitue connect`).
          // We send the bundle alongside so the CLI has everything it
          // needs to format pretty / NDJSON output without a round-trip.
          const broadcast = {
            t: "broadcast-capture" as const,
            id: bundle.id,
            bundle,
            resolved,
            note,
            at: new Date().toISOString(),
          };
          for (const sub of subscribers) {
            if (sub.readyState === sub.OPEN) {
              sub.send(JSON.stringify(broadcast));
            }
          }
          return;
        }
        if (msg.t === "subscribe") {
          subscribers.add(ws);
          send(ws, {
            t: "subscribe-ok",
            companionVersion: COMPANION_VERSION,
            projectRoot: opts.root,
          } as unknown as ServerMessage);
          // #162: tell every browser the count changed so badges
          // light up in real time.
          broadcastSubscriberCount();
          return;
        }
        if (msg.t === "agent-ask-external") {
          // #162: re-broadcast the user's typed intent to all CLI/
          // MCP subscribers. Do NOT spawn the in-overlay headless
          // agent — the external claude is the source of truth for
          // this turn. The subscriber (MCP bridge) joins this with
          // the matching `broadcast-capture` by `bundleId`.
          const askMsg = JSON.stringify({
            t: "broadcast-ask" as const,
            bundleId: msg.bundleId,
            text: msg.text,
            at: new Date().toISOString(),
          });
          for (const sub of subscribers) {
            if (sub.readyState === sub.OPEN) sub.send(askMsg);
          }
          return;
        }
        // zod `.optional()` widens to `T | undefined`; the pure
        // message types use `T?` (exactOptionalPropertyTypes). The
        // structure is already validated — cast at the boundary, same
        // pattern as the `capture` bundle above.
        if (msg.t === "agent-turn") {
          orchestrator?.handleTurn(msg as unknown as AgentTurnMsg);
        } else if (msg.t === "agent-decision") {
          orchestrator?.handleDecision(msg as unknown as AgentDecisionMsg);
        } else if (msg.t === "agent-cancel") {
          orchestrator?.handleCancel(msg as unknown as AgentCancelMsg);
        } else if (msg.t === "agent-undo") {
          orchestrator?.handleUndo(msg as unknown as AgentUndoMsg);
        } else if (msg.t === "agent-undo-session") {
          orchestrator?.handleUndoSession(
            msg as unknown as AgentUndoSessionMsg,
          );
        } else if (msg.t === "agent-commit-session") {
          orchestrator?.handleCommitSession(
            msg as unknown as AgentCommitSessionMsg,
          );
        }
      });
      // Subscribers stay in the set until they disconnect — without
      // this, broadcasts would pile up writes to dead sockets and
      // throw inside the loop above. #162: also broadcast the new
      // (lower) count to browsers so the badge clears.
      ws.on("close", () => {
        const wasSubscriber = subscribers.delete(ws);
        browserClients.delete(ws);
        if (wasSubscriber) broadcastSubscriberCount();
      });
    });
  });

  http.listen(opts.port, "127.0.0.1");
  return http;
}
