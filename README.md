# InSitu

Load your own running dev app, click or define any region on the page, and
converse with an AI coding agent **in situ** — it sees the selected element +
runtime context and edits your **real local codebase** with live reload.

Localhost-first. MIT. See the design/plan in
`~/.claude/plans/curious-waddling-milner.md`.

## Packages

| Package | Role |
|---|---|
| `@insitu/capture-core` | **The seam.** Pure, serializable capture model + `CaptureSink` interface. No transport/agent/fs. Swapping the sink turns "local agentic edit" into a future "prod capture-only" with no rewrite. |
| `@insitu/companion` | `npx insitu` — loopback-only WS, Origin-pinned + token-gated, project-scoped. Owns all fs/git/agent (browser never does). |
| `@insitu/sdk` | Dev-only `<InSitu />` — a Preact **Shadow-DOM** overlay (style-isolated from host React/Tailwind) + the secure companion client. |

## Status — M3 (safety / polish) ✅

- **M0** trust boundary: `127.0.0.1`-only bind, `Origin` allowlist, per-session
  token, pinned protocol, prod-build refusal.
- **M1** select → DOM→source (React fiber + Babel fallback) → `CaptureBundle`
  with screenshot/styles/runtime + companion-resolved source span.
- **M2** the full loop: pick → **ask in situ** → grounded answer → propose →
  per-file **dry-run diff** → **Approve & write** (atomic, sandboxed) → ride
  host HMR → **Undo** (git-checkpoint, byte-exact restore). Three Claude Code
  transports (`cli-headless` default, `mcp`, `sdk`) behind one provider seam;
  Max-billing protected by env scrub.
- **M3** safety/polish: reject-with-reason + per-file approve subset;
  session model — **Undo all** + surgical **Commit (local)** (protocol v3);
  compile/runtime-error **feedback loop** (re-capture → agent fixes its own
  change); streaming elapsed/thinking + a **real** HMR-settle signal. 26
  automated tests (`pnpm test`).

Next: **M4** — prod capture-only seam validation (de-risk; not shipped).

## Runbooks

| Topic | Doc |
|---|---|
| Agent transports (`--agent-transport`, optional peers, billing) | [`docs/runbooks/insitu-agent-transports.md`](docs/runbooks/insitu-agent-transports.md) |

## Demo (one command)

```sh
pnpm install
pnpm demo          # builds, then runs the companion + React example together
```

Open <http://localhost:3100>, click **Select** in the InSitu pill, then
click any element — the panel shows its real `file:line`, component
stack, styles, screenshot and runtime. Ctrl+C stops both.

## Dev

```sh
pnpm build
pnpm test          # M0 security/handshake tests
pnpm dev           # watch-build all packages
```

## Dogfooding into an existing app (manual, dev-only)

InSitu is consumed by adding the dev-only component to a host app's root layout.
This is intentionally a **manual** step you control (e.g. in another repo) so it
never lands in that app's production build:

```tsx
// app/layout.tsx (or equivalent) — DEV ONLY
{process.env.NODE_ENV === "development" && <InSitu />}
```

Then run the app's dev server and, beside it, `npx insitu` from the app's repo
root. The overlay connects to the companion on `127.0.0.1:5747`.

> Not auto-wired into any existing repo by this project — keeping the host app's
> build/deploy untouched is a deliberate safety choice.
