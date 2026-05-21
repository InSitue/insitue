/**
 * M2-P3: proposal parsing + dry-run changeset are pure and correct.
 * No server, no Claude — fast, CI-safe (spends no Max credit).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseProposals } from "../dist/agent/proposals.js";
import { buildChangeset } from "../dist/edit/gateway.js";

test("parseProposals: ignores answer-only text", () => {
  assert.deepEqual(parseProposals("It renders a button. No changes."), []);
});

test("parseProposals: extracts file, why, verbatim contents", () => {
  const text = [
    "Here's the change:",
    "=== INSITU EDIT: src/App.tsx ===",
    "=== WHY: bigger padding ===",
    "=== CONTENT ===",
    "const a = 1;",
    "  const b = `x`;", // backticks must survive (no fences)
    "=== END INSITU EDIT ===",
    "done.",
  ].join("\n");
  const [e, ...rest] = parseProposals(text);
  assert.equal(rest.length, 0);
  assert.equal(e.file, "src/App.tsx");
  assert.equal(e.why, "bigger padding");
  assert.equal(e.contents, "const a = 1;\n  const b = `x`;");
});

test("parseProposals: multiple blocks, WHY optional, truncation tolerated", () => {
  const text = [
    "=== INSITU EDIT: a.ts ===",
    "=== CONTENT ===",
    "A",
    "=== END INSITU EDIT ===",
    "=== INSITU EDIT: b.ts ===",
    "=== CONTENT ===",
    "B-truncated", // no END line (stream cut off)
  ].join("\n");
  const eds = parseProposals(text);
  assert.equal(eds.length, 2);
  assert.equal(eds[0].file, "a.ts");
  assert.equal(eds[0].why, undefined);
  assert.equal(eds[1].file, "b.ts");
  assert.equal(eds[1].contents, "B-truncated");
});

test("buildChangeset: diffs changed file, skips no-change & escapes", () => {
  const root = mkdtempSync(join(tmpdir(), "insitue-p3-"));
  writeFileSync(join(root, "x.txt"), "old\n");
  writeFileSync(join(root, "same.txt"), "keep\n");

  const cs = buildChangeset(root, [
    { file: "x.txt", contents: "new\n", why: "change" },
    { file: "same.txt", contents: "keep\n" },
    { file: "../escape.txt", contents: "evil" },
    { file: "fresh.txt", contents: "brand new\n" },
  ]);

  const byFile = Object.fromEntries(cs.files.map((f) => [f.file, f]));
  assert.ok(byFile["x.txt"], "changed file present");
  assert.match(byFile["x.txt"].diff, /-old/);
  assert.match(byFile["x.txt"].diff, /\+new/);
  assert.ok(byFile["fresh.txt"], "new file present");
  assert.match(byFile["fresh.txt"].diff, /new file/);
  assert.ok(!byFile["same.txt"], "unchanged file skipped");

  const reasons = Object.fromEntries(
    cs.skipped.map((s) => [s.file, s.reason]),
  );
  assert.match(reasons["same.txt"], /no change/);
  assert.match(reasons["../escape.txt"], /outside project root/);
});
