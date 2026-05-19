/**
 * `cli-headless` has no Edit/Write tool by design (allowedTools =
 * Read/Grep/Glob) — so the agent surfaces edit *intent* as a strict,
 * line-delimited block in its text output, and InSitu turns that into a
 * buffered changeset. ASCII sentinels (not markdown fences — file
 * contents contain backticks) the model can reproduce reliably:
 *
 *   === INSITU EDIT: <repo-relative path> ===
 *   === WHY: <one line> ===            (optional)
 *   === CONTENT ===
 *   <entire new file contents, verbatim>
 *   === END INSITU EDIT ===
 *
 * The `sdk` transport (P5) will instead feed normalized
 * `agent-tool-proposal` events into the same changeset path — this
 * parser is the cli-headless adapter only.
 */
import type { ProposedEdit } from "@insitu/capture-core";

export const EDIT_START = "=== INSITU EDIT:";
export const EDIT_WHY = "=== WHY:";
export const EDIT_CONTENT = "=== CONTENT ===";
export const EDIT_END = "=== END INSITU EDIT ===";

const stripTail = (s: string) => s.replace(/=*\s*$/, "").trim();

export function parseProposals(text: string): ProposedEdit[] {
  const lines = text.split("\n");
  const out: ProposedEdit[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? "";
    if (!line.startsWith(EDIT_START)) {
      i++;
      continue;
    }
    const file = stripTail(line.slice(EDIT_START.length));
    i++;
    let why: string | undefined;
    if ((lines[i] ?? "").startsWith(EDIT_WHY)) {
      why = stripTail((lines[i] as string).slice(EDIT_WHY.length));
      i++;
    }
    if ((lines[i] ?? "").trim() === EDIT_CONTENT) i++;
    const buf: string[] = [];
    while (i < lines.length && (lines[i] as string).trim() !== EDIT_END) {
      buf.push(lines[i] as string);
      i++;
    }
    i++; // consume END (or run off the end if truncated — tolerated)
    if (file) {
      out.push({ file, contents: buf.join("\n"), ...(why ? { why } : {}) });
    }
  }
  return out;
}
