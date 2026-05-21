/**
 * M0 trust-boundary tests — proves the companion's security model:
 * loopback bind, Origin pinning, per-session token, protocol version,
 * and a working secure ping round-trip. Run after `pnpm build`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import WebSocket from "ws";
import { startCompanion } from "../dist/server.js";
import { PROTOCOL_VERSION } from "@insitue/capture-core";

const PORT = 5793;
const GOOD_ORIGIN = "http://localhost:3000";
const BAD_ORIGIN = "http://evil.example";
const root = mkdtempSync(join(tmpdir(), "insitue-m0-"));

const server = startCompanion({ port: PORT, origins: [GOOD_ORIGIN], root });
await new Promise((r) => server.once("listening", r));

test("binds loopback only", () => {
  const addr = server.address();
  assert.equal(typeof addr, "object");
  assert.equal(addr.address, "127.0.0.1");
});

test("handshake rejects a foreign Origin (403)", async () => {
  const res = await fetch(`http://127.0.0.1:${PORT}/insitue/handshake`, {
    headers: { origin: BAD_ORIGIN },
  });
  assert.equal(res.status, 403);
});

test("handshake issues a token to the pinned Origin", async () => {
  const res = await fetch(`http://127.0.0.1:${PORT}/insitue/handshake`, {
    headers: { origin: GOOD_ORIGIN },
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok(typeof body.token === "string" && body.token.length > 0);
});

function open(origin, token, { protocolVersion = PROTOCOL_VERSION } = {}) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}`, { origin });
    const msgs = [];
    ws.on("message", (d) => msgs.push(JSON.parse(String(d))));
    ws.on("open", () =>
      ws.send(JSON.stringify({ t: "hello", protocolVersion, token })),
    );
    ws.on("close", () => resolve({ msgs }));
    ws.on("error", () => resolve({ msgs, errored: true }));
    setTimeout(() => resolve({ ws, msgs }), 400);
  });
}

test("WS upgrade refused for a foreign Origin", async () => {
  const { errored, msgs } = await open(BAD_ORIGIN, "whatever");
  assert.ok(errored || msgs.length === 0);
});

test("WS rejects a bad token", async () => {
  const { token } = await (
    await fetch(`http://127.0.0.1:${PORT}/insitue/handshake`, {
      headers: { origin: GOOD_ORIGIN },
    })
  ).json();
  const { msgs } = await open(GOOD_ORIGIN, token + "x");
  assert.ok(msgs.some((m) => m.t === "error" && m.code === "bad-token"));
});

test("WS rejects a bad protocol version", async () => {
  const { token } = await (
    await fetch(`http://127.0.0.1:${PORT}/insitue/handshake`, {
      headers: { origin: GOOD_ORIGIN },
    })
  ).json();
  const { msgs } = await open(GOOD_ORIGIN, token, { protocolVersion: 999 });
  assert.ok(msgs.some((m) => m.t === "error" && m.code === "bad-protocol"));
});

test("secure ping round-trip on a valid session", async () => {
  const { token } = await (
    await fetch(`http://127.0.0.1:${PORT}/insitue/handshake`, {
      headers: { origin: GOOD_ORIGIN },
    })
  ).json();
  const result = await new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}`, { origin: GOOD_ORIGIN });
    const seen = [];
    ws.on("message", (d) => {
      const m = JSON.parse(String(d));
      seen.push(m);
      if (m.t === "hello-ok") ws.send(JSON.stringify({ t: "ping", nonce: "abc" }));
      if (m.t === "pong") {
        ws.close();
        resolve(seen);
      }
    });
    ws.on("open", () =>
      ws.send(
        JSON.stringify({ t: "hello", protocolVersion: PROTOCOL_VERSION, token }),
      ),
    );
    ws.on("error", reject);
    setTimeout(() => reject(new Error("ping timeout")), 2000);
  });
  assert.ok(result.some((m) => m.t === "hello-ok"));
  const pong = result.find((m) => m.t === "pong");
  assert.equal(pong?.nonce, "abc");
});

test.after(() => server.close());
