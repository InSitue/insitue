# InSitue Dev — Claude Code plugin

Drive a `claude` session from your running app. Pick an element
in the browser, describe what you want changed, hit Send.
`claude` reads the file at exactly the right line and proposes
the edit. No copy-pasting file paths. No fumbling for line
numbers. The picker IS the prompt.

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

### 1. Install the plugin

In any `claude` session:

```
/plugin marketplace add InSitue/insitue
/plugin install insitue@insitue-plugins
```

That's it for the plugin side. The MCP server it ships will
auto-start the InSitue companion process in the background of
your `claude` session — no separate terminal to babysit.

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
`.insitu/session.json` and reuses it instead of spawning its
own. Use this when you want to see the companion's logs
directly, or for debugging.

**It's still not working**
Open an issue at <https://github.com/InSitue/insitue/issues>
with the contents of `.insitu/session.json` and the last ~20
lines from the `claude` transcript. The MCP server logs
extensively to stderr; claude surfaces them in the transcript.

---

## Architecture (skip unless curious)

The plugin is a stdio MCP server that:

1. On startup, reads `${CLAUDE_PROJECT_DIR}/.insitu/session.json`
   to find a running companion. If one's alive, reuse it.
2. Otherwise spawns `npx -y @insitue/companion@latest dev` as a
   child process, polls for the new `session.json` to appear,
   then connects.
3. Subscribes to the companion's WS broadcast channel. Every
   pick the browser sends arrives here.
4. Exposes two MCP tools:
   - `insitue__next_pick` — long-polls until a pick lands
     (default 5 min). Returns target + source + screenshot +
     userNote.
   - `insitue__list_recent_picks` — buffered picks since the
     server started.
5. Auto-reconnects if the companion restarts (HMR, manual
   stop). The widget reconnects too.
6. Cleans up on `process.exit` / `SIGTERM` — kills only the
   companion it spawned, leaves user-started companions
   untouched.

The bridge **never writes files**. Claude does, via its native
Edit tool. This keeps the InSitue trust boundary clean: the
companion is the only thing that touches fs, and only after
the user has approved a proposal in the terminal.

---

## License

MIT. Same as the rest of InSitue.
