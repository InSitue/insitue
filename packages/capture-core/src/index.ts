/**
 * @insitue/capture-core — THE SEAM.
 *
 * Pure, serializable data model + interfaces shared by every InSitue
 * vehicle (dev SDK now; production capture-only, browser extension or
 * Electron later). This package MUST NOT import transport (ws), an
 * agent SDK, or fs/git — that is enforced by lint (see eslint config)
 * and by keeping this file dependency-free. The whole point: a
 * `CaptureBundle` can cross any boundary unchanged, and swapping the
 * `CaptureSink` is what turns "local agentic edit" into "prod
 * capture-only" without a rewrite.
 */

/** Bump when `CaptureBundle`'s shape changes; sinks branch on it.
 *  v2: additive `screenshotUnavailable` (M5 — honest screenshots).
 *  v3: additive `screenshot.source` + `screenshot.qualityNote`
 *      (pixel-perfect layered capture — rasterise vs display-media). */
export const CAPTURE_SCHEMA_VERSION = 3 as const;
/** Bump when the WS envelope below changes; companion/SDK pin it.
 *  v2: agent edit-loop messages (M2). v3: session undo/commit (M3).
 *  v4: agent-activity (M6 — live "what it's doing" feedback). */
export const PROTOCOL_VERSION = 5 as const;

export interface SourceLoc {
  /** Repo-relative POSIX path, e.g. `components/MainBar.tsx`. */
  file: string;
  line: number;
  column: number;
}

export type SelectionMode = "element" | "rect" | "multi";

export interface SelectionInput {
  mode: SelectionMode;
  /** `elementsFromPoint` chain at the click (outermost→innermost). */
  pointerPath?: Element[];
  /** Freeform region in viewport CSS px. */
  rect?: { x: number; y: number; width: number; height: number };
}

export interface SerializedNode {
  tag: string;
  attrs: Record<string, string>;
  /** Truncated text content for leaf-ish nodes. */
  text?: string;
  children: SerializedNode[];
}

export interface ConsoleEntry {
  level: "log" | "info" | "warn" | "error" | "debug";
  args: string[];
  ts: number;
}

export interface NetworkEntry {
  url: string;
  method: string;
  status?: number;
  ok: boolean;
  ts: number;
}

export interface RuntimeError {
  message: string;
  stack?: string;
  ts: number;
}

/** How confident the DOM→source resolution is. Surfaced in the UI and
 *  handed to the agent so it knows whether file:line is trustworthy. */
export type SourceConfidence = "exact" | "approximate" | "selector-only";

export interface CaptureTarget {
  source?: SourceLoc;
  confidence: SourceConfidence;
  /** Outer→inner component ownership chain (React fiber `_debugOwner`). */
  componentStack: Array<{ name: string; source?: SourceLoc }>;
  /** Robust CSS path — always present, the last-resort locator. */
  selector: string;
  /** CMS attribution. Set when the picked element (or an ancestor)
   *  carries a `data-insitue-cms="<handle>"` attribute — host apps
   *  stamp this on CMS-rendered roots so tickets can tell reviewers
   *  "this content lives in the CMS, not the component". The
   *  `handle` is opaque to InSitue (host convention) — e.g.
   *  `briefings:<slug>:body`. Cloud tickets show this alongside
   *  the code source. Optional `adminUrl` (via the companion
   *  `data-insitue-cms-url` sibling attribute) deep-links to the
   *  CMS row in the host's admin UI. */
  cmsSource?: {
    handle: string;
    adminUrl?: string;
  };
}

export interface CaptureBundle {
  schemaVersion: typeof CAPTURE_SCHEMA_VERSION;
  id: string;
  createdAt: string;
  target: CaptureTarget | null;
  domSubtree: SerializedNode;
  computedStyles: Record<string, string>;
  tailwindClasses: string[];
  screenshot?: {
    mime: "image/png";
    dataUrl: string;
    bounds: { x: number; y: number; width: number; height: number };
    /** Which capture path produced this screenshot. `rasterise` =
     *  html-to-image full-document render + crop (no permission).
     *  `display-media` = `getDisplayMedia` OS-compositor capture (one
     *  permission per session, pixel-perfect across any content). */
    source?: "rasterise" | "display-media";
    /** Human-readable note when the capture is structurally complete
     *  but visually imperfect — e.g. some non-CORS images fell back
     *  to a placeholder because the user declined `getDisplayMedia`. */
    qualityNote?: string;
  };
  /** Set (and `screenshot` omitted) when an in-browser rasterise was
   *  impossible — e.g. cross-origin media taints the canvas. Honest
   *  signal so the UI/sink never shows a blank box claiming success. */
  screenshotUnavailable?: string;
  viewport: { w: number; h: number; dpr: number; breakpoint?: string };
  runtime: {
    url: string;
    route?: string;
    console: ConsoleEntry[];
    network: NetworkEntry[];
    errors: RuntimeError[];
  };
  userNote?: string;
}

