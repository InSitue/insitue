# InSitue Dev — Claude plugin (Code + Desktop)

Drive a Claude session — **Code or Desktop** — from your running
app. Pick an element in the browser, describe what you want
changed, hit Send. claude reads the file at exactly the right
line and proposes the edit. No copy-pasting file paths. No
fumbling for line numbers. The picker IS the prompt.

```
   ┌────────────────────────────────┐         ┌────────────────────┐
   │  Your app (any dev server)     │         │  claude (terminal) │
   │  ┌──────────────────────────┐  │         │                    │
   │  │ InSitue widget           │  │         │  /insitue:connect  │
   │  │  · Pick                  │  │  pipe   │                    │
   │  │  · Describe              │  ├────────►│  receives pick     │
   │  │  · Send                  │  │         │  + description     │
   │  └──────────────────────────┘  │         │                    │
   └────────────────────────────────┘         │  → reads file      │
                                              │  → proposes diff   │
                                              │  → awaits approval │
                                              │  → writes          │
                                              └────────────────────┘
```

---

## Setup (60 seconds, one-time)

Pick your runtime:

- **Claude Code** (the CLI / terminal app) → §1A below.
- **Claude Desktop** (the macOS / Windows app) → §1B below.

If you use both, do both — same MCP, same widget, same picks.

### 1A. Claude Code — install via the marketplace

In any `claude` session:

```
/plugin marketplace add InSitue/insitue
/plugin install insitue@insitue-plugins
```

That's it for the plugin side. The MCP server it ships will
auto-start the InSitue companion process in the background of
your `claude` session — no separate terminal to babysit. The
slash command `/insitue:connect` enters the loop.

### 1B. Claude Desktop — one-command setup

Claude Desktop doesn't have a plugin marketplace, but it does
load MCP servers from `claude_desktop_config.json`. The package
ships an `insitue` CLI that writes the right entry for you:

```bash
# from your project directory
npx -y @insitue/claude-plugin setup --desktop
```

What it does (all idempotent + backed up):

1. Detects your OS and finds the Desktop config file
   (`~/Library/Application Support/Claude/claude_desktop_config.json`
   on macOS, `%APPDATA%\Claude\…` on Windows,
   `$XDG_CONFIG_HOME/Claude/…` on Linux).
2. Backs up the existing file with an `.insitue-backup-<timestamp>`
   suffix.
3. Adds (or updates) a `mcpServers["insitue-<projectname>"]`
   entry pointing at `npx -y @insitue/claude-plugin@latest`
   with `INSITUE_PROJECT_DIR` set to your project.

Restart Claude Desktop, open a new chat, and type:

> Use the InSitue MCP — call `start_session`.

claude fetches the operating instructions, attaches to the
companion, and enters the loop. The slash command on Code and
`start_session` on Desktop deliver the exact same content.

**Multi-project?** Run `setup --desktop --project=/path/to/other`
in each project root. Each gets its own MCP entry
(`insitue-<dirname>`), so switching between projects in Desktop
is just picking the right server-prefix in chat.

**Want to see what would change first?** Append `--dry-run`. The
CLI prints the JSON entry without touching the file.

**Diagnose a setup that's misbehaving:**

```bash
npx -y @insitue/claude-plugin diagnose
```

Reports project dir, session file freshness, companion
reachability, SDK + SWC-plugin versions + wiring, and concrete
recommendations.

### 2. Mount the widget in your app

Install the SDK:

```bash
npm install -D @insitue/sdk
# or pnpm add -D / yarn add -D
```

Add one line to your app's dev mount. Next.js / Vite / Remix
— any framework with a React tree works.

**Next.js (app/layout.tsx):**

```tsx
import { InSitueCapture } from "@insitue/sdk";

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html>
      <body>
        {children}
        {process.env.NODE_ENV !== "production" && <InSitueCapture />}
      </body>
    </html>
  );
}
```

**Vite (src/main.tsx):**

```tsx
import { InSitueCapture } from "@insitue/sdk";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
    {import.meta.env.DEV && <InSitueCapture />}
  </StrictMode>,
);
```

