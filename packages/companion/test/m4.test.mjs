/**
 * M4: the prod capture-only seam. The SAME CaptureBundle becomes a
 * tracker-ready draft with NO companion/agent/fs — source included
 * when resolved client-side, gracefully degraded to the always-present
 * selector when not. Pure, no browser, no Max.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { toIssueDraft, IssueTrackerSink } from "@insitue/capture-core";

const base = {
  schemaVersion: 1,
  id: "b1",
  createdAt: "2026-05-19T00:00:00.000Z",
  domSubtree: { tag: "button", attrs: {}, children: [] },
  computedStyles: {},
  tailwindClasses: ["px-4", "py-2"],
  viewport: { w: 1280, h: 800, dpr: 2, breakpoint: "lg" },
  runtime: {
    url: "https://app.example.com/dash",
    route: "/dash",
    console: [],
    network: [],
    errors: [{ message: "boom", ts: 1 }],
  },
};

test("exact source → draft cites file:line, keeps full bundle", () => {
  const bundle = {
    ...base,
    target: {
      source: { file: "src/App.tsx", line: 50, column: 4 },
      confidence: "exact",
      componentStack: [{ name: "ActionButton" }, { name: "Card" }],
      selector: "main > button.cta",
    },
    screenshot: {
      mime: "image/png",
      dataUrl: "data:image/png;base64,AA",
      bounds: { x: 0, y: 0, width: 10, height: 10 },
    },
  };
  const d = toIssueDraft(bundle);
  assert.match(d.title, /ActionButton/);
  assert.match(d.body, /src\/App\.tsx:50/);
  assert.match(d.body, /ActionButton < Card/);
  assert.match(d.body, /Screenshot:\*\* attached/);
  assert.match(d.body, /1 err/);
  assert.equal(d.bundle, bundle, "full bundle attached for the agent-ready future");
});

test("no source → degrades to selector, never fabricates a path", () => {
  const bundle = {
    ...base,
    target: {
      confidence: "selector-only",
      componentStack: [],
      selector: "div.grid > span:nth-child(3)",
    },
  };
  const d = toIssueDraft(bundle);
  assert.match(d.body, /selector-only — no source resolver/);
  assert.match(d.body, /div\.grid > span:nth-child\(3\)/);
  assert.ok(!/\.tsx:/.test(d.body), "must not invent a file:line");
});

test("screenshot unavailable → honest reason, never 'attached'", () => {
  const bundle = {
    ...base,
    target: { confidence: "selector-only", componentStack: [], selector: "x" },
    screenshotUnavailable: "cross-origin <img> (cdn.supabase.co)",
  };
  const d = toIssueDraft(bundle);
  assert.match(
    d.body,
    /Screenshot:\*\* unavailable — cross-origin <img> \(cdn\.supabase\.co\)/,
  );
  assert.ok(!/Screenshot:\*\* attached/.test(d.body));
});

test("screenshot.source surfaces capture path in draft body", () => {
  const bundle = {
    ...base,
    target: { confidence: "selector-only", componentStack: [], selector: "x" },
    screenshot: {
      mime: "image/png",
      dataUrl: "data:image/png;base64,AA",
      bounds: { x: 0, y: 0, width: 10, height: 10 },
      source: "display-media",
    },
  };
  const d = toIssueDraft(bundle);
  assert.match(d.body, /Screenshot:\*\* attached \(display-media\)/);
});

test("screenshot.qualityNote surfaces graceful-degrade signal", () => {
  const bundle = {
    ...base,
    target: { confidence: "selector-only", componentStack: [], selector: "x" },
    screenshot: {
      mime: "image/png",
      dataUrl: "data:image/png;base64,AA",
      bounds: { x: 0, y: 0, width: 10, height: 10 },
      source: "rasterise",
      qualityNote: "2 non-CORS images couldn't be embedded",
    },
  };
  const d = toIssueDraft(bundle);
  assert.match(
    d.body,
    /Screenshot:\*\* attached \(rasterise\) — 2 non-CORS images couldn't be embedded/,
  );
});

test("IssueTrackerSink.submit delivers exactly one draft", async () => {
  const seen = [];
  const sink = new IssueTrackerSink((d) => seen.push(d));
  assert.equal(sink.kind, "issue-tracker");
  await sink.submit({
    ...base,
    target: { confidence: "selector-only", componentStack: [], selector: "x" },
  });
  assert.equal(seen.length, 1);
  assert.match(seen[0].title, /\[InSitue\]/);
});