/** Builds bundles from a selection. Implemented by the SDK; the
 *  contract is what an extension/Electron vehicle reuses verbatim. */
export interface CaptureCore {
  beginPick(opts?: { mode?: SelectionMode }): Promise<SelectionInput>;
  buildBundle(sel: SelectionInput): Promise<CaptureBundle>;
}

/** The swap point. v1 local = WebSocketAgentSink (→ companion → agent
 *  edits). Future prod = IssueTrackerSink (same bundle → hosted task,
 *  no auto-edit). capture-core never knows which. */
export interface CaptureSink {
  readonly kind: string;
  submit(bundle: CaptureBundle): Promise<void>;
}

/* ── Prod capture-only seam (M4 — validated, not shipped) ──
 * The future hosted offering rides this exact `CaptureSink` swap: no
 * companion, no agent, no fs — the SAME `CaptureBundle` becomes a
 * source-aware task. `toIssueDraft` is pure (no DOM/fetch/transport)
 * so capture-core stays the dependency-free seam; delivery (gh/Linear/
 * Jira/HTTP/file) is the consumer's choice, never capture-core's. */

export interface IssueDraft {
  title: string;
  /** Markdown summary a human/tracker can read at a glance. */
  body: string;
  /** Full bundle, attached verbatim for the agent-ready future. */
  bundle: CaptureBundle;
}

/** Turn a bundle into a tracker-ready draft. Source is included when
 *  present (fiber/attribute resolved it client-side) and degrades
 *  gracefully to the always-present selector when it isn't. */
export function toIssueDraft(bundle: CaptureBundle): IssueDraft {
  const t = bundle.target;
  const where =
    t?.source
      ? `\`${t.source.file}:${t.source.line}\` (${t.confidence})`
      : t
        ? `\`${t.selector}\` (selector-only — no source resolver)`
        : "(empty selection)";
  const stack =
    t?.componentStack.map((c) => c.name).join(" < ") || "(none)";
  const errs = bundle.runtime.errors.length;
  const title =
    `[InSitue] ${t?.componentStack[0]?.name ?? t?.selector ?? "selection"}` +
    ` on ${bundle.runtime.route ?? new URL(bundle.runtime.url).pathname}`;
  const body = [
    `**Where:** ${where}`,
    `**Components:** ${stack}`,
    `**URL:** ${bundle.runtime.url}`,
    `**Viewport:** ${bundle.viewport.w}×${bundle.viewport.h}` +
      `${bundle.viewport.breakpoint ? ` (${bundle.viewport.breakpoint})` : ""}`,
    `**Tailwind:** ${bundle.tailwindClasses.join(" ") || "—"}`,
    `**Runtime:** ${bundle.runtime.console.length} log · ` +
      `${bundle.runtime.network.length} net · ${errs} err`,
    `**Screenshot:** ${
      bundle.screenshot
        ? `attached` +
          (bundle.screenshot.source
            ? ` (${bundle.screenshot.source})`
            : "") +
          (bundle.screenshot.qualityNote
            ? ` — ${bundle.screenshot.qualityNote}`
            : "")
        : bundle.screenshotUnavailable
          ? `unavailable — ${bundle.screenshotUnavailable}`
          : "—"
    }`,
    bundle.userNote ? `\n> ${bundle.userNote}` : "",
    `\n_Captured ${bundle.createdAt} · schema v${bundle.schemaVersion}_`,
  ].join("\n");
  return { title, body, bundle };
}

/** A CaptureSink that produces an `IssueDraft` and hands it to a
 *  caller-supplied delivery fn (download/gh/HTTP — not our concern).
 *  Same bundle, different sink: this is the local→prod door. */
export class IssueTrackerSink implements CaptureSink {
  readonly kind = "issue-tracker";
  constructor(
    private readonly deliver: (draft: IssueDraft) => void | Promise<void>,
  ) {}
  async submit(bundle: CaptureBundle): Promise<void> {
    await this.deliver(toIssueDraft(bundle));
  }
}

/* ── WS envelope (pure type definitions only; no transport here) ──
 * Shared so the SDK client and the companion server agree on shape.
 * The companion zod-validates these at the trust boundary. */

/** Client → server handshake. First frame on every WS connection;
 *  the server checks `protocolVersion` matches and `token` matches
 *  the per-session shared secret before accepting any other frame. */
