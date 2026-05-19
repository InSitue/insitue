/**
 * EditGateway — buffers the agent's proposed edits into a changeset and
 * computes a per-file unified diff against what's actually on disk.
 *
 * P3 is dry-run: this READS files to diff, never writes. P4's
 * FileMutator will consume the same `ProposedEdit[]` (re-validated
 * through `safeResolve`) to apply atomically after approval.
 */
import { readFileSync } from "node:fs";
import { createPatch } from "diff";
import type { ProposedEdit } from "@insitu/capture-core";
import { safeResolve } from "./sandbox.js";

const MAX_FILES = 20;
const MAX_BYTES = 512 * 1024;

/** Which buffered edits an approve decision acts on.
 *  `files === undefined` → the WHOLE changeset (no per-file selection
 *  was made). `files === []` → an EXPLICIT empty selection (user
 *  unchecked everything) → apply nothing. A non-empty list → that
 *  subset. The undefined-vs-[] distinction is load-bearing: conflating
 *  them silently wrote files the user had deselected. */
export function pickEdits<T extends { file: string }>(
  accepted: T[],
  files: string[] | undefined,
): T[] {
  if (files === undefined) return accepted;
  const want = new Set(files);
  return accepted.filter((e) => want.has(e.file));
}

export interface ChangesetResult {
  files: Array<{ file: string; diff: string; bytes: number }>;
  skipped: Array<{ file: string; reason: string }>;
}

export function buildChangeset(
  root: string,
  edits: ProposedEdit[],
): ChangesetResult {
  const files: ChangesetResult["files"] = [];
  const skipped: ChangesetResult["skipped"] = [];

  for (const e of edits.slice(0, MAX_FILES)) {
    const abs = safeResolve(root, e.file);
    if (!abs) {
      skipped.push({ file: e.file, reason: "outside project root / denied" });
      continue;
    }
    const bytes = Buffer.byteLength(e.contents, "utf8");
    if (bytes > MAX_BYTES) {
      skipped.push({ file: e.file, reason: `too large (${bytes}B)` });
      continue;
    }
    let old = "";
    try {
      old = readFileSync(abs, "utf8");
    } catch {
      old = ""; // new file
    }
    if (old === e.contents) {
      skipped.push({ file: e.file, reason: "no change" });
      continue;
    }
    const diff = createPatch(
      e.file,
      old,
      e.contents,
      old ? "before" : "(new file)",
      "after",
    );
    files.push({ file: e.file, diff, bytes });
  }

  if (edits.length > MAX_FILES) {
    skipped.push({
      file: `+${edits.length - MAX_FILES} more`,
      reason: "changeset too large",
    });
  }
  return { files, skipped };
}
