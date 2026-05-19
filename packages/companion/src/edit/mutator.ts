/**
 * FileMutator — the ONLY thing in InSitu that writes source files, and
 * only after explicit approval. Every path is re-validated through the
 * same `safeResolve` sandbox the dry-run diff used (defence in depth:
 * approval references a turn, not a path). Writes are atomic
 * (temp file in the target dir + rename) so a crash mid-write can never
 * leave a half-written source file for the dev server to choke on.
 */
import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname, join } from "node:path";
import type { ProposedEdit } from "@insitu/capture-core";
import { safeResolve } from "./sandbox.js";

export interface ApplyResult {
  written: string[];
  failed: Array<{ file: string; reason: string }>;
}

export function applyEdits(
  root: string,
  edits: ProposedEdit[],
): ApplyResult {
  const written: string[] = [];
  const failed: ApplyResult["failed"] = [];

  for (const e of edits) {
    const abs = safeResolve(root, e.file);
    if (!abs) {
      failed.push({ file: e.file, reason: "outside project root / denied" });
      continue;
    }
    const tmp = join(
      dirname(abs),
      `.insitu-tmp-${randomBytes(6).toString("hex")}`,
    );
    try {
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(tmp, e.contents, "utf8");
      renameSync(tmp, abs); // atomic on the same filesystem
      written.push(e.file);
    } catch (err) {
      try {
        rmSync(tmp, { force: true });
      } catch {
        /* best effort */
      }
      failed.push({ file: e.file, reason: (err as Error).message });
    }
  }
  return { written, failed };
}
