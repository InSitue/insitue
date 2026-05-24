# InSitue examples

Two minimal apps that exercise the SDK end-to-end against a local
companion. Use these to verify a fresh install or as a copy-paste
starting point.

| Example | Stack | What it shows |
|---|---|---|
| [`playground/`](./playground/README.md) | Vanilla HTML, no bundler, no framework | `mountCaptureOnly()` from `@insitue/sdk/capture-only` |
| [`react-app/`](./react-app/README.md) | Vite + React 19 | `<InSitueCapture />` / `<InSitue />` with the babel source-attribution plugin |

Both connect to the local `@insitue/companion` on the default
loopback port (`5747`). You'll want it running in another terminal:

```bash
pnpm --filter @insitue/companion dev
```

After that, follow the per-example README to start the app and pick
something in your browser.
