/**
 * Load the operating instructions from the canonical
 * `commands/connect.md` file shipped with the package. Both the
 * Claude Code slash command (`/insitue:connect`) AND the
 * `start_session` MCP tool (used on Claude Desktop, where there
 * are no slash commands) consume this same content — single
 * source of truth.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

let cached: string | null = null;

export function loadInstructions(): string {
  if (cached) return cached;
  const here = dirname(fileURLToPath(import.meta.url));
  // dist/mcp-server.js → ../commands/connect.md
  // src/instructions.ts (dev) → ../commands/connect.md
  const candidates = [
    join(here, "..", "commands", "connect.md"),
    join(here, "commands", "connect.md"),
  ];
  for (const p of candidates) {
    try {
      cached = readFileSync(p, "utf8");
      return cached;
    } catch {
      // try next
    }
  }
  // Fallback: a minimal inline instruction so the tool never returns
  // nothing. Should never trigger in a published package.
  cached =
    "Call `mcp__insitue__next_pick` in a loop. Each ok-status pick has " +
    "a `userNote` (the user's instruction) and a `source.file:line` " +
    "(where to act). Propose an edit, ask for approval in this chat, " +
    "then apply with `apply_edit` (or the runtime's native Edit tool).";
  return cached;
}
