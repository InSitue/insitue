/**
 * M2-P4: FileMutator writes atomically + sandboxed; GitCheckpointer
 * captures pre-write state and restore() round-trips it. Pure FS, no
 * Claude, no git required (fs-fallback path) — CI-safe.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  existsSync,
} from "node:fs";
import { join } from "node:path";
import { applyEdits } from "../dist/edit/mutator.js";
import { checkpoint, restore } from "../dist/edit/git.js";

test("applyEdits: writes & creates files, refuses escapes", () => {
  const root = mkdtempSync(join(tmpdir(), "insitu-p4-"));
  writeFileSync(join(root, "a.txt"), "old\n");

  const res = applyEdits(root, [
    { file: "a.txt", contents: "new\n" },
    { file: "nested/b.txt", contents: "created\n" },
    { file: "../escape.txt", contents: "evil" },
  ]);

  assert.deepEqual(res.written.sort(), ["a.txt", "nested/b.txt"]);
  assert.equal(res.failed.length, 1);
  assert.match(res.failed[0].reason, /outside project root/);
  assert.equal(readFileSync(join(root, "a.txt"), "utf8"), "new\n");
  assert.equal(readFileSync(join(root, "nested/b.txt"), "utf8"), "created\n");
  assert.ok(!existsSync(join(root, "..", "escape.txt")));
});

test("checkpoint + restore: round-trips edits and deletes new files", async () => {
  const root = mkdtempSync(join(tmpdir(), "insitu-p4ck-")); // not a git repo → fs fallback
  writeFileSync(join(root, "keep.tsx"), "ORIGINAL\n");

  const cp = await checkpoint(root, ["keep.tsx", "brand-new.tsx"]);
  assert.equal(cp.kind, "fs");

  applyEdits(root, [
    { file: "keep.tsx", contents: "MUTATED\n" },
    { file: "brand-new.tsx", contents: "ADDED\n" },
  ]);
  assert.equal(readFileSync(join(root, "keep.tsx"), "utf8"), "MUTATED\n");
  assert.ok(existsSync(join(root, "brand-new.tsx")));

  const restored = await restore(root, cp);
  assert.deepEqual(restored.sort(), ["brand-new.tsx", "keep.tsx"]);
  assert.equal(readFileSync(join(root, "keep.tsx"), "utf8"), "ORIGINAL\n");
  assert.ok(
    !existsSync(join(root, "brand-new.tsx")),
    "a file absent at checkpoint is deleted on restore",
  );
});
