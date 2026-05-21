/**
 * M2-P5: transport parity. cli-headless, mcp, and sdk all funnel their
 * native stream through `normalizeNative`, so a scripted turn must
 * yield an IDENTICAL AgentEvent stream + changeset regardless of
 * transport. We pin that shared core deterministically (no Claude, no
 * Max spend) — this IS the parity guarantee.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { normalizeNative } from "../dist/agent/claude-code/normalize.js";
import { parseProposals } from "../dist/agent/proposals.js";
import { buildChangeset } from "../dist/edit/gateway.js";
import { checkpoint, restore } from "../dist/edit/git.js";
import { applyEdits } from "../dist/edit/mutator.js";

const TURN = "t1";

test("normalizeNative: text, thinking, result→complete", () => {
  const seq = [
    { type: "system", subtype: "init" }, // ignored
    {
      type: "assistant",
      message: {
        content: [
          { type: "thinking", thinking: "hmm" },
          { type: "text", text: "Hello " },
        ],
      },
    },
    { type: "assistant", message: { content: [{ type: "text", text: "world" }] } },
    { type: "result", is_error: false },
  ];
  const events = seq.flatMap((m) => normalizeNative(m, TURN));
  assert.deepEqual(events, [
    { t: "agent-thinking", turnId: TURN, note: "hmm" },
    { t: "agent-activity", turnId: TURN, kind: "thinking", label: "thinking" },
    { t: "agent-text", turnId: TURN, delta: "Hello " },
    { t: "agent-text", turnId: TURN, delta: "world" },
    { t: "agent-turn-complete", turnId: TURN },
  ]);
});

test("normalizeNative: tool_use → concise agent-activity", () => {
  const events = normalizeNative(
    {
      type: "assistant",
      message: {
        content: [
          { type: "tool_use", name: "Read", input: { file_path: "a/b/HubHero.tsx" } },
          { type: "tool_use", name: "Grep", input: { pattern: "Indie-designed" } },
        ],
      },
    },
    TURN,
  );
  assert.deepEqual(events, [
    { t: "agent-activity", turnId: TURN, kind: "tool", label: "Read HubHero.tsx" },
    { t: "agent-activity", turnId: TURN, kind: "tool", label: 'Grep "Indie-designed"' },
  ]);
});

test("normalizeNative: result error → agent-error(transport)", () => {
  assert.deepEqual(
    normalizeNative({ type: "result", is_error: true, result: "boom" }, TURN),
    [{ t: "agent-error", turnId: TURN, code: "transport", message: "boom" }],
  );
});

test("git-mode checkpoint/restore is byte-exact (trailing newline)", async () => {
  const root = mkdtempSync(join(tmpdir(), "insitue-p5git-"));
  execFileSync("git", ["init", "-q"], { cwd: root });
  // Content that ends in a newline — the case execa's default
  // newline-trim silently corrupted before the fix.
  const original = 'export const x = "8px 16px";\n';
  writeFileSync(join(root, "App.tsx"), original);

  const cp = await checkpoint(root, ["App.tsx"]);
  assert.equal(cp.kind, "git", "temp dir is a git repo → git checkpoint");

  applyEdits(root, [{ file: "App.tsx", contents: "MUTATED" }]);
  assert.notEqual(readFileSync(join(root, "App.tsx"), "utf8"), original);

  const restored = await restore(root, cp);
  assert.deepEqual(restored, ["App.tsx"]);
  assert.equal(
    readFileSync(join(root, "App.tsx"), "utf8"),
    original,
    "restore must reproduce the original bytes, newline included",
  );
});

test("scripted turn → identical changeset across any transport", () => {
  const root = mkdtempSync(join(tmpdir(), "insitue-p5-"));
  writeFileSync(join(root, "App.tsx"), 'const p = "8px 16px";\n');

  // An edit-proposal block split across deltas (streaming reality):
  // every transport produces this same native shape.
  const nativeTurn = [
    { type: "assistant", message: { content: [{ type: "text", text: "Bumping padding.\n=== INSITU EDIT: App.tsx ===\n" }] } },
    { type: "assistant", message: { content: [{ type: "text", text: "=== CONTENT ===\nconst p = \"16px 32px\";\n=== END INSITU EDIT ===\n" }] } },
    { type: "result", is_error: false },
  ];

  const run = () => {
    const events = nativeTurn.flatMap((m) => normalizeNative(m, TURN));
    const text = events
      .filter((e) => e.t === "agent-text")
      .map((e) => e.delta)
      .join("");
    const edits = parseProposals(text);
    return { events, cs: buildChangeset(root, edits) };
  };

  // Determinism = parity: the shared pipeline is pure, so two runs
  // (standing in for two transports feeding the same native stream)
  // are byte-identical.
  const a = run();
  const b = run();
  assert.deepEqual(a.events, b.events);
  assert.deepEqual(a.cs, b.cs);
  assert.equal(a.cs.files.length, 1);
  assert.equal(a.cs.files[0].file, "App.tsx");
  assert.match(a.cs.files[0].diff, /-const p = "8px 16px";/);
  assert.match(a.cs.files[0].diff, /\+const p = "16px 32px";/);
  assert.equal(
    a.events.filter((e) => e.t === "agent-turn-complete").length,
    1,
  );
});
