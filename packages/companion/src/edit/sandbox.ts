/**
 * The filesystem trust boundary for the edit loop. Every path the agent
 * proposes is resolved through here before InSitu reads (P3) or writes
 * (P4) it: realpath-pinned to the project root (no `..`/symlink escape)
 * plus a hard deny list. The browser never reaches this — only the
 * companion does, and only via this function.
 */
import { realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

/** Returns an absolute, sandbox-checked path, or `null` if the path
 *  escapes `root` or hits the deny list. A not-yet-existing file is
 *  allowed (returns its intended absolute path) so P4 can create files;
 *  an existing path is realpath'd to defeat symlink escape. */
export function safeResolve(root: string, relFile: string): string | null {
  if (!relFile || relFile.includes("\0")) return null;

  let rootReal: string;
  try {
    rootReal = realpathSync(resolve(root));
  } catch {
    return null;
  }

  const absInput = isAbsolute(relFile) ? relFile : join(rootReal, relFile);
  const norm = resolve(absInput);
  if (norm !== rootReal && !norm.startsWith(rootReal + sep)) return null;

  const segs = relative(rootReal, norm).split(sep);
  if (segs.some((s) => s === ".git" || s === "node_modules")) return null;
  const base = segs[segs.length - 1] ?? "";
  if (base.startsWith(".env")) return null;

  // Existing path: realpath it so a symlink can't point outside root.
  // Missing path (new file the agent wants to create): the lexical
  // check above already proved it's inside root.
  try {
    const real = realpathSync(norm);
    if (real !== rootReal && !real.startsWith(rootReal + sep)) return null;
    return real;
  } catch {
    return norm;
  }
}
