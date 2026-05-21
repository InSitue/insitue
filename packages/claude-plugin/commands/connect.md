---
description: Watch the InSitue browser overlay and act on each pick. Reads picks from the running local InSitue companion, edits the file the user pointed at, asks for confirmation, loops.
---

# /insitue:connect

Connect this Claude Code session to the running InSitue companion and turn each browser pick into a real code change.

## How it works

1. The user runs `npx insitue dev` in their project (the companion).
2. The user clicks **Select** in the InSitue browser overlay, then picks an element.
3. Claude (you) calls `mcp__insitue__next_pick` — blocks until a pick lands.
4. The tool returns the resolved `file:line`, component name, the user's note (what they typed in the panel), and surrounding context.
5. You read the file at the returned path, propose the edit, show the diff, and ask the user **here in chat** to approve before writing.
6. After applying, you call `next_pick` again and the loop continues.

## Your behavior on /insitue:connect

- **First**, call `mcp__insitue__list_recent_picks` once to see if the user already picked things before attaching. If there are recent picks the user hasn't acted on, summarise them so they can choose which to address.
- **Then enter the loop**: call `mcp__insitue__next_pick`. It blocks for ~5 min by default. When it returns:
  - If `status: "ok"`:
    - **If `pick.userNote` is set**: the user typed an instruction in the browser panel before sending. Read the `pick.source.file` at `pick.source.line`, propose an edit, show the diff, wait for "approve"/"yes" before writing.
    - **If `pick.userNote` is null** (user clicked without typing): the user might still be about to type in the browser panel — they have an ASK textbox in the panel that streams here as a `broadcast-ask` event. **Call `next_pick` AGAIN with a 30-second timeout** to wait for the follow-up note. The MCP bridge re-delivers the same pick with `userNote` populated once the user sends it. If that second call returns `status: "timeout"` instead, ONLY THEN fall back to asking "What would you like to change at `<componentName>` (`<file>:<line>`)?" in the terminal.
  - Propose an edit. Show a small diff in chat. Wait for the user to say "go" / "approve" / "yes" before writing.
  - On approval, apply with Edit/Write. Confirm what changed.
  - Loop back to `next_pick`.
- **If a pick comes through with `target` starting with `[insitue]`**: the companion disconnected (HMR / restart). Tell the user, then call `next_pick` again — the bridge auto-reconnects.
- **Exit the loop** when the user says "stop", "done", "quit", or similar.

**Why the double-poll on note-less picks**: the user's hands are on the browser, not the terminal. Their natural workflow is pick → type intent in the panel's ASK textbox → click Send. That ASK arrives via MCP as a `broadcast-ask` joined to the previous pick. If you ask in the terminal while the user is typing in the browser, both messages land at once and the user is confused. Default to "user is about to type in the browser" — re-poll first, only ask in the terminal as a last resort.

## Guardrails

- Don't touch any file outside the pick's `pick.source.file` unless the user explicitly asks for cross-file changes.
- Don't auto-approve. Every write is gated by an explicit user "yes" in chat.
- If `pick.source` is `null` (selector-only pick), don't guess — tell the user the source wasn't resolved and ask which file to edit.
- If `pick.confidence` is `"approximate"` (owner-fiber fallback, not the exact JSX site), warn the user before editing.
