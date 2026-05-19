# Testing InSitu (M0)

What you can exercise today, in order of effort.

## 1. Automated trust-boundary tests (fastest)

```sh
pnpm test
```

Builds, then runs 7 Node tests proving the security model: loopback-only
bind, foreign-`Origin` handshake → 403, foreign-`Origin` WS upgrade
refused, bad token rejected, bad protocol-version rejected, and a
working secure ping round-trip.

## 2. Real browser end-to-end (the playground)

A dependency-free page that loads the actual overlay against the real
companion — no host app, nothing else touched.

```sh
pnpm build            # or keep `pnpm dev` running (watch)
pnpm example          # serves http://localhost:3000
# in a second terminal:
pnpm companion        # companion on 127.0.0.1:5747
```

Open <http://localhost:3000>. Bottom-left pill should turn **green**
and read `companion 0.0.0`; click **Ping** → it shows the round-trip ms.
The overlay lives in a Shadow DOM (`#insitu-root`), fully style-isolated
from the page.

Verified automatically (Playwright): pill mounts in shadow DOM,
connects, `Ping (1ms)`.

## 3. Security spot-checks (manual)

```sh
# Origin pinning — pinned origin gets a token:
curl -s -H "Origin: http://localhost:3000" \
  http://127.0.0.1:5747/insitu/handshake

# Foreign origin is refused:
curl -s -o /dev/null -w "%{http_code}\n" \
  -H "Origin: http://evil.test" http://127.0.0.1:5747/insitu/handshake   # 403

# Prod-build refusal (companion must never run in prod):
NODE_ENV=production node packages/companion/dist/cli.js
#   → exits 1 with the refusal message
```

The companion binds `127.0.0.1` only — it is not reachable from another
machine on the network by design.

## 4. License cleanliness

```sh
pnpm license:check    # fails if any production dep is non-permissive
```

## 5. Dogfood in a real app (manual, dev-only — your call)

Add to a host app's root layout, dev-guarded, then run its dev server +
`npx insitu` from that repo root:

```tsx
{process.env.NODE_ENV === "development" && <InSitu />}
```

Intentionally NOT auto-wired into any existing repo — keeping host
build/deploy untouched is a deliberate safety choice.

---

### Notes / known limits at M0

- The session token is currently delivered via the Origin-pinned
  handshake; M1 tightens delivery so only the dev server (not any local
  process) can obtain it.
- `pnpm dev` runs all three packages in tsup watch mode; the playground
  server reads `packages/sdk/dist` live, so a rebuild + browser reload
  picks up changes (no HMR yet — that arrives with the M2 edit loop).
- Requires Node ≥ 20.
