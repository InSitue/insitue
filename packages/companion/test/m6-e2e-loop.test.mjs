/**
 * Full agentic-loop integration test. Spins up the real companion
 * server against a scratch git repo, drives the public WS protocol
 * exactly as the browser overlay does, and asserts each handoff:
 *
 *   hello → capture-resolved → agent-turn → changeset-proposed →
 *   agent-decision(approve) → changeset-applied → file changed on
 *   disk → agent-undo → agent-undone → file reverted.
 *
 * The LLM is swapped out via `StubAgentProvider` so the test is
 * deterministic and doesn't depend on Claude Max billing. Everything
 * BELOW the LLM seam (parseProposals, buildChangeset, applyEdits,
 * checkpoint/restore, WS protocol/zod, orchestrator state machine,
 * approval gate) runs the production code path.
 *
 * This is the regression net the funnel relies on — if any of these
 * handoffs breaks, the dev-tool demo embarrasses the brand. Fails
 * loudly in CI so a broken patch never reaches main.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { join } from "node:path";
import WebSocket from "ws";
import { startCompanion } from "../dist/server.js";
import { StubAgentProvider } from "@insitue/agent-core/stub-provider";
import { PROTOCOL_VERSION, CAPTURE_SCHEMA_VERSION } from "@insitue/capture-core";

const PORT = 5798; // unique vs other m*.test.mjs
const ORIGIN = "http://localhost:3000";

/** Build a scratch git repo with a single source file. The
 *  checkpoint path uses git when available (verified in m3-p2) so
 *  exercising the git branch matches what real users hit. */
function buildScratchRepo() {
  const root = mkdtempSync(join(tmpdir(), "insitu-m6-"));
  mkdirSync(join(root, "src"), { recursive: true });
  const APP_TSX = "export const Badge = () => (\n  <span style={{ padding: \"2px 8px\" }}>A</span>\n);\n";
  writeFileSync(join(root, "src/App.tsx"), APP_TSX);
  // Quiet git init so test output stays clean.
  execSync(
    'git init -q && git config user.email test@local && git config user.name Test && git add -A && git commit -q -m init',
    { cwd: root, stdio: "inherit" },
  );
  return { root, appTsx: APP_TSX };
}

async function fetchToken(port) {
  const res = await fetch(`http://127.0.0.1:${port}/insitu/handshake`, {
    headers: { origin: ORIGIN },
  });
  return (await res.json()).token;
}

/** Open an authed WS and return a helper that records messages and
 *  resolves promises when a predicate matches. */
