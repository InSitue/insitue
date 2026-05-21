/**
 * M3-P2: commit-session is a SURGICAL pathspec commit — it records
 * only the session's files and leaves unrelated working/staged changes
 * untouched, and never pushes. Pure git, no Claude.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { mkdtempSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { commitFiles } from "../dist/edit/git.js";

const git = (root, ...args) =>
  execFileSync("git", ["-C", root, ...args], { encoding: "utf8" });

test("commitFiles commits only the given paths; others untouched", async () => {
  const root = mkdtempSync(join(tmpdir(), "insitue-p2-"));
  git(root, "init", "-q");
  git(root, "config", "user.email", "t@t.t");
  git(root, "config", "user.name", "T");
  writeFileSync(join(root, "seed.txt"), "seed\n");
  git(root, "add", "-A");
  git(root, "commit", "-qm", "seed");

  // Session applied app.tsx; unrelated.txt is a concurrent edit.
  writeFileSync(join(root, "app.tsx"), "SESSION CHANGE\n");
  writeFileSync(join(root, "unrelated.txt"), "do not commit me\n");

  const { commit, files } = await commitFiles(
    root,
    ["app.tsx"],
    "InSitue: bump padding",
  );

  assert.match(commit, /^[0-9a-f]{7,}$/);
  assert.deepEqual(files, ["app.tsx"]);

  const show = git(root, "show", "--name-only", "--format=%s", "HEAD").trim();
  assert.match(show, /InSitue: bump padding/);
  assert.match(show, /app\.tsx/);
  assert.ok(!/unrelated\.txt/.test(show), "unrelated file must not be in the commit");

  // unrelated.txt is still an uncommitted, untracked working change.
  const status = git(root, "status", "--porcelain").trim();
  assert.match(status, /\?\? unrelated\.txt/);
});

test("commitFiles refuses outside a git repo", async () => {
  const root = mkdtempSync(join(tmpdir(), "insitue-p2ng-"));
  writeFileSync(join(root, "x.txt"), "x");
  await assert.rejects(
    () => commitFiles(root, ["x.txt"], "m"),
    /not a git repository/,
  );
});
