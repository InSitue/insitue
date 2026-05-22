---
description: Cleanly disconnect this Claude session from InSitue — mutes the browser launcher, frees the companion port.
---

# /insitue:disconnect

Tears down the InSitue session in this Claude Code window
without exiting claude. Use when you're done picking for now —
the launcher in the browser goes muted, the companion process
the MCP server spawned is killed, the stale session file is
removed.

## Your behaviour

1. Call `mcp__insitue__end_session` once.
2. Summarise what was torn down in a single line — e.g.
   *"Disconnected. Companion stopped, session cleared. Run
   `/insitue:connect` again whenever you want to start picking."*
   Don't narrate every field of the response; the user just
   needs to know it worked.
3. **Exit any active pick loop** — stop calling `next_pick`.
4. Stay in the chat. The user may have more for you here that
   isn't pick-related. Don't `/exit`; that's their call.

## Symmetric with /insitue:connect

`/insitue:connect` attaches the subscriber → browser launcher
goes purple. `/insitue:disconnect` detaches → browser launcher
goes muted. Both safe to call any number of times, in any
order; the MCP holds the lifecycle straight.

## Reconnecting after disconnect

Just run `/insitue:connect` again. The MCP re-spawns the
companion if needed (the kill in `end_session` left `npx` ready
to restart), re-attaches the WS, and you're back in the loop.
No claude restart required.
