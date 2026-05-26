# InSitue examples

Two minimal apps that exercise the SDK end-to-end against a local
companion. Use these to verify a fresh install or as a copy-paste
starting point.

| Example | Stack | What it shows |
|---|---|---|
| [`playground/`](./playground/README.md) | Vanilla HTML, no bundler, no framework | `mountCaptureOnly()` from `@insitue/sdk/capture-only` |
| [`react-app/`](./react-app/README.md) | Vite + React 19 | `<InSitueCapture />` / `<InSitue />` with the babel source-attribution plugin |
| [`screenshot-stress/`](./screenshot-stress/README.md) | Vanilla HTML, no bundler | 11-case battery for the inconsistent-blank-capture investigation (insitue#10) |

Both connect to the local `@insitue/companion` on the default
loopback port (`5747`). You'll want it running in another terminal:

```bash
pnpm --filter @insitue/companion dev
```

After that, follow the per-example README to start the app and pick
something in your browser.
