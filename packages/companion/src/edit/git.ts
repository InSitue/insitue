/**
 * GitCheckpointer — captures the exact pre-write state of the files a
 * changeset will touch so a later "undo" restores them byte-for-byte.
 * It NEVER commits, stages, or pushes: the primary path writes loose
 * blobs to git's object store via `git hash-object -w` (a checkpoint
 * that survives even `git gc` for a while, invisible to status/log);
 * outside a git repo it falls back to copies under
 * `.insitu/checkpoints/<ref>/`. A file that didn't exist pre-write is
 * recorded as such → undo deletes it.
 */
import { execa } from "execa";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { safeResolve } from "./sandbox.js";

interface Entry {
  file: string;
  existed: boolean;
  /** git mode: blob sha. fs mode: backup path. Absent if !existed. */
  blob?: string;
  backup?: string;
}
export interface Checkpoint {
  ref: string;
  kind: "git" | "fs";
  entries: Entry[];
}

async function isGitRepo(root: string): Promise<boolean> {
  try {
    const r = await execa(
      "git",
      ["-C", root, "rev-parse", "--is-inside-work-tree"],
      { reject: false },
    );
    return r.exitCode === 0 && String(r.stdout).trim() === "true";
  } catch {
    return false;
  }
}

export async function checkpoint(
  root: string,
  files: string[],
): Promise<Checkpoint> {
  const ref = `ckpt_${Date.now().toString(36)}`;
  const git = await isGitRepo(root);
  const entries: Entry[] = [];

  if (git) {
    for (const file of files) {
      const abs = safeResolve(root, file);
      if (!abs || !existsSync(abs)) {
        entries.push({ file, existed: false });
        continue;
      }
      const r = await execa("git", ["-C", root, "hash-object", "-w", abs]);
      entries.push({ file, existed: true, blob: String(r.stdout).trim() });
    }
    return { ref, kind: "git", entries };
  }

  const dir = join(root, ".insitu", "checkpoints", ref);
  mkdirSync(dir, { recursive: true });
  for (const file of files) {
    const abs = safeResolve(root, file);
    if (!abs || !existsSync(abs)) {
      entries.push({ file, existed: false });
      continue;
    }
    const backup = join(dir, file.replace(/[/\\]/g, "__"));
    copyFileSync(abs, backup);
    entries.push({ file, existed: true, backup });
  }
  return { ref, kind: "fs", entries };
}

/** P5 wires this to `agent-undo`; defined here so the checkpoint
 *  format and its inverse stay together and round-trip-testable now. */
export async function restore(
  root: string,
  cp: Checkpoint,
): Promise<string[]> {
  const restored: string[] = [];
  for (const e of cp.entries) {
    const abs = safeResolve(root, e.file);
    if (!abs) continue;
    if (!e.existed) {
      rmSync(abs, { force: true });
      restored.push(e.file);
      continue;
    }
    if (cp.kind === "git" && e.blob) {
      const r = await execa("git", ["-C", root, "cat-file", "-p", e.blob]);
      writeFileSync(abs, r.stdout as string);
      restored.push(e.file);
    } else if (cp.kind === "fs" && e.backup && existsSync(e.backup)) {
      copyFileSync(e.backup, abs);
      restored.push(e.file);
    }
  }
  return restored;
}
