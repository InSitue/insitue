/**
 * InSitu companion server — the trust boundary.
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
} from "@insitu/capture-core";
import { resolveCapture } from "./capture.js";
import { AgentOrchestrator } from "./agent/orchestrator.js";

export const COMPANION_VERSION = "0.0.0";

export type AgentTransport = "cli-headless" | "mcp" | "sdk";

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
]);

function send(ws: WebSocket, msg: ServerMessage): void {
  ws.send(JSON.stringify(msg));
}

export function startCompanion(opts: CompanionOptions): Server {
  if (process.env.NODE_ENV === "production") {
    throw new Error(
      "[insitu] refusing to start under NODE_ENV=production — InSitu is a localhost dev tool.",
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

  http.on("upgrade", (req, socket, head) => {
    if (!isLoopback(req) || !originOk(req)) {
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
          orchestrator = new AgentOrchestrator({
            root: opts.root,
            transport: opts.transport ?? "cli-headless",
            allowApiKey: opts.allowApiKey ?? false,
            send: (m) => send(ws, m),
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
    });
  });

  http.listen(opts.port, "127.0.0.1");
  return http;
}
