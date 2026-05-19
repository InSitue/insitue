/**
 * Resolve a submitted CaptureBundle's source target to a real span in
 * the project — sandboxed to `root` (realpath, no escape). The browser
 * never reads files; only this does.
 */
import { readFileSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type {
  CaptureBundle,
  ResolvedSource,
} from "@insitu/capture-core";

const SNIPPET_RADIUS = 6;

export function resolveCapture(
  root: string,
  bundle: CaptureBundle,
): { resolved: ResolvedSource | null; note: string } {
  const target = bundle.target;
  if (!target) {
    return { resolved: null, note: "no target — empty selection" };
  }
  const src = target.source;
  if (!src) {
    return {
      resolved: null,
      note: `selector-only (${target.confidence}): ${target.selector}`,
    };
  }

  let rootReal: string;
  try {
    rootReal = realpathSync(resolve(root));
  } catch {
    return { resolved: null, note: "project root unreadable" };
  }

  // React `_debugSource.fileName` is absolute in dev; the babel-attr
  // fallback is repo-relative. Normalize either to an absolute path,
  // then enforce the sandbox.
  const absInput = isAbsolute(src.file)
    ? src.file
    : join(rootReal, src.file);

  let abs: string;
  try {
    abs = realpathSync(absInput);
  } catch {
    return {
      resolved: null,
      note: `source file not found: ${src.file}`,
    };
  }
  if (abs !== rootReal && !abs.startsWith(rootReal + sep)) {
    return {
      resolved: null,
      note: "source path escapes project root — refused",
    };
  }

  let text: string;
  try {
    text = readFileSync(abs, "utf8");
  } catch {
    return { resolved: null, note: `cannot read ${src.file}` };
  }

  const lines = text.split("\n");
  const idx = Math.max(0, Math.min(lines.length - 1, src.line - 1));
  const from = Math.max(0, idx - SNIPPET_RADIUS);
  const to = Math.min(lines.length, idx + SNIPPET_RADIUS + 1);
  const snippet = lines
    .slice(from, to)
    .map((l, i) => {
      const ln = from + i + 1;
      return `${ln === src.line ? "›" : " "} ${String(ln).padStart(4)}  ${l}`;
    })
    .join("\n");

  const relPath = relative(rootReal, abs).split(sep).join("/");
  const compFile = target.componentStack.find((c) => c.source)?.source?.file;
  const resolved: ResolvedSource = {
    file: relPath,
    line: src.line,
    column: src.column,
    snippet,
    ...(compFile && compFile !== src.file
      ? { componentFile: compFile }
      : {}),
  };
  return {
    resolved,
    note: `resolved ${relPath}:${src.line} (${target.confidence})`,
  };
}
