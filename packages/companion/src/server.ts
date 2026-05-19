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
  type ServerMessage,
} from "@insitu/capture-core";

export const COMPANION_VERSION = "0.0.0";

export interface CompanionOptions {
  port: number;
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
        }
      });
    });
  });

  http.listen(opts.port, "127.0.0.1");
  return http;
}
