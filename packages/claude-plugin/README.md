# @insitue/claude-plugin

Drive a Claude Code session from the InSitue browser overlay. Pick an
element in your running app, claude reads the file and proposes the
edit — no copy/paste of file paths, no typing line numbers.

## What you get

- A namespaced slash command **`/insitue:connect`** that puts the
  current `claude` session into "watch InSitue" mode.
- An MCP server (`insitue`) with two tools:
  - `insitue__next_pick` — long-polls until the next pick lands.
  - `insitue__list_recent_picks` — replays recent picks (e.g. things
    you selected before claude attached).

The bridge connects to the same loopback companion the browser
overlay uses (reads `.insitu/session.json` from your project), so
there's no extra config — start `insitue dev`, start `claude`, run
`/insitue:connect`, click in the browser.

## Install

```bash
claude plugin install @insitue/claude-plugin
```

## Use

Three terminals:

```bash
# Terminal A — your dev server (the app you're editing)
pnpm dev    # or npm run dev, etc.

# Terminal B — the InSitue companion (writes .insitu/session.json)
npx insitue dev

# Terminal C — Claude Code
claude
> /insitue:connect
```

Now click **Select** in the InSitue overlay, pick an element, and
type your request in the panel's "User note" field. Claude in
Terminal C reads the file at the exact location, proposes the diff,
and waits for your "approve" before writing.

## Architecture

```
┌───────────────────┐         ┌───────────────────┐
│  Browser overlay  │ ──WS──▶ │ Local companion   │
│   (insitue/sdk)   │         │  (insitue dev)    │
└───────────────────┘         └─────────┬─────────┘
                                        │ WS broadcast-capture
                                        ▼
                              ┌───────────────────┐
                              │ @insitue/         │
                              │ claude-plugin     │ ◀── stdio MCP ──┐
                              │  (MCP bridge)     │                 │
                              └───────────────────┘                 │
                                                          ┌─────────┴───────┐
                                                          │ claude (CLI)    │
                                                          │ /insitue:connect│
                                                          └─────────────────┘
```

The bridge never writes files — it just hands picks to `claude`, and
`claude` proposes edits through its normal Edit/Write tools (which
still respect your `claude` permissions).

## License

MIT — same as the rest of InSitue.
