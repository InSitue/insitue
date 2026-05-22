# @insitue/capture-core

The transport-, agent-, and filesystem-free seam between the InSitue
browser SDK, the local companion process, and the cloud autopilot.
Pure data + pure functions: protocol versioning, capture-bundle
shape, source resolution (React fiber `_debugSource` → build-stamped
`data-insitue-source` → component-stack fallback), and DOM helpers.

```
   SDK (browser)          companion (Node)         cloud (HTTPS)
        │                       │                       │
        └─── @insitue/capture-core ────────────────────┘
              shared types ▪ protocol version ▪ resolver
```

## What's inside

| Module | Purpose |
|---|---|
| `index.ts` | Bundle schema (`CaptureBundle`, `CaptureTarget`), protocol-version constant, sink interface |
| `react-source.ts` | `resolveTarget(el)` — walks React fibers / data-attrs / component owners to give exact / approximate / selector-only source |
| `dom.ts` | Stable CSS-path serialisation (`buildSelector`), DOM tree snapshot helpers |

## Install

```bash
pnpm add @insitue/capture-core
```

Zero runtime dependencies. Pure ES modules. Designed to be tree-shaken
to whatever subset a host actually needs.

## Versioning

The `CAPTURE_SCHEMA_VERSION` constant bumps every time the wire
format breaks. Companion + SDK + cloud agent all pin against it; a
mismatch is treated as "refuse to ride" rather than "try and hope."

## Stability

Internal to the InSitue ecosystem. Not an SDK consumers should be
importing directly — they use `@insitue/sdk` (browser) or
`@insitue/companion` (Node) which both depend on this. Pinned as a
transitive dep with the package versions that ship in lockstep.

## License

MIT. © InSitue.
