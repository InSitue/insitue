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

/** Bump when `CaptureBundle`'s shape changes; sinks branch on it. */
export const CAPTURE_SCHEMA_VERSION = 1 as const;
/** Bump when the WS envelope below changes; companion/SDK pin it.
 *  v2: adds the agent edit-loop messages (M2). */
export const PROTOCOL_VERSION = 2 as const;

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

/** Client→server messages. */
export type ClientMessage =
  | HelloMsg
  | PingMsg
  | CaptureSubmitMsg
  | AgentTurnMsg
  | AgentDecisionMsg
  | AgentCancelMsg
  | AgentUndoMsg;
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
  | AgentUndoneMsg;

export * from "./dom.js";
export * from "./react-source.js";
