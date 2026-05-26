/**
 * Health check the MCP exposes as a tool AND the setup CLI runs
 * after writing the Desktop config. One source of truth for
 * "is everything wired up correctly?"
 *
 * Workspace-aware (#32): when `projectDir` is a pnpm/yarn workspace
 * root, the SDK and SWC-plugin are typically installed in per-
 * workspace `node_modules/` (`apps/dashboard/node_modules/...`),
 * not the root. The pre-#32 implementation only checked the root and
 * reported false-positive "not installed" warnings against the
 * monorepo of every dogfooder. Detection now walks one level into
 * common workspace patterns (`apps/*`, `packages/*`) before giving up.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { join } from "node:path";
import type { ResolvedProjectDir } from "./project-dir.js";

export interface DiagnosticReport {
  projectDir: ResolvedProjectDir;
  /** Has the project been touched by `@insitue/companion` before
   *  (i.e. `.insitue/session.json` exists)? */
  hasSessionFile: boolean;
  /** Companion reachable at its port (live PID + responding to the
   *  handshake endpoint)? */
  companionReachable: boolean;
  /** When the companion is reachable, the port it's bound to. */
  companionPort: number | null;
  /** When the companion is reachable, its current subscriber count
   *  (i.e. how many CLI/MCP listeners are attached). */
  companionSubscribers: number | null;
  /** `@insitue/sdk` resolved version in the project's node_modules,
   *  if installed. */
  sdkVersion: string | null;
  /** `@insitue/swc-source-attr` resolved version, if installed. */
  swcPluginVersion: string | null;
  /** Whether the host project has the SWC plugin wired into
   *  next.config.* or similar. Best-effort string search. */
  swcPluginConfigured: boolean | null;
  /** Plain-text recommendations the caller should surface. */
  recommendations: string[];
}

function readPkgVersionAt(dir: string, pkgName: string): string | null {
  const pkgJson = join(dir, "node_modules", pkgName, "package.json");
  if (!existsSync(pkgJson)) return null;
  try {
    return (JSON.parse(readFileSync(pkgJson, "utf8")) as { version?: string })
      .version ?? null;
  } catch {
    return null;
  }
}

/** Immediate children of a workspace dir (e.g. `apps/`, `packages/`)
 *  that have their own `package.json`. Returns absolute paths.
 *  Bounded to one level — covers the common monorepo layout without
 *  walking arbitrarily deep. */
function listWorkspaceMembers(projectDir: string): string[] {
  const out: string[] = [];
  for (const parent of ["apps", "packages"]) {
    const parentDir = join(projectDir, parent);
    if (!existsSync(parentDir)) continue;
    let entries: string[];
    try {
      entries = readdirSync(parentDir);
    } catch {
      continue;
    }
    for (const name of entries) {
      const child = join(parentDir, name);
      try {
        if (
          statSync(child).isDirectory() &&
          existsSync(join(child, "package.json"))
        ) {
          out.push(child);
        }
      } catch {
        // ignore unreadable entries
      }
    }
  }
  return out;
}

/** Resolved version of `pkgName` from the first place it's installed
 *  across the project dir and its workspace members. Returns null
 *  when not found anywhere — matches the pre-#32 contract for the
 *  non-monorepo case. */
function readPkgVersion(projectDir: string, pkgName: string): string | null {
  const v = readPkgVersionAt(projectDir, pkgName);
  if (v) return v;
  for (const ws of listWorkspaceMembers(projectDir)) {
    const v2 = readPkgVersionAt(ws, pkgName);
    if (v2) return v2;
  }
  return null;
}

interface SessionFile {
  port: number;
  pid: number;
  token: string;
}

function readSession(projectDir: string): SessionFile | null {
  const file = join(projectDir, ".insitue", "session.json");
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, "utf8")) as SessionFile;
  } catch {
    return null;
  }
}