With no `projectKey`, the widget connects to the local
companion. (Pass `projectKey` and it ships to InSitue Cloud
instead — same widget, different sink. See
[`@insitue/sdk`](https://www.npmjs.com/package/@insitue/sdk).)

---

## Use it

Two terminals. That's it.

```bash
# Terminal A — your normal dev server, any port
pnpm dev       # or `npm run dev`, `next dev`, `vite`, whatever

# Terminal B — claude, in the project root
claude
> /insitue:connect
```

Then in your browser:

1. Look for the **InSitue Dev** pill in the bottom-right corner.
2. Click it. The picker activates — hover any element on the
   page to highlight it.
3. Click the element you want to change.
4. The panel pops up with the target, a screenshot, and a
   focused textbox.
5. Type your instruction: *"make the padding bigger"*, *"this
   should be red on hover"*, *"swap these two for me"* —
   anything.
6. Press **Enter** (or click *Send to claude*).

Back in your terminal, claude has the pick + your description
and starts working. It'll show you the diff and wait for "yes"
before writing. After it writes, your dev server's HMR picks up
the change and you see it live in the browser. Pick the next
thing.

---

## What gets shipped to claude

Every pick that claude receives includes:

| Field | What it is |
|---|---|
| `source.file` + `source.line` | Resolved JSX site (via React fiber `_debugSource` or the `@insitue/sdk/babel` plugin) |
| `target` | Component name (e.g. `HubHeroPoster`) or selector fallback |
| `componentStack` | Top-down owner chain |
| `userNote` | Your typed description |
| `screenshot` | A real bitmap of what you picked |
| `runtime` | URL, recent console/network/errors |

The widget **refuses to send a pick** whose source can't be
resolved (selector-only confidence). You get an inline
"couldn't resolve the source file — try a parent" prompt,
and claude never gets a useless tip.

---

## Troubleshooting

**The pill says "InSitue Dev · offline"**
The companion isn't up yet — check the `claude` terminal for
output from `[insitue-mcp]` or `[companion]`. First run can take
~10 seconds while `npx` downloads the package. After that, it's
instant.

**`/insitue:connect` says the plugin isn't installed**
Run `/plugin marketplace update insitue-plugins` then `/plugin
install insitue@insitue-plugins` again. Restart claude (`/exit`,
then `claude`) so the MCP server reloads with the new version.

**Picks land but claude doesn't act**
Verify with `mcp__insitue__list_recent_picks` inside the claude
session — that confirms the bridge is delivering. If they're
there but ignored, you may have closed the `/insitue:connect`
loop. Restart it.

**I want to run the companion myself**
You can — `npx @insitue/companion@latest dev` in any terminal.
The MCP server detects an existing companion at
`.insitue/session.json` and reuses it instead of spawning its
own. Use this when you want to see the companion's logs
directly, or for debugging.

**It's still not working**
Open an issue at <https://github.com/InSitue/insitue/issues>
with the contents of `.insitue/session.json` and the last ~20
lines from the `claude` transcript. The MCP server logs
extensively to stderr; claude surfaces them in the transcript.

---

## Architecture (skip unless curious)

The plugin is a stdio MCP server that:

1. On startup, resolves the project dir (`--project-dir` argv →
   `INSITUE_PROJECT_DIR` env → `CLAUDE_PROJECT_DIR` env →
   walk-up for `.insitue/session.json` → walk-up for
   `package.json` → cwd).
2. Reads `.insitue/session.json` to find a running companion.
   If one's alive (PID up + port responsive), reuse it.
3. Otherwise spawns `npx -y @insitue/companion@latest dev` as a
   child process, polls for the new `session.json` to appear
   (8 s ceiling), then connects.
4. Subscribes to the companion's WS broadcast channel. Every
   pick the browser sends arrives here, gets summarised, and
   buffers (cap: 32) for the polling loop to pull.
5. Auto-reconnects if the companion restarts (HMR, manual
   stop). The widget reconnects too.
6. Cleans up on `process.exit` / `SIGTERM` — kills only the
   companion it spawned, leaves user-started companions
   untouched.

### MCP tools exposed

| Tool | Purpose |
|---|---|
| `next_pick` | Long-poll for the next browser pick (default 25 s; max 30 min). |
| `list_recent_picks` | Up to N buffered picks since the MCP server started. |
| `start_session` | Returns the operating instructions + current state. Desktop entry point. |
| `end_session` | Cleanly disconnect: close WS, suppress reconnect, kill spawned companion, drop session file. |
| `diagnose` | Health check — companion reachability, SDK + SWC-plugin versions + wiring, recommendations. |
| `read_file` | Project-scoped file read. Desktop fallback (Code has native Read). |
| `apply_edit` | Project-scoped string-replacement edit. Desktop fallback (Code has native Edit). |
| `write_file` | Project-scoped full-file write. Desktop fallback. |

All file tools resolve paths against the project dir and refuse
anything that resolves outside it (realpath-checked, so `..` games
are blocked). On Claude Code the agent prefers its native tools;
the project-scoped ones exist primarily for Claude Desktop, which
has no built-in file tools.

### Trust boundary

The companion is the only process that holds the user's edit
authority — it spawns from the project dir, writes only inside it,
and is gated by the WS handshake's loopback bind + per-session
token. The MCP bridge here is a read-side subscriber that
broadcasts picks into the chat. Writes still require the human
in the terminal to say "yes" before the agent calls `apply_edit`
(or its native equivalent).

---

## Stability

The plugin's MCP tool surface is what consumers depend on. We
treat tool name/argument changes as breaking; descriptions and
internal behaviour can evolve in patch releases.

## Versioning

- **Major** — backwards-incompatible changes to the MCP tool
  surface (renames, removed tools, argument shape changes), or
  changes that require the user to re-run `setup`.
- **Minor** — additive tools, optional new arguments, new env
  vars, new CLI subcommands.
- **Patch** — bug fixes, docs, internal refactors, version-pin
  bumps for transitive deps.

The plugin pins the InSitue WS protocol version (`5` at the time
of writing) against the companion. A mismatch is rejected at the
handshake rather than silently degraded.

## Security

Report vulnerabilities privately — see [SECURITY.md](../../SECURITY.md)
in the repo root. Especially relevant for this package: anything
that lets the bridge accept frames over a non-loopback bind, that
lets `apply_edit` / `write_file` escape the resolved project dir,
or that leaks the session token outside the local machine.

## License

MIT. Same as the rest of InSitue.
