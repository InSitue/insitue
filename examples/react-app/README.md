# InSitue React example

A minimal Vite + React 19 app that mounts `<InSitueCapture />` in
prod-build mode and `<InSitue />` in dev-mode. Use it to verify the
full local agentic loop end-to-end against a real React tree, or as
a copy-paste starting point.

## Run it

From the repo root:

```bash
# 1. Start the companion (one-time per session).
pnpm --filter @insitue/companion dev

# 2. Start the example app.
pnpm --filter @insitue/example-react dev
# → http://localhost:3100
```

Open <http://localhost:3100>. You should see:

- An InSitue pill (companion sink, dev theme).
- Clicking the pill activates the picker.
- Picking any element — the heading, the card, the badge, the
  button — opens the capture panel with a resolved
  `file:line` and the component stack
  (`App < Card < Badge`).

## How source resolution works here

Vite/React dev doesn't expose React fiber `_debugSource`. This
example wires the `@insitue/sdk/babel` plugin into `vite.config.ts`
to inject `data-insitue-source="file:line:col"` on every JSX site,
so the SDK's resolver falls back to the build-injected attribute
and source resolution stays exact.

```ts
// vite.config.ts
react({
  babel: {
    plugins: [[insitueBabel, { root: __dirname }]],
  },
});
```

The `root` MUST match the directory the companion is scoped to,
otherwise paths emit relative to the wrong base.

## Production-build mode

```bash
pnpm --filter @insitue/example-react build
pnpm --filter @insitue/example-react preview
# → http://127.0.0.1:3101
```

In a `vite build`, `main.tsx` switches to `<InSitueCapture
onCapture={…} />` with a custom delivery function that stashes the
draft on `window.__insitue_capture__` — the capture-only seam, no
companion, suitable for inspection / integration tests.

## Files

| File | What it is |
|---|---|
| `src/main.tsx` | Entry point. Mounts `<InSitue />` in dev, `<InSitueCapture />` with custom sink in prod. |
| `src/App.tsx` | Tiny `App` / `Card` / `Badge` tree so the fiber walk produces a real component stack. |
| `vite.config.ts` | Wires the `@insitue/sdk/babel` plugin for source attribution. |
