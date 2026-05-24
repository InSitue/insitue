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

## Install

```bash
pnpm add @insitue/capture-core
```

Zero runtime dependencies. Pure ES modules. Tree-shakeable to whatever
subset a host actually needs. Node 24+ recommended (the package itself
is browser-and-Node-compatible; the engine pin is for the build).

## 30-second usage

The shape every InSitue vehicle agrees on:

```ts
import {
  CAPTURE_SCHEMA_VERSION,
  resolveTarget,
  toIssueDraft,
  type CaptureBundle,
} from "@insitue/capture-core";

// 1. Resolve a picked DOM element to a source target.
const target = resolveTarget(document.querySelector("#hero")!);
// → { source: { file, line, column }, confidence, componentStack, selector }

// 2. Turn a fully populated CaptureBundle into a tracker-ready draft.
const draft = toIssueDraft(bundle satisfies CaptureBundle);
// → { title, body, bundle }  ← hand to gh / Linear / HTTP / a file
```

The `CaptureBundle` shape is wire-version pinned by
`CAPTURE_SCHEMA_VERSION`; bumping it is a breaking change for every
consumer that reads bundles.

## Public API

### Schema constants
- `CAPTURE_SCHEMA_VERSION` — bump when the bundle shape changes.
- `PROTOCOL_VERSION` — bump when the WS envelope changes.

### Bundle types
- `CaptureBundle` — the whole payload: target, DOM subtree, styles,
  screenshot, viewport, runtime (console/network/errors), user note.
- `CaptureTarget` — what was picked: source (when known), confidence,
  React component stack, fallback selector, optional CMS attribution.
- `SourceLoc`, `SourceConfidence`, `SerializedNode`, `SelectionInput`,
  `SelectionMode`, `ConsoleEntry`, `NetworkEntry`, `RuntimeError`.

### Sink interface (the swap point)
- `CaptureSink` — `submit(bundle)` is what turns "local agentic edit"
  (WS to companion) into "prod capture-only" (issue tracker) without
  a rewrite.
- `IssueTrackerSink` — built-in sink that calls `toIssueDraft` and
  hands the draft to a caller-supplied delivery function.
- `IssueDraft` — `{ title, body, bundle }` shape consumed by gh /
  Linear / HTTP / file delivery.

### Pure functions
- `toIssueDraft(bundle)` — bundle → markdown-rendered draft.
- `resolveTarget(el)` — DOM element → `CaptureTarget` (fiber walk
  with attribute and component-stack fallbacks).
- `serializeNode(el, depth?, maxChildren?)` — depth/breadth-capped,
  secret-redacted DOM snapshot.
- `curateComputedStyles(el)` — curated ~24-key subset of
  `getComputedStyle` (box model, layout, typography, color).
- `extractTailwindClasses(el)` — raw `className` split + filtered.
- `buildSelector(el)` — robust CSS path (`#id` → `[data-testid]` →
  tag + nth-of-type), shortest-unique, capped at 6 segments.
- `breakpointFor(viewportWidth)` — Tailwind-ish label (`xs`–`2xl`).

### WS envelope types
- `ClientMessage`, `ServerMessage` — discriminated unions of every
  frame on the SDK ↔ companion loopback WS.
- Individual frames: `HelloMsg`, `HelloOkMsg`, `PingMsg`, `PongMsg`,
  `ErrorMsg`, `CaptureSubmitMsg`, `CaptureResolvedMsg`,
  `AgentStatusMsg`, `AgentStreamMsg`, `AgentTurnMsg`,
  `AgentDecisionMsg`, `AgentCancelMsg`, `AgentUndoMsg`,
  `AgentUndoSessionMsg`, `AgentCommitSessionMsg`,
  `AgentUndoneMsg`, `AgentSessionUndoneMsg`,
  `AgentSessionCommittedMsg`, `ChangesetProposedMsg`,
  `ChangesetAppliedMsg`, `AgentAskExternalMsg`, `BroadcastAskMsg`,
  `SubscribersAttachedMsg`. Each has a `t:` discriminator and a
  JSDoc one-liner at the source.
- `AgentEvent` — provider-agnostic normalized stream item the
  companion produces from whatever the active agent transport
  (`cli-headless` | `mcp` | `sdk`) gave it.
- `ProposedEdit`, `AgentErrorCode` — supporting types.

## Stability

This package is **the seam**, not a consumer API surface. It's
published openly so the InSitue ecosystem (SDK, companion, claude
plugin) and its dependents can audit the wire format, but you are
not expected to depend on it directly — use `@insitue/sdk` (browser)
or `@insitue/companion` (Node). The bundle shape is wire-versioned
and load-bearing for every consumer that pins on it.

The exported runtime functions (`toIssueDraft`, `serializeNode`,
`resolveTarget`, etc.) are safe to use standalone if you want to
build your own vehicle on the same schema.

## Versioning

- **Major** — `CAPTURE_SCHEMA_VERSION` or `PROTOCOL_VERSION` bumps,
  breaking changes to existing type fields, removed exports.
- **Minor** — additive types or exports, additive schema fields
  (consumer code keeps compiling).
- **Patch** — JSDoc, docs, internal renames with no public surface
  change.

`@insitue/sdk`, `@insitue/companion`, and the cloud agent pin
against the same major and refuse to ride mismatched versions.

## Security

Report vulnerabilities privately — see [SECURITY.md](../../SECURITY.md)
in the repo root. Of particular concern in this package: anything
that lets a malicious bundle, once accepted by a sink, traverse out
of the consumer's intended scope.

## Tests

No in-package tests. The schema and helpers are exercised end-to-end
by `@insitue/sdk`, `@insitue/companion`, and the cloud agent's
integration suites; any change that would break a downstream consumer
fails CI in those packages first. If you make a change here, run the
workspace test suite (`pnpm test` from the repo root) before opening
a PR.

## License

MIT. © InSitue. See [LICENSE](./LICENSE).
