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

## Status — M0 (walking skeleton + trust boundary) ✅

- Monorepo (pnpm + Turborepo), MIT, all-permissive deps.
- Secure handshake: `127.0.0.1`-only bind, `Origin` allowlist (anti DNS-rebind),
  per-session token, pinned protocol version, prod-build refusal.
- Overlay pill with live connection status + secure **ping** round-trip.
- 7 automated trust-boundary tests pass (`pnpm test`).

Next: **M1** — element/region picker + DOM→source resolution + `CaptureBundle`.

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