async function pokeCompanion(
  port: number,
): Promise<{ alive: boolean; subscribers: number | null }> {
  return new Promise((resolve) => {
    const req = httpRequest(
      {
        host: "127.0.0.1",
        port,
        path: "/insitue/handshake",
        method: "GET",
        timeout: 1500,
      },
      (res) => {
        // The handshake 403s without an Origin; any response means
        // the companion is alive. Subscriber count comes via WS in
        // real ops — not exposed on the handshake endpoint — so
        // we leave that null and let next_pick traffic populate
        // it elsewhere.
        res.resume();
        resolve({ alive: true, subscribers: null });
      },
    );
    req.on("error", () => resolve({ alive: false, subscribers: null }));
    req.on("timeout", () => {
      req.destroy();
      resolve({ alive: false, subscribers: null });
    });
    req.end();
  });
}

const FRAMEWORK_CONFIGS = [
  "next.config.mjs",
  "next.config.js",
  "next.config.ts",
  "vite.config.ts",
  "vite.config.js",
];

function detectSwcPluginConfiguredAt(dir: string): boolean | null {
  for (const f of FRAMEWORK_CONFIGS) {
    const p = join(dir, f);
    if (existsSync(p)) {
      try {
        const c = readFileSync(p, "utf8");
        return c.includes("@insitue/swc-source-attr");
      } catch {
        return null;
      }
    }
  }
  return null;
}

/** Workspace-aware variant. Returns true if ANY discovered config
 *  has the plugin wired; false if at least one config was found and
 *  none referenced the plugin; null if no config files exist at all
 *  (genuine "can't tell" — projectDir is bare or a non-framework
 *  package). */
function detectSwcPluginConfigured(projectDir: string): boolean | null {
  let foundAnyConfig = false;
  const direct = detectSwcPluginConfiguredAt(projectDir);
  if (direct === true) return true;
  if (direct === false) foundAnyConfig = true;
  for (const ws of listWorkspaceMembers(projectDir)) {
    const r = detectSwcPluginConfiguredAt(ws);
    if (r === true) return true;
    if (r === false) foundAnyConfig = true;
  }
  return foundAnyConfig ? false : null;
}

export async function diagnose(
  projectDir: ResolvedProjectDir,
): Promise<DiagnosticReport> {
  const session = readSession(projectDir.dir);
  const hasSessionFile = session !== null;
  let companionReachable = false;
  let companionPort: number | null = null;
  let companionSubscribers: number | null = null;
  if (session) {
    const r = await pokeCompanion(session.port);
    companionReachable = r.alive;
    if (r.alive) companionPort = session.port;
    companionSubscribers = r.subscribers;
  }
  const sdkVersion = readPkgVersion(projectDir.dir, "@insitue/sdk");
  const swcPluginVersion = readPkgVersion(
    projectDir.dir,
    "@insitue/swc-source-attr",
  );
  const swcPluginConfigured = detectSwcPluginConfigured(projectDir.dir);

  const recommendations: string[] = [];
  if (!sdkVersion) {
    recommendations.push(
      "`@insitue/sdk` not installed in the project — `pnpm add -D @insitue/sdk`",
    );
  }
  if (!swcPluginVersion) {
    recommendations.push(
      "`@insitue/swc-source-attr` not installed — exact source resolution will degrade. `pnpm add -D @insitue/swc-source-attr`",
    );
  }
  if (swcPluginVersion && swcPluginConfigured === false) {
    recommendations.push(
      "`@insitue/swc-source-attr` installed but not wired into next.config / vite.config — see the SDK README for the snippet",
    );
  }
  if (!hasSessionFile) {
    recommendations.push(
      "No `.insitue/session.json` yet — the companion hasn't run in this project. Start `pnpm dev` and the companion should auto-spawn when claude attaches.",
    );
  } else if (!companionReachable) {
    recommendations.push(
      "Stale `.insitue/session.json` (companion not reachable). Delete the `.insitue/` directory and re-attach.",
    );
  }

  return {
    projectDir,
    hasSessionFile,
    companionReachable,
    companionPort,
    companionSubscribers,
    sdkVersion,
    swcPluginVersion,
    swcPluginConfigured,
    recommendations,
  };
}
