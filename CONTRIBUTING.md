# Contributing to InSitue

Thanks for the interest. This repo is the **open-source local-loop dev tool** half of InSitue — the browser overlay, the local companion process, the Claude Code plugin, and the shared schema. The hosted **InSitue Cloud** product (multi-user dashboard, ingest pipeline, GitHub App, billing) lives in a separate, private repo and is not included here.

That split is intentional, not coyness. The cloud is a paid commercial product; the local loop is MIT-licensed and free.

## Setup

Requires:

- **Node 20+** (the repo pins Node 24 in CI; 20 works for local dev)
- **pnpm 10+** (via `corepack enable`)

```sh
git clone https://github.com/InSitue/insitue.git
cd insitue
corepack enable
pnpm install
pnpm build
pnpm test
```

That sequence verifies the workspace builds and the trust-boundary tests pass. If any step fails, that's a bug — open an issue.

## Repo layout

| Path | What it is |
|---|---|
| `packages/sdk` | Browser-side overlay (Shadow DOM). Embeds in host apps via `<InSitu />`. |
| `packages/companion` | Local Node process. Loopback WS on `127.0.0.1`, project sandbox, edit gateway. |
| `packages/claude-plugin` | Claude Code plugin that exposes the InSitue MCP tools and the `/insitue:connect` workflow. |
| `packages/capture-core` | Pure shared types and schema. No transport, no agent, no filesystem. |
| `examples/` | Self-contained host apps you can run end-to-end without InSitue Cloud. |

The agent decision-making (prompts, claude-code integration runtime) and the SWC source-attribution plugin live in the closed-source half of the product. The packages here will install closed-source binary deps from npm at install time; that's normal.

## Filing an issue

Use one of the templates at `/issues/new/choose`:

- **Bug** — something is broken or behaves unexpectedly.
- **Feature** — a missing capability or behavior change.
- **Task** — a small change with a clear acceptance criterion.

The issue forms ask for an **area** (cloud / companion / sdk / agent-core / capture-core / swc-plugin / claude-plugin / docs / examples / ci / infra) — pick the closest one. Maintainers will adjust labels and milestones during triage.

We aim to respond to new issues within **5 business days**, matching the disclosure SLA in [SECURITY.md](./SECURITY.md). Triage labels are added during the first response.

For security vulnerabilities, **do not file a public issue** — see [SECURITY.md](./SECURITY.md).

## Pull requests

1. Fork, branch from `main`, push.
2. Open a PR against `main`. CI runs `pnpm verify` (`corepack enable && pnpm install --frozen-lockfile && pnpm typecheck`) plus the test suites.
3. Keep PRs scoped to one logical change. Refactors are fine, but don't bundle them with feature work — they're harder to review.
4. Tests are required for new behavior in `packages/sdk` and `packages/companion`. The trust-boundary tests in `packages/companion/test/*.test.mjs` are non-negotiable — anything that touches origin pinning, token delivery, or WS upgrade needs a regression test.

## Code style

- TypeScript, strict mode. No `any` without a comment explaining why.
- ESM modules (`"type": "module"`). No CommonJS.
- Formatting follows the existing files; we don't run Prettier on commit (yet). Match what's around your edit.
- Comments: only for *why*, not *what*. Don't narrate. Don't document obvious code.

## Licensing of contributions

By submitting a pull request you agree that your contribution is licensed under the MIT License (see [LICENSE](./LICENSE)). There is no CLA to sign — opening the PR is the acceptance.

## What we won't merge

- Telemetry, analytics, or crash-reporting added to the SDK/companion that calls out to a third party. The local loop is trusted *because* it doesn't phone home.
- Changes that broaden the companion's network surface (the bind is `127.0.0.1` only, and that's load-bearing for the trust model).
- Code that depends on a fork of the closed-source `@insitue/agent-core` or `@insitue/swc-source-attr` packages. Use the published versions.

## Where things live

- Issue tracking: this repo's Issues tab.
- Discussions: open an issue with the `question` label for now (Discussions isn't enabled).
- Cloud-product bugs: filed in the private `insitue-cloud` repo by maintainers; if you hit one as a paid customer, use the in-product support flow.
