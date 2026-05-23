# InSitue

Pick an element in your running app, describe what you want
changed, hit Send — `claude` in your terminal reads the file at
exactly the right line and proposes the edit. Same widget powers
production bug reports: end-users point at a problem, the
InSitue Cloud autopilot opens a verified draft PR.

The picker IS the prompt.

```
┌───────────────────────────────┐         ┌────────────────────┐
│ Your running app              │         │  claude (terminal) │
│ ┌───────────────────────────┐ │         │                    │
│ │ <InSitueCapture />        │ │  pick   │  /insitue:connect  │
│ │  · Pick                   │ ├────────►│                    │
│ │  · Describe               │ │         │  → reads file      │
│ │  · Send                   │ │         │  → proposes diff   │
│ └───────────────────────────┘ │         │  → awaits approval │
└───────────────────────────────┘         │  → writes          │
                                          └────────────────────┘
```

## Get started in 60 seconds

```bash
# 1. Add the SDK to your app
npm install -D @insitue/sdk
```

```tsx
// 2. Mount it (Next.js example)
import { InSitueCapture } from "@insitue/sdk";

export default function RootLayout({ children }) {
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

```
# 3. Install the claude plugin (one-time, in any claude session)
/plugin marketplace add InSitue/insitue
/plugin install insitue@insitue-plugins
```

```bash
# 4. Use it — two terminals
pnpm dev                      # your normal dev server (any port)
claude → /insitue:connect     # in another terminal
```

Click in your browser. Done.

Detailed setup: **[`packages/claude-plugin/README.md`](packages/claude-plugin/README.md)**.

## What's in this repo

The **local-loop dev tool**, MIT-licensed:

| Package | What it does | npm |
|---|---|---|
| **`@insitue/sdk`** | Browser widget. `<InSitueCapture />` — same component, dev (companion sink) or prod (cloud sink) mode. | [`@insitue/sdk`](https://www.npmjs.com/package/@insitue/sdk) |
| **`@insitue/companion`** | Local loopback bridge. Token-auth, project-sandboxed. Usually auto-spawned by the claude plugin; can run standalone. | [`@insitue/companion`](https://www.npmjs.com/package/@insitue/companion) |
| **`@insitue/claude-plugin`** | Claude Code plugin shipping the `/insitue:connect` slash command + MCP bridge. Auto-spawns the companion. | [`@insitue/claude-plugin`](https://www.npmjs.com/package/@insitue/claude-plugin) |
| `@insitue/capture-core` | Pure types: `CaptureBundle`, protocol versions, sink interfaces. Shared by every package. | [`@insitue/capture-core`](https://www.npmjs.com/package/@insitue/capture-core) |

Two more packages ship from a closed-source private repo as dist-only npm releases, MIT-licensed:

- [`@insitue/agent-core`](https://www.npmjs.com/package/@insitue/agent-core) — provider-agnostic agent loop, used by the cloud autopilot.
- [`@insitue/swc-source-attr`](https://www.npmjs.com/package/@insitue/swc-source-attr) — SWC plugin tagging JSX with source-file attributes so picks resolve to `file:line`.

The InSitue Cloud SaaS (production capture pipeline, autopilot, GitHub App, billing) is a separate closed-source product. The widget here works against it via the `projectKey` prop — see below.

## Dev mode

```bash
pnpm install
pnpm build               # build the whole graph in dep order
pnpm test                # run companion + sdk test suites
```

The React example at `examples/react-app` is the simplest end-to-end exercise: a small React app with `<InSitue />` mounted, plus the companion running against it.

```bash
cd examples/react-app
pnpm dev &                                              # vite on :3100
node ../../packages/companion/dist/cli.js dev
# In another terminal: claude → /insitue:connect
```

## Production sink (InSitue Cloud)

The same `<InSitueCapture />` widget, with a `projectKey` prop, posts captures to InSitue Cloud:

```tsx
<InSitueCapture projectKey={process.env.NEXT_PUBLIC_INSITUE_KEY!} />
```

End-users get a friendly "Report a problem" pill in the corner of your app. Reports land in your InSitue inbox; the cloud autopilot opens a verified draft PR for each one. Cloud product details: <https://www.insitue.com>.

## Architecture

```
                       browser
                       ┌─────────────────────────────────┐
                       │  <InSitueCapture />             │
                       │  (capture widget — one UI)      │
                       └────────────┬──────────┬─────────┘
                                    │          │
                          devsink  HTTPS    cloud sink
                                  WS │          │
                                    ▼          ▼
                       ┌──────────────────┐ ┌───────────────────┐
                       │ @insitue/        │ │  InSitue Cloud    │
                       │ companion        │ │  /v1/capture      │
                       │ (loopback only)  │ │  (Vercel app)     │
                       └──┬───────────────┘ └─────┬─────────────┘
                          │                       │
                  broadcast│                       │ autopilot
                  on WS    ▼                       ▼ → GitHub PR
                       ┌──────────────────────┐
                       │ @insitue/            │
                       │ claude-plugin (MCP)  │
                       └──────┬───────────────┘
                              │ tool: next_pick
                              ▼
                       ┌──────────────────────┐
                       │ claude (terminal)    │
                       │ /insitue:connect     │
                       └──────────────────────┘
```

Browser side: identical widget, identical bundle, identical
screenshot pipeline. The submit step branches once — to the
cloud's HTTPS endpoint OR to the local companion's loopback WS.

## Security boundary

- **Companion**: loopback-only bind (refuses non-127.0.0.1 at
  the socket), per-session token written to
  `.insitue/session.json` (gitignored), Origin pin on every
  browser connection.
- **Cloud**: publishable `projectKey` is Origin-pinned and
  quota-gated server-side. Spend caps + per-project allow-lists.
- **Claude bridge**: the MCP server NEVER writes files. Claude
  writes via its native `Edit` tool, with the user's explicit
  approval each time.

## License

MIT. Every package.
