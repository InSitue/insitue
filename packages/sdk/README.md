# `@insitue/sdk`

The InSitue capture widget for browser apps. One component,
two sinks: ship captures to the InSitue Cloud (production
bug-reporting → autopilot → draft PR) or to a local
`@insitue/companion` (developer mode → `claude` in your terminal
acts on each pick).

```tsx
import { InSitueCapture } from "@insitue/sdk";

// Dev: companion sink (no projectKey).
<InSitueCapture />

// Prod: cloud sink with your publishable project key.
<InSitueCapture projectKey="pk_..." />
```

Same widget. Same picker. Same screenshot pipeline. Only the
submit step changes.

---

## Install

```bash
npm install -D @insitue/sdk
# or pnpm add -D @insitue/sdk
# or yarn add -D @insitue/sdk
```

## Dev mode (talk to claude in your terminal)

Mount with no props. The widget connects to a local companion
over a loopback WebSocket. A `claude` session running
[`/insitue:connect`](https://www.npmjs.com/package/@insitue/claude-plugin)
picks up each capture and edits the file you pointed at.

```tsx
// app/layout.tsx (Next.js) — dev-gated so the chunk never
// ships in production.
import { InSitueCapture } from "@insitue/sdk";

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html>
      <body>
        {children}
        {process.env.NODE_ENV !== "production" && <InSitueCapture />}
      </body>
    </html>
  );
}
```

```tsx
// src/main.tsx (Vite)
import { InSitueCapture } from "@insitue/sdk";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
    {import.meta.env.DEV && <InSitueCapture />}
  </StrictMode>,
);
```

## Production mode (cloud sink → autopilot → draft PR)

Pass your publishable `projectKey` (e.g. `pk_…`). The key is
Origin-pinned and quota-gated server-side, so it's safe to ship
in a public bundle.

```tsx
<InSitueCapture projectKey={process.env.NEXT_PUBLIC_INSITUE_KEY!} />
```

End users see a friendly "Report a problem" pill in the corner
of your app. Clicking it activates the picker; describing +
sending submits to your InSitue inbox.

---

## Props

```ts
interface InSitueCaptureProps {
  /** Publishable project key. Set → cloud sink. */
  projectKey?: string;
  /** Override the cloud ingest endpoint. */
  endpoint?: string;
  /** Take over delivery yourself. Wins over both projectKey
   *  and sink. */
  onCapture?: (draft: IssueDraft, bundle: CaptureBundle) => void;
  /** Explicit sink override (rarely needed — most callers rely
   *  on auto-detection). */
  sink?: CaptureSink;
  /** Force getDisplayMedia capture from mount. Dev/dogfood only. */
  defaultPixelPerfect?: boolean;
}
```

## Sink auto-detection

| `projectKey` | `sink` | Result |
|---|---|---|
| set | unset | Cloud sink (post to InSitue Cloud) |
| unset | unset | Companion sink (post to local WS, default port `5747`) |
| any | set | Use `sink` verbatim |

`onCapture` wins over everything when defined.

---

## Bulletproof selection

Every pick the widget submits has a usable source location.
The picker walks React fiber `_debugSource` first (exact), then
the `data-insitu-source` attribute injected by
[`@insitue/sdk/babel`](#babel-plugin) (exact), then the nearest
owning component's source (approximate). If even that fails,
the widget refuses to send and asks the user to pick a parent
— claude never gets a meaningless selector-only pick.

The confidence chip is shown inline so users (and you, in
testing) can see exactly what's been resolved before they hit
Send.

## Babel plugin

Optional — only needed when your bundler doesn't expose React
fiber `_debugSource` (Vite, some Webpack setups). Adds a
`data-insitu-source="file:line:col"` attribute to every
intrinsic JSX element so source resolution stays exact.

```js
// vite.config.ts
import insituBabel from "@insitue/sdk/babel";

export default {
  plugins: [
    react({
      babel: {
        plugins: [[insituBabel, { root: __dirname }]],
      },
    }),
  ],
};
```

The `root` must match the project directory the companion is
scoped to (typically `__dirname` of `vite.config.ts`).

---

## What's in a capture

Every send produces a `CaptureBundle`:

```ts
interface CaptureBundle {
  id: string;                      // unique per capture
  target: { source, confidence, selector, componentStack };
  screenshot?: { dataUrl, source: "rasterise" | "display-media" };
  computedStyles: Record<string, string>;
  tailwindClasses: string[];
  userNote?: string;               // the user's description
  runtime: { url, route, console, network, errors };
  viewport: { w, h, dpr, breakpoint };
}
```

Cloud sink: this goes to `https://www.insitue.com/api/v1/capture`
with your `projectKey`. Companion sink: it goes to
`ws://127.0.0.1:5747` (the local companion's loopback WS) which
broadcasts to subscribed CLI/MCP listeners.

---

## Going to production

The same `<InSitueCapture />` works in both modes — just pass
`projectKey` in production and your users get the SaaS theme
(warm, friendly) instead of the dev theme (dark, terminal-flavour).
A typical setup:

```tsx
const PROJECT_KEY = process.env.NEXT_PUBLIC_INSITUE_KEY;
const IS_PROD = process.env.NODE_ENV === "production";

export default function InSitueWidget() {
  if (IS_PROD && !PROJECT_KEY) return null;
  return IS_PROD ? <InSitueCapture projectKey={PROJECT_KEY} /> : <InSitueCapture />;
}
```

Then drop `<InSitueWidget />` once in your app root.

---

## License

MIT.
