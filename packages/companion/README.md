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
- Writes `.insitue/session.json` containing a per-session token.
- Accepts any `http://localhost:*` or `http://127.0.0.1:*`
  Origin by default (`--allow-localhost` is on for `dev`).
- Allows additional Origins via `-o https://my-tunnel.cf`.

That's it. Your browser-side `<InSitueCapture />` finds the
session token via `.insitue/session.json`, opens a WS, and starts
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
2. **Per-session token** written to `.insitue/session.json`.
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
│  Subscribers     │      insitue/cli           │     to subs      │
│  (claude-plugin, │ ◄────────────────────────►│                  │
│   insitue        │                           │                  │
│   connect, …)    │                           └──────────────────┘
└──────────────────┘
```

Browser sends `{ t: "capture", bundle }`. Companion resolves
`bundle.target.source` against `.insitue/session.json`'s root
directory (read filesystem, get the real `file:line:col` plus
a snippet), broadcasts `{ t: "broadcast-capture", bundle,
resolved }` to all subscribers. Subscribers (e.g. the
claude-plugin MCP server) deliver to `claude`.

## Public API

The package is primarily a CLI but also exports a programmatic
surface for embedders / tests:

```ts
import { startCompanion, COMPANION_VERSION } from "@insitue/companion";

const server = startCompanion({
  port: 5747,
  root: process.cwd(),
  origins: [],
  allowLocalhost: true,
});
// server is a node:http Server — call .close() to stop.
```

Exports:
- `startCompanion(opts: CompanionOptions): Server` — bind a
  companion to a port. Throws if `NODE_ENV=production`.
- `COMPANION_VERSION: string` — build-time-inlined package version.
- `CompanionOptions` — the full options shape.
- `AgentTransport` — `"cli-headless" | "mcp" | "sdk"`.
- `AgentProvider` — re-exported from `@insitue/agent-core` for
  tests that want to inject a deterministic provider.

## Closed-source dependency disclosure

`@insitue/companion` depends on
[`@insitue/agent-core`](https://www.npmjs.com/package/@insitue/agent-core)
— a closed-source package that holds the agent edit loop
(claude-code transports, proposal building, edit gateway, git
checkpoint mechanics). The companion ships thin shims under
`src/agent/` and `src/edit/` that re-export from agent-core so
import paths and the regression test layout stay stable. The
trust boundary documented above (loopback, token, Origin pin,
NODE_ENV-prod refusal) is entirely in this MIT-licensed package
— what crosses into agent-core is already-authenticated frames
on the WS.

If full source-level audit matters for your use case, you can
audit everything inbound to `agent-core` here (`server.ts`),
treat the agent edit loop as a black box, and trust that the
file operations it triggers go through your normal git review.

## Stability

- `startCompanion()` signature, `CompanionOptions`, and the
  `insitue dev` / `insitue connect` CLI flags are the stable
  consumer surface.
- The WS wire format is pinned by `PROTOCOL_VERSION` in
  `@insitue/capture-core` and **rejects mismatches** at the
  handshake. Bumping it is a breaking change for the SDK,
  claude-plugin, and any subscriber.
- `agent-core` exports re-exported through the local shims
  (`src/agent/**`, `src/edit/**`) are NOT a stable surface —
  prefer `startCompanion()` if you're embedding.

## Versioning

- **Major** — breaking changes to `startCompanion()` /
  `CompanionOptions`, CLI flag removals/renames, or
  `PROTOCOL_VERSION` bump (forces consumer pins).
- **Minor** — new CLI flags, additive options, additive WS
  message types (server backward-compatible).
- **Patch** — bug fixes, doc updates, transitive dep bumps.

## Tests

```bash
pnpm test
```

Native Node `--test` suite covering the WS handshake, capture
resolution, proposal flow, terminal-pipe broadcast, and #162
external-ask routing. Trust-boundary regressions land here
first — if you're changing `server.ts`, run the suite and add
to it.

## Security

Report vulnerabilities privately — see [SECURITY.md](../../SECURITY.md)
in the repo root. Especially relevant for this package:

- Any path that lets a non-loopback connection complete the
  handshake.
- Any path that lets a foreign Origin send authenticated frames
  (the per-session token + Origin pin are the auth boundary).
- Any path that lets the edit gateway write outside `opts.root`.
- Token leakage from `.insitue/session.json` (the auto-emitted
  `.gitignore` is what stops it from committing — the file's
  permission scope is the user's session).

## License

MIT. See [LICENSE](./LICENSE).