async function openAuthed(port, token) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`, { origin: ORIGIN });
  const messages = [];
  const waiters = [];
  ws.on("message", (d) => {
    const m = JSON.parse(String(d));
    messages.push(m);
    for (const w of waiters.slice()) {
      if (w.pred(m)) {
        waiters.splice(waiters.indexOf(w), 1);
        w.resolve(m);
      }
    }
  });
  await new Promise((r) => ws.once("open", r));
  ws.send(
    JSON.stringify({ t: "hello", protocolVersion: PROTOCOL_VERSION, token }),
  );
  await new Promise((resolve, reject) => {
    waiters.push({ pred: (m) => m.t === "hello-ok", resolve });
    setTimeout(() => reject(new Error("hello-ok timeout")), 3000);
  });
  return {
    ws,
    messages,
    send: (obj) => ws.send(JSON.stringify(obj)),
    waitFor: (pred, ms = 5000) =>
      new Promise((resolve, reject) => {
        const existing = messages.find(pred);
        if (existing) return resolve(existing);
        waiters.push({ pred, resolve });
        setTimeout(() => reject(new Error(`waitFor timeout`)), ms);
      }),
    close: () => ws.close(),
  };
}

test("full agentic loop: capture → turn → approve → applied → undo → reverted", async (t) => {
  const { root, appTsx } = buildScratchRepo();
  const NEW = "export const Badge = () => (\n  <span style={{ padding: \"8px 20px\" }}>A</span>\n);\n";

  const provider = new StubAgentProvider({
    turns: [
      {
        text: "Bumping padding to 8px 20px.",
        edits: [{ file: "src/App.tsx", contents: NEW, why: "stub" }],
      },
    ],
    // Force the "ready" state so the panel reaches Send-enabled
    // without a real claude CLI. Mirrors what users see after login.
    preflight: { ready: true, warnings: [], blockers: [] },
  });

  const server = startCompanion({
    port: PORT,
    origins: [ORIGIN],
    root,
    provider,
  });
  await new Promise((r) => server.once("listening", r));
  t.after(() => new Promise((r) => server.close(r)));

  const token = await fetchToken(PORT);
  const c = await openAuthed(PORT, token);
  t.after(() => c.close());

  // Sanity — orchestrator announced ready via stub preflight.
  const status = await c.waitFor((m) => m.t === "agent-status");
  assert.equal(status.ready, true, "stub preflight should report ready");

  // 1. capture — bundle's target.source.file must resolve under root.
  const bundleId = "b1";
  c.send({
    t: "capture",
    bundle: {
      schemaVersion: CAPTURE_SCHEMA_VERSION,
      id: bundleId,
      createdAt: new Date().toISOString(),
      target: {
        confidence: "exact",
        source: { file: "src/App.tsx", line: 2, column: 9 },
        componentStack: [{ name: "Badge" }],
        selector: "span",
      },
      domSubtree: { tag: "span", attrs: {}, children: [] },
      computedStyles: {},
      tailwindClasses: [],
      viewport: { w: 1280, h: 720, dpr: 1, breakpoint: "lg" },
      runtime: {
        url: "http://localhost:3000/",
        route: "/",
        console: [],
        network: [],
        errors: [],
      },
    },
  });
  const resolved = await c.waitFor((m) => m.t === "capture-resolved");
  assert.equal(resolved.id, bundleId);
  assert.ok(resolved.resolved, "source should resolve under git root");

  // 2. agent-turn — stub will propose a changeset.
  const turnId = "t1";
  c.send({
    t: "agent-turn",
    turnId,
    bundleId,
    userMessage: "make the padding bigger",
  });
  const proposed = await c.waitFor(
    (m) => m.t === "changeset-proposed" && m.turnId === turnId,
  );
  assert.equal(proposed.files.length, 1, "exactly one file proposed");
  assert.equal(proposed.files[0].file, "src/App.tsx");
  assert.match(proposed.files[0].diff, /-.*2px 8px/, "diff shows old padding removed");
  assert.match(proposed.files[0].diff, /\+.*8px 20px/, "diff shows new padding added");
  // File MUST NOT have changed yet — approval gate is load-bearing.
  assert.equal(
    readFileSync(join(root, "src/App.tsx"), "utf8"),
    appTsx,
    "approval gate: file unchanged before decision",
  );

  // 3. approve — companion writes, returns checkpointRef.
  c.send({ t: "agent-decision", turnId, decision: "approve" });
  const applied = await c.waitFor(
    (m) => m.t === "changeset-applied" && m.turnId === turnId,
  );
  assert.deepEqual(applied.files, ["src/App.tsx"]);
  assert.ok(applied.checkpointRef, "checkpoint ref present for undo");
  assert.equal(
    readFileSync(join(root, "src/App.tsx"), "utf8"),
    NEW,
    "file on disk now has agent's new contents",
  );

  // 4. undo — file reverts to baseline.
  c.send({ t: "agent-undo", turnId });
  const undone = await c.waitFor(
    (m) => m.t === "agent-undone" && m.turnId === turnId,
  );
  assert.deepEqual(undone.restored, ["src/App.tsx"]);
  assert.equal(
    readFileSync(join(root, "src/App.tsx"), "utf8"),
    appTsx,
    "file restored to baseline after undo",
  );
});

test("reject path: changeset-proposed but decision=reject leaves file untouched", async (t) => {
  const { root, appTsx } = buildScratchRepo();
  const NEW = "export const Badge = () => (\n  <span style={{ padding: \"8px 20px\" }}>A</span>\n);\n";

  const provider = new StubAgentProvider({
    turns: [
      { edits: [{ file: "src/App.tsx", contents: NEW }] },
    ],
    preflight: { ready: true, warnings: [], blockers: [] },
  });

  const server = startCompanion({
    port: PORT + 1,
    origins: [ORIGIN],
    root,
    provider,
  });
  await new Promise((r) => server.once("listening", r));
  t.after(() => new Promise((r) => server.close(r)));

  const token = await fetchToken(PORT + 1);
  const c = await openAuthed(PORT + 1, token);
  t.after(() => c.close());
  await c.waitFor((m) => m.t === "agent-status");

  const bundleId = "b1";
  c.send({
    t: "capture",
    bundle: {
      schemaVersion: CAPTURE_SCHEMA_VERSION,
      id: bundleId,
      createdAt: new Date().toISOString(),
      target: {
        confidence: "exact",
        source: { file: "src/App.tsx", line: 2, column: 9 },
        componentStack: [],
        selector: "span",
      },
      domSubtree: { tag: "span", attrs: {}, children: [] },
      computedStyles: {},
      tailwindClasses: [],
      viewport: { w: 1280, h: 720, dpr: 1, breakpoint: "lg" },
      runtime: { url: "http://localhost:3000/", route: "/", console: [], network: [], errors: [] },
    },
  });
  await c.waitFor((m) => m.t === "capture-resolved");

  const turnId = "t1";
  c.send({ t: "agent-turn", turnId, bundleId, userMessage: "x" });
  await c.waitFor((m) => m.t === "changeset-proposed" && m.turnId === turnId);
  c.send({ t: "agent-decision", turnId, decision: "reject" });

  // Companion only emits an agent-stream note for reject — give the
  // event loop a tick to flush, then assert.
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(
    readFileSync(join(root, "src/App.tsx"), "utf8"),
    appTsx,
    "reject leaves file untouched",
  );
});
