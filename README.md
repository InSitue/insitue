# InSitue

Load your own running dev app, click or define any region on the page, and
converse with an AI coding agent **in situ** — it sees the selected element +
runtime context and edits your **real local codebase** with live reload.

Localhost-first. MIT. See the design/plan in
`~/.claude/plans/curious-waddling-milner.md`.

## Packages

| Package | Role |
|---|---|
| `@insitue/capture-core` | **The seam.** Pure, serializable capture model + `CaptureSink` interface. No transport/agent/fs. Swapping the sink turns "local agentic edit" into a future "prod capture-only" with no rewrite. |
| `@insitue/companion` | `npx insitu` — loopback-only WS, Origin-pinned + token-gated, project-scoped. Owns all fs/git/agent (browser never does). |
| `@insitue/sdk` | Dev-only `<InSitue />` — a Preact **Shadow-DOM** overlay (style-isolated from host React/Tailwind) + the secure companion client. |

## Status — M0–M4 complete ✅ (v1 plan delivered)

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
  change); streaming elapsed/thinking + a **real** HMR-settle signal.
- **M4** prod capture-only seam **validated** (not shipped): a real
  `NODE_ENV=production` build with **no companion** still produces the same
  `CaptureBundle` → `IssueTrackerSink` draft (selector + DOM + screenshot;
  source resolved client-side via the babel attribute). Proves the
  local→prod offering is a sink swap, not a rewrite. 29 automated tests
  (`pnpm test`).

**Cloud — InSitue Autopilot (`apps/cloud`) ✅ built (D0 + C0–C10).**
Bug report → verified draft PR. `@insitue/agent-core` (the engine,
extracted MIT) reused verbatim by a Next.js-on-Vercel app: GitHub-OAuth
auth + multi-tenant Postgres, public `/v1/capture` ingest
(origin/schema/dedupe/quota), GitHub-App + Vercel integrations,
confidence- and verify-gated autopilot run in a Vercel-Sandbox microVM,
Safe/Standard/YOLO delivery, hybrid Stripe billing, email + Sentry,
admin/kill-switch, marketing/legal. **Runs entirely on fakes with $0
spend**; real Claude (G1) and real Stripe (G2) are hard-gated behind
explicit opt-in. **49 cloud + 31 engine tests green**, CI in
`.github/workflows/ci.yml`. Go-live = slot creds per the launch
runbook. The local OSS loop is unchanged.

## Runbooks

| Topic | Doc |
|---|---|
| Agent transports (`--agent-transport`, optional peers, billing) | [`docs/runbooks/insitu-agent-transports.md`](docs/runbooks/insitu-agent-transports.md) |
| InSitue Cloud go-live (creds, G1/G2 gates, checklist) | [`docs/runbooks/insitue-cloud-launch.md`](docs/runbooks/insitue-cloud-launch.md) |

## Demo (one command)

```sh
pnpm install
pnpm demo          # builds, then runs the companion + React example together
```

Open <http://localhost:3100>, click **Select** in the InSitue pill, then
click any element — the panel shows its real `file:line`, component
stack, styles, screenshot and runtime. Ctrl+C stops both.

## Dev

```sh
pnpm build
pnpm test          # M0 security/handshake tests
pnpm dev           # watch-build all packages
```

## Dogfooding into an existing app (manual, dev-only)

InSitue is consumed by adding the dev-only component to a host app's root layout.
This is intentionally a **manual** step you control (e.g. in another repo) so it
never lands in that app's production build:

```tsx
// app/layout.tsx (or equivalent) — DEV ONLY
{process.env.NODE_ENV === "development" && <InSitue />}
```

Then run the app's dev server and, beside it, `npx insitu` from the app's repo
root. The overlay connects to the companion on `127.0.0.1:5747`.

> Not auto-wired into any existing repo by this project — keeping the host app's
> build/deploy untouched is a deliberate safety choice.
