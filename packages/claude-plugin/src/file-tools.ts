/**
 * Project-scoped file tools the MCP exposes for Claude Desktop
 * users (who lack a built-in Edit/Read). Claude Code already has
 * native Edit/Read tools that handle this better — but exposing
 * the tools unconditionally is fine: Code-side claude prefers its
 * own; Desktop-side claude has no alternative.
 *
 * Safety boundary: every path is normalised + checked to live
 * inside the resolved project dir. Trying to read `/etc/passwd`
 * or write outside the project returns a structured error
 * instead of silently escaping. This is belt-and-braces against
 * a hostile prompt; the loopback bind on the companion is the
 * actual auth boundary for inbound picks.
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { isInsideProject } from "./project-dir.js";

export interface FileToolResult {
  status: "ok" | "error";
  /** Human-readable message — for "ok" results, a brief summary. */
  message?: string;
  /** Returned content for `read_file`. */
  content?: string;
  /** Size in bytes (for read/write reporting). */
  bytes?: number;
}

/** Resolve `path` against the project root. Returns the absolute
 *  path on success, or an `error` result describing the rejection. */
function resolveWithin(
  projectDir: string,
  path: string,
): { ok: true; abs: string } | { ok: false; result: FileToolResult } {
  if (!path || typeof path !== "string") {
    return {
      ok: false,
      result: { status: "error", message: "missing or invalid `path`" },
    };
  }
  const abs = isAbsolute(path) ? path : join(projectDir, path);
  if (!isInsideProject(projectDir, abs)) {
    return {
      ok: false,
      result: {
        status: "error",
        message: `refused: \`${path}\` resolves outside the project dir (${projectDir})`,
      },
    };
  }
  return { ok: true, abs };
}

export function readFileInProject(
  projectDir: string,
  path: string,
  opts: { startLine?: number; endLine?: number } = {},
): FileToolResult {
  const resolved = resolveWithin(projectDir, path);
  if (!resolved.ok) return resolved.result;
  if (!existsSync(resolved.abs)) {
    return { status: "error", message: `file not found: ${path}` };
  }
  try {
    const full = readFileSync(resolved.abs, "utf8");
    if (opts.startLine == null && opts.endLine == null) {
      return {
        status: "ok",
        content: full,
        bytes: Buffer.byteLength(full, "utf8"),
        message: `read ${path}`,
      };
    }
    const lines = full.split("\n");
    const start = Math.max(1, opts.startLine ?? 1) - 1;
    const end = Math.min(lines.length, opts.endLine ?? lines.length);
    const slice = lines.slice(start, end).join("\n");
    return {
      status: "ok",
      content: slice,
      bytes: Buffer.byteLength(slice, "utf8"),
      message: `read ${path} L${start + 1}-${end}`,
    };
  } catch (err) {
    return {
      status: "error",
      message: `read failed: ${(err as Error).message}`,
    };
  }
}

export function applyEditInProject(
  projectDir: string,
  path: string,
  oldString: string,
  newString: string,
  opts: { replaceAll?: boolean } = {},
): FileToolResult {
  const resolved = resolveWithin(projectDir, path);
  if (!resolved.ok) return resolved.result;
  if (!existsSync(resolved.abs)) {
    return { status: "error", message: `file not found: ${path}` };
  }
  if (oldString === newString) {
    return {
      status: "error",
      message: "`oldString` and `newString` are identical — nothing to apply",
    };
  }
  try {
    const before = readFileSync(resolved.abs, "utf8");
    if (!before.includes(oldString)) {
      return {
        status: "error",
        message:
          "`oldString` not found in file — fetch the current content with read_file and retry with the exact match",
      };
    }
    if (!opts.replaceAll) {
      const first = before.indexOf(oldString);
      const next = before.indexOf(oldString, first + oldString.length);
      if (next !== -1) {
        return {
          status: "error",
          message:
            "`oldString` matches multiple times — pass `replaceAll: true` or include more context to make the match unique",
        };
      }
    }
    const after = opts.replaceAll
      ? before.split(oldString).join(newString)
      : before.replace(oldString, newString);
    writeFileSync(resolved.abs, after, "utf8");
    const diffBytes =
      Buffer.byteLength(after, "utf8") - Buffer.byteLength(before, "utf8");
    return {
      status: "ok",
      message: `applied edit to ${path} (${diffBytes >= 0 ? "+" : ""}${diffBytes} bytes)`,
      bytes: Buffer.byteLength(after, "utf8"),
    };
  } catch (err) {
    return {
      status: "error",
      message: `edit failed: ${(err as Error).message}`,
    };
  }
}

export function writeFileInProject(
  projectDir: string,
  path: string,
  content: string,
  opts: { createParents?: boolean } = {},
): FileToolResult {
  const resolved = resolveWithin(projectDir, path);
  if (!resolved.ok) return resolved.result;
  try {
    if (opts.createParents) {
      mkdirSync(dirname(resolved.abs), { recursive: true });
    }
    writeFileSync(resolved.abs, content, "utf8");
    return {
      status: "ok",
      message: `wrote ${path} (${Buffer.byteLength(content, "utf8")} bytes)`,
      bytes: Buffer.byteLength(content, "utf8"),
    };
  } catch (err) {
    return {
      status: "error",
      message: `write failed: ${(err as Error).message}`,
    };
  }
}
