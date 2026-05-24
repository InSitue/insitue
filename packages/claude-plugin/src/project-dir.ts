/**
 * Resolve which project the MCP server should target.
 *
 * Claude Code sets `CLAUDE_PROJECT_DIR` and runs us with `cwd:
 * ${CLAUDE_PROJECT_DIR}` (via plugin.json), so resolution is
 * trivial there. Claude Desktop has neither convention, so we try
 * the following in order of precedence:
 *
 *   1. `--project-dir <path>` argv flag (explicit, configured in
 *      `claude_desktop_config.json` args).
 *   2. `INSITUE_PROJECT_DIR` env var (same idea, more idiomatic).
 *   3. `CLAUDE_PROJECT_DIR` env var (Claude Code).
 *   4. Walk up from cwd for an existing `.insitue/session.json`
 *      — the strongest signal that we've been here before.
 *   5. Walk up from cwd for a `package.json` — generic project
 *      root marker, good enough for the first run.
 *   6. cwd itself (last resort).
 *
 * All paths are resolved to absolute, real paths. Symlink loops
 * are not our problem to solve here.
 */
import { existsSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";

export interface ResolvedProjectDir {
  /** Absolute real path of the resolved project directory. */
  dir: string;
  /** Which source won — useful for `diagnose` output. */
  source:
    | "argv"
    | "INSITUE_PROJECT_DIR"
    | "CLAUDE_PROJECT_DIR"
    | "session-walk-up"
    | "package-walk-up"
    | "cwd";
}

/** Strip the `--project-dir <path>` (or `--project-dir=<path>`) pair
 *  out of an argv array and return the value. Doesn't mutate the
 *  caller's array. */
function readProjectDirArg(argv: readonly string[]): string | null {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--project-dir" && i + 1 < argv.length) return argv[i + 1]!;
    if (a.startsWith("--project-dir=")) return a.slice("--project-dir=".length);
  }
  return null;
}

/** Walk up from `start` looking for `<dir>/<marker>`. Returns the
 *  containing directory or null. */
function walkUpFor(start: string, marker: string): string | null {
  let dir = resolve(start);
  while (true) {
    if (existsSync(join(dir, marker))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function realpathSafe(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
}

export function resolveProjectDir(
  argv: readonly string[] = process.argv.slice(2),
  env: NodeJS.ProcessEnv = process.env,
): ResolvedProjectDir {
  const fromArg = readProjectDirArg(argv);
  if (fromArg) {
    return { dir: realpathSafe(fromArg), source: "argv" };
  }
  if (env.INSITUE_PROJECT_DIR) {
    return {
      dir: realpathSafe(env.INSITUE_PROJECT_DIR),
      source: "INSITUE_PROJECT_DIR",
    };
  }
  if (env.CLAUDE_PROJECT_DIR) {
    return {
      dir: realpathSafe(env.CLAUDE_PROJECT_DIR),
      source: "CLAUDE_PROJECT_DIR",
    };
  }
  const cwd = process.cwd();
  const sessionDir = walkUpFor(cwd, ".insitue");
  if (sessionDir && existsSync(join(sessionDir, ".insitue", "session.json"))) {
    return { dir: realpathSafe(sessionDir), source: "session-walk-up" };
  }
  const pkgDir = walkUpFor(cwd, "package.json");
  if (pkgDir) {
    return { dir: realpathSafe(pkgDir), source: "package-walk-up" };
  }
  return { dir: realpathSafe(cwd), source: "cwd" };
}

/** True iff `target` is inside (or equal to) `root`. Both must be
 *  absolute. Uses realpath-style comparison to defeat `..` games.
 *  Cross-platform: uses `path.sep` so the boundary check holds on
 *  Windows (where separators are `\`) as well as POSIX. */
export function isInsideProject(root: string, target: string): boolean {
  const r = realpathSafe(root);
  let t: string;
  try {
    t = realpathSync(target);
  } catch {
    // If the file doesn't exist yet (write_file path), realpath fails.
    // Fall back to resolving the directory above and checking that.
    t = resolve(target);
  }
  if (!isAbsolute(r) || !isAbsolute(t)) return false;
  const rWithSep = r.endsWith(sep) ? r : r + sep;
  return t === r || t.startsWith(rWithSep);
}
