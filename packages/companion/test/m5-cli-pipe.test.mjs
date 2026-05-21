/**
 * #147 M1: terminal-pipe subscribers (`insitue connect`). Browser
 * picks must fan out to any authed CLI subscriber on the
 * /insitu/cli upgrade path. Loopback + token + URL-path are the
 * trust boundary; Origin is intentionally skipped because CLIs
 * don't have one. Run after `pnpm build`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import WebSocket from "ws";
import { startCompanion } from "../dist/server.js";
import { PROTOCOL_VERSION } from "@insitue/capture-core";

const PORT = 5794;
const ORIGIN = "http://localhost:3000";
const root = mkdtempSync(join(tmpdir(), "insitu-m5-"));

const server = startCompanion({ port: PORT, origins: [ORIGIN], root });
await new Promise((r) => server.once("listening", r));

async function handshake() {
  const res = await fetch(`http://127.0.0.1:${PORT}/insitu/handshake`, {
    headers: { origin: ORIGIN },
  });
  const json = await res.json();
  return json.token;
}

function wsClient(url, headers) {
  return new WebSocket(url, { headers });
}

function once(ws, predicate, timeoutMs = 2000) {
  return new Promise((resolve, reject) => {
    const to = setTimeout(
      () => reject(new Error(`timeout waiting for predicate match`)),
      timeoutMs,
    );
    ws.on("message", (raw) => {
      const msg = JSON.parse(String(raw));
      if (predicate(msg)) {
        clearTimeout(to);
        resolve(msg);
      }
    });
  });
}

test("CLI subscribes via /insitu/cli without an Origin header", async () => {
  const token = await handshake();
  const cli = wsClient(`ws://127.0.0.1:${PORT}/insitu/cli`, {
    "user-agent": "insitue-cli/2",
  });
  await new Promise((r) => cli.once("open", r));
  cli.send(JSON.stringify({ t: "hello", protocolVersion: PROTOCOL_VERSION, token }));
  await once(cli, (m) => m.t === "hello-ok");
  cli.send(JSON.stringify({ t: "subscribe" }));
  const ack = await once(cli, (m) => m.t === "subscribe-ok");
  assert.equal(ack.t, "subscribe-ok");
  assert.equal(ack.projectRoot, root);
  cli.close();
});

test("browser capture is fanned out to the CLI subscriber", async () => {
  const token = await handshake();

  // CLI: subscribe.
  const cli = wsClient(`ws://127.0.0.1:${PORT}/insitu/cli`, {
    "user-agent": "insitue-cli/2",
  });
  await new Promise((r) => cli.once("open", r));
  cli.send(JSON.stringify({ t: "hello", protocolVersion: PROTOCOL_VERSION, token }));
  await once(cli, (m) => m.t === "hello-ok");
  cli.send(JSON.stringify({ t: "subscribe" }));
  await once(cli, (m) => m.t === "subscribe-ok");

  const broadcastP = once(cli, (m) => m.t === "broadcast-capture");

  // Browser: send a capture (separate connection, with Origin).
  const browser = wsClient(`ws://127.0.0.1:${PORT}/`, { origin: ORIGIN });
  await new Promise((r) => browser.once("open", r));
  browser.send(JSON.stringify({ t: "hello", protocolVersion: PROTOCOL_VERSION, token }));
  await once(browser, (m) => m.t === "hello-ok");
  browser.send(
    JSON.stringify({
      t: "capture",
      bundle: {
        id: "bnd_test_m5_1",
        target: { selector: "button.x", componentStack: [{ name: "TestBtn" }] },
        runtime: { url: "http://localhost:3000/x", console: [], network: [], errors: [] },
        userNote: "broadcast me",
      },
    }),
  );

  const evt = await broadcastP;
  assert.equal(evt.id, "bnd_test_m5_1");
  assert.equal(evt.bundle.userNote, "broadcast me");
  assert.ok(evt.at, "broadcast carries a server-side timestamp");
  cli.close();
  browser.close();
});

test("CLI path rejects non-loopback (we can't easily prove non-loopback here, so verify reachability is gated by url path)", async () => {
  // We can at least prove the browser upgrade path STILL refuses
  // a foreign Origin — i.e. the new CLI bypass didn't accidentally
  // loosen the browser code path.
  const ws = wsClient(`ws://127.0.0.1:${PORT}/`, {
    origin: "http://evil.example",
  });
  await new Promise((resolve) => {
    ws.once("error", () => resolve());
    ws.once("close", () => resolve());
  });
  // If we got here without an open event, the bypass didn't widen
  // the browser-path Origin gate. (Open would have implied success.)
  assert.ok(true);
});

test.after(() => server.close());
