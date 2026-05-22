---
description: Drive this Claude Code session from the InSitue browser overlay — pick + describe in the browser, claude acts in the terminal.
---

# /insitue:connect

Connects this session to the local InSitue companion. The user
picks an element in their app, types a description in the
InSitue panel, clicks Send — and you receive the pick (file,
line, component, screenshot) plus the description here, ready to
act on.

The companion auto-starts when this MCP server boots. You do
not need to ask the user to run any extra commands.

## Your behaviour

1. Call `mcp__insitue__list_recent_picks` once. If there are
   any picks the user made before you attached, summarise them
   ("you picked X but haven't sent a description yet — make sure
   to click Send in the InSitue panel"). Otherwise just say
   "Connected. Pick something in the browser when you're ready."
2. Enter the loop: call `mcp__insitue__next_pick`. It long-polls
   (~25s default — short on purpose so the chat stays responsive
   to other questions the user might type while you wait). When
   it returns with `status: "timeout"`, **call it again immediately
   without announcing it** — the timeout is just a heartbeat, not
   news. When it returns with `status: "ok"`:
   - **Always echo the prompt back first.** Before any action,
     diff, or follow-up question, lead with:

     > **You asked:** [verbatim `pick.userNote`]
     > (Source: `pick.source.file:pick.source.line` ·
     > `pick.confidence`)

     The CLI transcript only shows your output, not the prompt
     the user typed in the browser panel. Without the echo, the
     user has to mentally pair every response with what they
     asked — confusing during multi-pick sessions and impossible
     when reviewing the log later. Echo verbatim; don't
     paraphrase. If `userNote` is empty, ask what to change at
     the picked component instead (see below).
   - **`pick.userNote`** is the user's instruction. Treat it as
     the prompt.
   - **`pick.source.file:line`** is where to act. Read the file
     around that line for context (Read tool — give it 30-40
     lines of surrounding code).
   - **`pick.confidence`**: if `"approximate"`, warn the user
     before editing — the line might point at an owning
     component, not the exact JSX site. If `"selector-only"`,
     refuse: tell them the InSitue widget should refuse this
     case already, and ask them to re-pick a parent.
   - Propose the edit with a clear diff in this chat. Wait for
     the user to say "yes" / "approve" / "go" before writing.
     Don't auto-apply.
   - On approval, write with the Edit tool. Confirm what
     changed.
   - Loop back to `next_pick`.
3. If `next_pick` returns `status: "timeout"`, the user simply
   hasn't picked anything yet. Stay quiet and call `next_pick`
   again. **Do not narrate the loop** — no "still waiting…", no
   "polling again…". The user sees `[insitue] 📥 pick received`
   on stderr the moment their pick lands; that's the
   confirmation, not your narration. If the user types another
   question while you're between calls, answer it first (since
   the chat is responsive), then resume the loop with
   `next_pick`.
4. If a pick comes back with `target` starting with
   `[insitue]` (e.g. "companion disconnected"), tell the user
   what happened in one sentence and call `next_pick` again —
   the bridge auto-reconnects.
5. Exit the loop when the user says "stop", "done", "quit",
   "thanks", "exit", or anything else that clearly ends the
   session.

## Guardrails

- **One pick = one terminal-controlled edit.** Don't take
  initiative across files unless the user explicitly asks for
  cross-file changes.
- **Never auto-apply.** Every write is gated by explicit user
  approval in this terminal.
- **Trust the user's intent.** The `userNote` is their
  instruction. Don't reinterpret it as "the user wants to
  discuss" — they want a code change.
- **Cite where you read from.** When you propose an edit, name
  the file and the lines you read (Read returns line numbers
  via the cat -n format).
- **Defer extras.** If the change you'd make requires touching
  many files / refactoring broadly, propose the surgical edit
  first and ask "want me to do X too?" rather than bundling
  silently.

## Failure modes to handle gracefully

- **`source.file` doesn't exist**: tell the user the path the
  pick resolved to and ask if they're in the right project
  directory. The MCP server reads `.insitue/session.json` from
  the cwd `claude` was started in.
- **The edit doesn't HMR cleanly**: surface the build error in
  chat (run `cat` or relevant logs if you can find them); don't
  pretend the change "applied" if the dev server is broken.
- **Approval was unclear**: ask. Don't write on ambiguity.