export interface HelloMsg {
  t: "hello";
  protocolVersion: typeof PROTOCOL_VERSION;
  token: string;
}
/** Server → client handshake ack. Carries the companion version so
 *  the SDK can surface a mismatch warning in the overlay. */
export interface HelloOkMsg {
  t: "hello-ok";
  companionVersion: string;
}
/** Client → server keepalive. Server echoes the same `nonce` in a
 *  matching `PongMsg`; absence of pong drives reconnection. */
export interface PingMsg {
  t: "ping";
  nonce: string;
}
/** Server → client keepalive reply. `nonce` matches the originating
 *  `PingMsg` so the client can pair them and measure RTT. */
export interface PongMsg {
  t: "pong";
  nonce: string;
}
/** Server → client refusal. `code` is machine-readable so the
 *  overlay can render the right remediation hint. */
export interface ErrorMsg {
  t: "error";
  code: "bad-token" | "bad-origin" | "bad-protocol" | "internal";
  message: string;
}

/** Client → server: submit a freshly built `CaptureBundle`. The
 *  server validates it (zod), resolves source, and replies with a
 *  matching `CaptureResolvedMsg` keyed by `bundle.id`. */
export interface CaptureSubmitMsg {
  t: "capture";
  bundle: CaptureBundle;
}

/** Companion's resolution of a submitted bundle's source target. */
export interface ResolvedSource {
  /** Repo-relative POSIX path the companion resolved. */
  file: string;
  line: number;
  column: number;
  /** A few lines around `line` from the real file. */
  snippet: string;
  /** Whole component file path, if distinct/known. */
  componentFile?: string;
}
export interface CaptureResolvedMsg {
  t: "capture-resolved";
  id: string;
  resolved: ResolvedSource | null;
  /** Human note, e.g. why resolution was selector-only. */
  note: string;
}

/* ── Agent edit loop (M2) ──
 * Pure event/contract types. `AgentEvent` is provider-agnostic — a
 * ClaudeCodeProvider transport (cli-headless | mcp | sdk) normalizes
 * its native stream into this; the overlay/companion never name a
 * provider. Edits are PROPOSED here, never executed by the agent. */

export type AgentErrorCode =
  | "not-logged-in"
  | "api-key-set"
  | "claude-missing"
  | "transport"
  | "internal";

/** A normalized file edit the agent proposes (never auto-applied). */
export interface ProposedEdit {
  /** Repo-relative POSIX path. */
  file: string;
  /** Whole new file contents (companion diffs vs disk). */
  contents: string;
  /** Optional one-line rationale from the agent. */
  why?: string;
}

export type AgentEvent =
  | { t: "agent-text"; turnId: string; delta: string }
  | { t: "agent-thinking"; turnId: string; note: string }
  /** Live "what it's doing" signal (tool use / phase) — UI progress
   *  only, never part of the transcript. */
  | {
      t: "agent-activity";
      turnId: string;
      kind: "tool" | "thinking" | "start";
      label: string;
    }
  | { t: "agent-tool-proposal"; turnId: string; edit: ProposedEdit }
  | { t: "agent-turn-complete"; turnId: string }
  | { t: "agent-error"; turnId: string; code: AgentErrorCode; message: string };

/** Server → client: companion preflight result for the active
 *  provider/transport. `blockers` empty + `ready: true` means the
 *  overlay can offer ASK. */
export interface AgentStatusMsg {
  t: "agent-status";
  ready: boolean;
  transport: "cli-headless" | "mcp" | "sdk";
  warnings: string[];
  blockers: string[];
}
/** Server → client: a normalized `AgentEvent` from the active
 *  provider. Wrapping the event keeps the WS envelope discriminated
 *  by `t` while letting the inner `AgentEvent` evolve. */
export interface AgentStreamMsg {
  t: "agent-stream";
  event: AgentEvent;
}
/** Server → client: the agent's proposed file edits for `turnId`,
 *  diffed against disk and ready for human approval. `diff` is
 *  unified-format text suitable for direct UI rendering. */
export interface ChangesetProposedMsg {
  t: "changeset-proposed";
  turnId: string;
  files: Array<{ file: string; diff: string; bytes: number }>;
}
/** Server → client: the changeset for `turnId` was written to disk.
 *  `checkpointRef` is the opaque handle the companion uses to undo
 *  this specific application later. */
export interface ChangesetAppliedMsg {
  t: "changeset-applied";
  turnId: string;
  files: string[];
  checkpointRef: string;
}
/** Server → client: a previously applied changeset for `turnId` was
 *  undone. `restored` lists every file the companion rewrote back. */
export interface AgentUndoneMsg {
  t: "agent-undone";
  turnId: string;
  restored: string[];
}

