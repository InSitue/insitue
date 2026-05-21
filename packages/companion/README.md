# `@insitue/companion`

The local InSitue companion — the loopback WebSocket bridge
between a browser running `@insitue/sdk` and a `claude` session
running `/insitue:connect` (from `@insitue/claude-plugin`).

Most users **don't run this directly**. The
[`@insitue/claude-plugin`](https://www.npmjs.com/package/@insitue/claude-plugin)
MCP server auto-spawns the companion when claude starts, and
cleans it up when claude exits. You only reach for this package
manually if you want to:

- See the companion's logs directly
- Pipe picks to a non-claude tool (Aider, Cursor, your own
  script) via `insitue connect`
- Run a long-lived companion that survives across multiple
  claude sessions

---

## Run it directly

```bash
# Auto-installs from npm if you don't have it locally
npx @insitue/companion@latest dev
```

The companion:

- Binds to `127.0.0.1:5747` (loopback ONLY).
- Writes `.insitu/session.json` containing a per-session token.
- Accepts any `http://localhost:*` or `http://127.0.0.1:*`
  Origin by default (`--allow-localhost` is on for `dev`).
- Allows additional Origins via `-o https://my-tunnel.cf`.

That's it. Your browser-side `<InSitueCapture />` finds the
session token via `.insitu/session.json`, opens a WS, and starts
streaming picks.

## Pipe to a tool

```bash
# In a separate terminal:
npx @insitue/companion@latest connect
```

`connect` opens a WS to the running companion and emits one
formatted block per pick to stdout. Pipe it into any tool:

```bash
# Pretty text (default)
insitue connect

# NDJSON for machine consumers
insitue connect --json | jq .
```

## CLI flags

| Flag | Default | What it does |
|---|---|---|
| `-p, --port <n>` | `5747` | Loopback port to bind |
| `-r, --root <path>` | `cwd` | Project root the companion scopes file resolution to |
| `-o, --origin <url...>` | (none) | Additional Origins to allow, ON TOP of the localhost wildcard |
| `--strict-origins` | off | Disable the localhost wildcard; require explicit `-o` allowlist |
| `-t, --agent-transport <t>` | `cli-headless` | `cli-headless`, `mcp`, or `sdk` for the legacy in-companion agent loop (unused with the claude-plugin flow) |
| `--allow-api-key` | off | Permit `ANTHROPIC_API_KEY` to reach a spawned headless claude (bills API, not Pro/Max) |

## Security boundary

The companion is **dev infrastructure** — it edits files, runs
git, and spawns processes. Its trust boundary is:

1. **Loopback bind only**. It refuses any non-127.0.0.1
   connection at the socket layer.
2. **Per-session token** written to `.insitu/session.json`.
   Every WS connection must present the token in its `hello`
   message. The file is gitignored.
3. **Origin pin** (defense in depth, not the primary auth).
   Allows the localhost wildcard by default for friction-free
   dev; pass `--strict-origins` with `-o` for hardened use.

The companion will **refuse to start** if `NODE_ENV=production`.
It is a localhost dev tool by design.

---

## Architecture

```
┌──────────────────┐                           ┌──────────────────┐
│  Browser         │  ws://127.0.0.1:5747      │  Companion       │
│  @insitue/sdk    │ ◄────────────────────────►│  this process    │
│  widget          │                           │                  │
└──────────────────┘                           │   - resolves     │
                                               │     pick → src   │
┌──────────────────┐  ws://127.0.0.1:5747/     │   - broadcasts   │
│  Subscribers     │      insitu/cli           │     to subs      │
│  (claude-plugin, │ ◄────────────────────────►│                  │
│   insitue        │                           │                  │
│   connect, …)    │                           └──────────────────┘
└──────────────────┘
```

Browser sends `{ t: "capture", bundle }`. Companion resolves
`bundle.target.source` against `.insitu/session.json`'s root
directory (read filesystem, get the real `file:line:col` plus
a snippet), broadcasts `{ t: "broadcast-capture", bundle,
resolved }` to all subscribers. Subscribers (e.g. the
claude-plugin MCP server) deliver to `claude`.

## License

MIT.
