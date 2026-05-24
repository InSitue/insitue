# InSitue playground

A dependency-free static page that mounts the InSitue capture widget
via the framework-agnostic `mountCaptureOnly()` API — no bundler, no
React, no framework. Use it to verify the SDK + companion loop works
on a fresh install without any host-app setup.

## Run it

From the repo root:

```bash
# 1. Build the SDK so packages/sdk/dist exists (the page imports
#    from there directly).
pnpm --filter @insitue/sdk build

# 2. Start the static server.
node examples/playground/serve.mjs
# → http://localhost:3000

# 3. In another terminal, start the companion.
pnpm --filter @insitue/companion dev
```

Open <http://localhost:3000>. You should see:

- An InSitue pill in the corner of the page.
- Clicking the pill activates the picker.
- Clicking any element (the card, the heading, the button) opens
  the capture panel.

If picks aren't flowing, the companion isn't running on the default
port — re-run step 3.

## What it imports

```js
import { mountCaptureOnly } from "/sdk/capture-only.js";
mountCaptureOnly();
```

`serve.mjs` maps `/sdk/*` to `packages/sdk/dist/*`, which is why the
SDK has to be built before serving. Real apps install
`@insitue/sdk` from npm and let their bundler resolve it.

## Files

| File | What it is |
|---|---|
| `index.html` | The page. Loads `mountCaptureOnly` from the local SDK build. |
| `serve.mjs` | Zero-dependency static server on `:3000` with a `/sdk/*` mount for the SDK dist. |
