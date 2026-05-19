/**
 * M2-P0: the agent message path is wired end-to-end (protocol v2).
 * Auth → agent-status announced → agent-turn routed → agent-stream
 * (P0 stub error). Proves the seam before any provider exists.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import WebSocket from "ws";
import { startCompanion } from "../dist/server.js";
import { PROTOCOL_VERSION } from "@insitu/capture-core";

const PORT = 5795;
const ORIGIN = "http://localhost:3000";
const root = mkdtempSync(join(tmpdir(), "insitu-m2-"));
const server = startCompanion({ port: PORT, origins: [ORIGIN], root });
await new Promise((r) => server.once("listening", r));

async function token() {
  const res = await fetch(`http://127.0.0.1:${PORT}/insitu/handshake`, {
    headers: { origin: ORIGIN },
  });
  return (await res.json()).token;
}

test("protocol version is pinned (v4 — M6 agent-activity)", () => {
  assert.equal(PROTOCOL_VERSION, 4);
});

test("authed session announces agent-status, then routes agent-turn", async () => {
  const tk = await token();
  const seen = await new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}`, { origin: ORIGIN });
    const msgs = [];
    const done = () => {
      const hasStatus = msgs.some((m) => m.t === "agent-status");
      const hasStream = msgs.some(
        (m) => m.t === "agent-stream" && m.event.t === "agent-error",
      );
      if (hasStatus && hasStream) {
        ws.close();
        resolve(msgs);
      }
    };
    ws.on("message", (d) => {
      const m = JSON.parse(String(d));
      msgs.push(m);
      if (m.t === "hello-ok") {
        ws.send(
          JSON.stringify({
            t: "agent-turn",
            turnId: "t1",
            bundleId: "b1",
            userMessage: "hi",
          }),
        );
      }
      done();
    });
    ws.on("open", () =>
      ws.send(
        JSON.stringify({ t: "hello", protocolVersion: PROTOCOL_VERSION, token: tk }),
      ),
    );
    ws.on("error", reject);
    setTimeout(() => reject(new Error("timeout")), 12000);
  });
  assert.ok(seen.some((m) => m.t === "agent-status"));
  const err = seen.find((m) => m.t === "agent-stream")?.event;
  assert.equal(err.t, "agent-error");
  assert.equal(err.turnId, "t1");
});

test("malformed agent-decision is rejected by zod", async () => {
  const tk = await token();
  const got = await new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}`, { origin: ORIGIN });
    ws.on("message", (d) => {
      const m = JSON.parse(String(d));
      if (m.t === "hello-ok") {
        ws.send(JSON.stringify({ t: "agent-decision", turnId: "x" })); // missing `decision`
      }
      if (m.t === "error") {
        ws.close();
        resolve(m);
      }
    });
    ws.on("open", () =>
      ws.send(
        JSON.stringify({ t: "hello", protocolVersion: PROTOCOL_VERSION, token: tk }),
      ),
    );
    ws.on("error", reject);
    setTimeout(() => reject(new Error("timeout")), 2000);
  });
  assert.equal(got.code, "bad-protocol");
});

test.after(() => server.close());