/** Client → server: user submitted an ASK for a bundle. Drives the
 *  in-overlay headless agent (or routes externally — see
 *  `AgentAskExternalMsg` for protocol v5 routing). */
export interface AgentTurnMsg {
  t: "agent-turn";
  turnId: string;
  bundleId: string;
  userMessage: string;
}
/** Client → server: user accepted or rejected a proposed changeset.
 *  `approve` triggers write + checkpoint; `reject` discards the
 *  proposal without touching disk. */
export interface AgentDecisionMsg {
  t: "agent-decision";
  turnId: string;
  decision: "approve" | "reject";
  /** Subset of files to act on; omitted = whole changeset. */
  files?: string[];
  reason?: string;
}
/** Client → server: stop the agent mid-turn. Best-effort — the
 *  provider may have already produced output that's about to arrive. */
export interface AgentCancelMsg {
  t: "agent-cancel";
  turnId: string;
}
/** Client → server: undo the changeset for `turnId`, restoring files
 *  to their pre-application contents from the checkpoint. */
export interface AgentUndoMsg {
  t: "agent-undo";
  turnId: string;
}
/** Undo every checkpoint applied this session (reverse order). */
export interface AgentUndoSessionMsg {
  t: "agent-undo-session";
}
/** Explicit, user-initiated git commit of ONLY the files InSitue
 *  applied this session. Never auto; never pushes. */
export interface AgentCommitSessionMsg {
  t: "agent-commit-session";
  message?: string;
}
/** Server → client: ack for `AgentUndoSessionMsg`. Lists every file
 *  restored across all rolled-back checkpoints. */
export interface AgentSessionUndoneMsg {
  t: "agent-session-undone";
  restored: string[];
}
/** Server → client: ack for `AgentCommitSessionMsg`. `commit` is the
 *  short sha of the newly created commit. */
export interface AgentSessionCommittedMsg {
  t: "agent-session-committed";
  /** Short commit sha. */
  commit: string;
  files: string[];
}

/* ── #162 protocol v5: external-agent ask routing ──
 * When a CLI/MCP subscriber is attached (e.g. claude with
 * `/insitue:connect` open), the overlay's Send button routes the
 * user's typed intent to that external claude INSTEAD of spawning
 * the in-overlay headless agent. Three message types make this
 * work; they're additive — protocol v4 servers/clients keep
 * functioning, just without the external-routing affordance. */

/** Browser → companion: user clicked Send in the overlay's ASK
 *  textbox AND a CLI/MCP subscriber is attached. Companion
 *  re-broadcasts as `broadcast-ask` to subscribers and does NOT
 *  spawn its own headless agent. */
export interface AgentAskExternalMsg {
  t: "agent-ask-external";
  turnId: string;
  bundleId: string;
  text: string;
}

/** Companion → CLI/MCP subscribers: a browser just sent an external
 *  ask. Joined with the matching `broadcast-capture` by `bundleId`
 *  in the subscriber (the MCP bridge holds picks for a few seconds
 *  so the ask catches up). */
export interface BroadcastAskMsg {
  t: "broadcast-ask";
  bundleId: string;
  text: string;
  at: string;
}

/** Companion → browser: how many CLI/MCP subscribers are currently
 *  attached. Pushed on every connect + disconnect so the overlay
 *  can show/hide the "→ claude in terminal" badge and route Send
 *  accordingly. count=0 means "no external agent attached — Send
 *  goes to the in-overlay headless agent (today's behavior)". */
export interface SubscribersAttachedMsg {
  t: "subscribers-attached";
  count: number;
}

/** Discriminated union of every client → server WS frame.
 *  Consumers exhaustively `switch (msg.t)` to handle each shape. */
export type ClientMessage =
  | HelloMsg
  | PingMsg
  | CaptureSubmitMsg
  | AgentTurnMsg
  | AgentAskExternalMsg
  | AgentDecisionMsg
  | AgentCancelMsg
  | AgentUndoMsg
  | AgentUndoSessionMsg
  | AgentCommitSessionMsg;
/** Discriminated union of every server → client WS frame.
 *  Consumers exhaustively `switch (msg.t)` to handle each shape. */
export type ServerMessage =
  | HelloOkMsg
  | PongMsg
  | ErrorMsg
  | CaptureResolvedMsg
  | AgentStatusMsg
  | AgentStreamMsg
  | ChangesetProposedMsg
  | ChangesetAppliedMsg
  | AgentUndoneMsg
  | AgentSessionUndoneMsg
  | AgentSessionCommittedMsg
  | SubscribersAttachedMsg;

export * from "./dom.js";
export * from "./react-source.js";
