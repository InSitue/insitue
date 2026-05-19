/**
 * @insitu/capture-core — THE SEAM.
 *
 * Pure, serializable data model + interfaces shared by every InSitu
 * vehicle (dev SDK now; production capture-only, browser extension or
 * Electron later). This package MUST NOT import transport (ws), an
 * agent SDK, or fs/git — that is enforced by lint (see eslint config)
 * and by keeping this file dependency-free. The whole point: a
 * `CaptureBundle` can cross any boundary unchanged, and swapping the
 * `CaptureSink` is what turns "local agentic edit" into "prod
 * capture-only" without a rewrite.
 */

/** Bump when `CaptureBundle`'s shape changes; sinks branch on it.
 *  v2: additive `screenshotUnavailable` (M5 — honest screenshots). */
export const CAPTURE_SCHEMA_VERSION = 2 as const;
/** Bump when the WS envelope below changes; companion/SDK pin it.
 *  v2: agent edit-loop messages (M2). v3: session undo/commit (M3).
 *  v4: agent-activity (M6 — live "what it's doing" feedback). */
export const PROTOCOL_VERSION = 4 as const;

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
    `[InSitu] ${t?.componentStack[0]?.name ?? t?.selector ?? "selection"}` +
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
        ? "attached"
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

export interface HelloMsg {
  t: "hello";
  protocolVersion: typeof PROTOCOL_VERSION;
  token: string;
}
export interface HelloOkMsg {
  t: "hello-ok";
  companionVersion: string;
}
export interface PingMsg {
  t: "ping";
  nonce: string;
}
export interface PongMsg {
  t: "pong";
  nonce: string;
}
export interface ErrorMsg {
  t: "error";
  code: "bad-token" | "bad-origin" | "bad-protocol" | "internal";
  message: string;
}

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

/** Companion preflight result for the active provider/transport. */
export interface AgentStatusMsg {
  t: "agent-status";
  ready: boolean;
  transport: "cli-headless" | "mcp" | "sdk";
  warnings: string[];
  blockers: string[];
}
export interface AgentStreamMsg {
  t: "agent-stream";
  event: AgentEvent;
}
export interface ChangesetProposedMsg {
  t: "changeset-proposed";
  turnId: string;
  files: Array<{ file: string; diff: string; bytes: number }>;
}
export interface ChangesetAppliedMsg {
  t: "changeset-applied";
  turnId: string;
  files: string[];
  checkpointRef: string;
}
export interface AgentUndoneMsg {
  t: "agent-undone";
  turnId: string;
  restored: string[];
}

export interface AgentTurnMsg {
  t: "agent-turn";
  turnId: string;
  bundleId: string;
  userMessage: string;
}
export interface AgentDecisionMsg {
  t: "agent-decision";
  turnId: string;
  decision: "approve" | "reject";
  /** Subset of files to act on; omitted = whole changeset. */
  files?: string[];
  reason?: string;
}
export interface AgentCancelMsg {
  t: "agent-cancel";
  turnId: string;
}
export interface AgentUndoMsg {
  t: "agent-undo";
  turnId: string;
}
/** Undo every checkpoint applied this session (reverse order). */
export interface AgentUndoSessionMsg {
  t: "agent-undo-session";
}
/** Explicit, user-initiated git commit of ONLY the files InSitu
 *  applied this session. Never auto; never pushes. */
export interface AgentCommitSessionMsg {
  t: "agent-commit-session";
  message?: string;
}
export interface AgentSessionUndoneMsg {
  t: "agent-session-undone";
  restored: string[];
}
export interface AgentSessionCommittedMsg {
  t: "agent-session-committed";
  /** Short commit sha. */
  commit: string;
  files: string[];
}

/** Client→server messages. */
export type ClientMessage =
  | HelloMsg
  | PingMsg
  | CaptureSubmitMsg
  | AgentTurnMsg
  | AgentDecisionMsg
  | AgentCancelMsg
  | AgentUndoMsg
  | AgentUndoSessionMsg
  | AgentCommitSessionMsg;
/** Server→client messages. */
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
  | AgentSessionCommittedMsg;

export * from "./dom.js";
export * from "./react-source.js";
