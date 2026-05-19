/**
 * AgentOrchestrator — the only thing that knows both an AgentProvider
 * and the EditGateway exist. Wires provider `AgentEvent`s into the
 * changeset buffer and emits the agent WS messages. P0 = scaffold:
 * validates the message path end-to-end and reports "not wired yet";
 * P1+ fill in preflight, transports, and the edit gateway.
 */
import type {
  AgentCancelMsg,
  AgentCommitSessionMsg,
  AgentDecisionMsg,
  AgentTurnMsg,
  AgentUndoMsg,
  AgentUndoSessionMsg,
  CaptureBundle,
  ProposedEdit,
  ResolvedSource,
  ServerMessage,
} from "@insitu/capture-core";
import { ClaudeCodeProvider } from "./claude-code/provider.js";
import type { AgentProvider, AgentSession } from "./provider.js";
import { parseProposals, EDIT_START } from "./proposals.js";
import { buildChangeset, pickEdits } from "../edit/gateway.js";
import { applyEdits } from "../edit/mutator.js";
import {
  checkpoint,
  restore,
  commitFiles,
  type Checkpoint,
} from "../edit/git.js";

export interface OrchestratorDeps {
  root: string;
  transport: "cli-headless" | "mcp" | "sdk";
  allowApiKey: boolean;
  send: (msg: ServerMessage) => void;
}

interface StoredBundle {
  bundle: CaptureBundle;
  resolved: ResolvedSource | null;
}

export class AgentOrchestrator {
  private readonly provider: AgentProvider;
  private readonly bundles = new Map<string, StoredBundle>();
  /** bundleId → conversation transcript for that selection's thread.
   *  Replayed into each turn's prompt (provider-agnostic continuity). */
  private readonly threads = new Map<
    string,
    Array<{ role: "user" | "assistant"; text: string }>
  >();
  /** turnId → the proposed edits that passed the dry-run, awaiting an
   *  approve/reject decision. Cleared once decided. */
  private readonly pending = new Map<string, ProposedEdit[]>();
  /** turnId → pre-write checkpoint, for `agent-undo`. Insertion order
   *  is session order — `agent-undo-session` walks it in reverse. */
  private readonly checkpoints = new Map<string, Checkpoint>();
  /** turnId → files applied by that turn (for commit-session union;
   *  an entry is dropped when that turn is individually undone). */
  private readonly sessionFiles = new Map<string, string[]>();
  private session: AgentSession | null = null;
  private busy = false;

  constructor(private readonly deps: OrchestratorDeps) {
    this.provider = new ClaudeCodeProvider({
      transport: deps.transport,
      allowApiKey: deps.allowApiKey,
      root: deps.root,
    });
  }

  /** Called by the server when a capture is submitted, so a later
   *  agent-turn can reference it by id without re-sending the bundle. */
  registerBundle(bundle: CaptureBundle, resolved: ResolvedSource | null): void {
    this.bundles.set(bundle.id, { bundle, resolved });
    // bound memory: keep only the most recent handful
    if (this.bundles.size > 16) {
      const first = this.bundles.keys().next().value;
      if (first !== undefined) this.bundles.delete(first);
    }
  }

  /** Sent once after the WS session authenticates: runs the provider
   *  preflight and reports real readiness/auth state to the overlay. */
  async announce(): Promise<void> {
    let pf;
    try {
      pf = await this.provider.preflight();
    } catch (e) {
      pf = {
        ready: false,
        warnings: [],
        blockers: [`preflight failed: ${(e as Error).message}`],
      };
    }
    this.deps.send({
      t: "agent-status",
      ready: pf.ready,
      transport: this.deps.transport,
      warnings: pf.warnings,
      blockers: pf.blockers,
    });
  }

  handleTurn(msg: AgentTurnMsg): void {
    void this.runTurn(msg);
  }

  private async runTurn(msg: AgentTurnMsg): Promise<void> {
    const fail = (code: "internal" | "transport", message: string) =>
      this.deps.send({
        t: "agent-stream",
        event: { t: "agent-error", turnId: msg.turnId, code, message },
      });

    if (this.busy) {
      fail("internal", "a turn is already running (single-flight)");
      return;
    }
    const stored = this.bundles.get(msg.bundleId);
    if (!stored) {
      fail("internal", `unknown bundle ${msg.bundleId} — re-select first`);
      return;
    }
    this.busy = true;
    // Buffer the full text so proposals (which span many deltas) can be
    // parsed at turn end; suppress the raw file dump from the live chat
    // stream — only the explanation before the first sentinel streams.
    let textBuf = "";
    let forwarded = 0;
    const collected: ProposedEdit[] = [];
    const cleanText = () => {
      const idx = textBuf.indexOf(EDIT_START);
      return idx === -1 ? textBuf : textBuf.slice(0, idx);
    };
    try {
      if (!this.session) this.session = await this.provider.startSession();
      const prior = this.threads.get(msg.bundleId) ?? [];
      await this.session.sendTurn(
        {
          bundle: stored.bundle,
          resolved: stored.resolved,
          userMessage: msg.userMessage,
          history: prior.slice(),
        },
        (event) => {
          if (event.t === "agent-text") {
            textBuf += event.delta;
            const c = cleanText();
            if (c.length > forwarded) {
              this.deps.send({
                t: "agent-stream",
                event: {
                  t: "agent-text",
                  turnId: event.turnId,
                  delta: c.slice(forwarded),
                },
              });
              forwarded = c.length;
            }
            return;
          }
          if (event.t === "agent-tool-proposal") {
            collected.push(event.edit); // future `sdk` transport path
            return;
          }
          if (event.t === "agent-turn-complete") {
            const edits = [...collected, ...parseProposals(textBuf)];
            if (edits.length) {
              const cs = buildChangeset(this.deps.root, edits);
              if (cs.files.length) {
                // Keep the full contents for an approve decision; only
                // the edits that survived the dry-run sandbox/no-op.
                const accepted = edits.filter((e) =>
                  cs.files.some((f) => f.file === e.file),
                );
                this.pending.set(event.turnId, accepted);
                if (this.pending.size > 16) {
                  const k = this.pending.keys().next().value;
                  if (k !== undefined) this.pending.delete(k);
                }
                this.deps.send({
                  t: "changeset-proposed",
                  turnId: event.turnId,
                  files: cs.files,
                });
              }
              if (cs.skipped.length) {
                this.deps.send({
                  t: "agent-stream",
                  event: {
                    t: "agent-text",
                    turnId: event.turnId,
                    delta: `\n\n[insitu] skipped: ${cs.skipped
                      .map((s) => `${s.file} (${s.reason})`)
                      .join(", ")}`,
                  },
                });
              }
            }
            // Record the exchange for this selection's thread so the
            // next turn has continuity (bounded; transcript replay).
            const reply = cleanText().trim();
            const thread = this.threads.get(msg.bundleId) ?? [];
            thread.push({ role: "user", text: msg.userMessage.slice(0, 1200) });
            if (reply) {
              thread.push({ role: "assistant", text: reply.slice(0, 1200) });
            }
            while (thread.length > 12) thread.shift();
            this.threads.set(msg.bundleId, thread);
            if (this.threads.size > 16) {
              const k = this.threads.keys().next().value;
              if (k !== undefined) this.threads.delete(k);
            }
            this.deps.send({ t: "agent-stream", event });
            return;
          }
          this.deps.send({ t: "agent-stream", event });
        },
      );
    } catch (e) {
      fail("transport", (e as Error).message);
    } finally {
      this.busy = false;
    }
  }

  handleDecision(msg: AgentDecisionMsg): void {
    void this.applyDecision(msg);
  }

  private async applyDecision(msg: AgentDecisionMsg): Promise<void> {
    const note = (s: string) =>
      this.deps.send({
        t: "agent-stream",
        event: { t: "agent-text", turnId: msg.turnId, delta: `\n[insitu] ${s}` },
      });

    const accepted = this.pending.get(msg.turnId);
    if (!accepted) {
      note("nothing pending for this turn");
      return;
    }
    this.pending.delete(msg.turnId); // decided — single-shot

    if (msg.decision === "reject") {
      note(`rejected${msg.reason ? `: ${msg.reason}` : ""} — no files written`);
      return;
    }
    // NOTE: deliberately NOT gated on `this.busy`. The changeset was
    // buffered when the turn completed; applying it is a pure FS op
    // independent of whether the (read-only) agent child has finished
    // draining stdout. `busy` only single-flights *turns*.

    // Optional subset: undefined = whole changeset, [] = none.
    const edits = pickEdits(accepted, msg.files);
    if (!edits.length) {
      note("approved file set was empty — nothing written");
      return;
    }

    try {
      // Checkpoint BEFORE the first byte is written (undo = P5).
      const cp = await checkpoint(
        this.deps.root,
        edits.map((e) => e.file),
      );
      const res = applyEdits(this.deps.root, edits);
      if (res.written.length) {
        this.checkpoints.set(msg.turnId, cp);
        this.sessionFiles.set(msg.turnId, res.written);
        this.deps.send({
          t: "changeset-applied",
          turnId: msg.turnId,
          files: res.written,
          checkpointRef: cp.ref,
        });
      }
      if (res.failed.length) {
        note(
          `failed: ${res.failed
            .map((f) => `${f.file} (${f.reason})`)
            .join(", ")}`,
        );
      }
    } catch (e) {
      note(`apply failed: ${(e as Error).message}`);
    }
  }

  handleCancel(_msg: AgentCancelMsg): void {
    this.session?.cancel();
    this.busy = false;
  }
  handleUndo(msg: AgentUndoMsg): void {
    void this.runUndo(msg);
  }

  private async runUndo(msg: AgentUndoMsg): Promise<void> {
    const cp = this.checkpoints.get(msg.turnId);
    if (!cp) {
      this.deps.send({
        t: "agent-stream",
        event: {
          t: "agent-text",
          turnId: msg.turnId,
          delta: "\n[insitu] nothing to undo for this turn",
        },
      });
      return;
    }
    try {
      const restored = await restore(this.deps.root, cp);
      this.checkpoints.delete(msg.turnId); // single-shot
      this.sessionFiles.delete(msg.turnId);
      this.deps.send({
        t: "agent-undone",
        turnId: msg.turnId,
        restored,
      });
    } catch (e) {
      this.deps.send({
        t: "agent-stream",
        event: {
          t: "agent-error",
          turnId: msg.turnId,
          code: "internal",
          message: `undo failed: ${(e as Error).message}`,
        },
      });
    }
  }

  handleUndoSession(_msg: AgentUndoSessionMsg): void {
    void this.runUndoSession();
  }

  private async runUndoSession(): Promise<void> {
    // Reverse chronological: undo the most recent application first so
    // overlapping edits to the same file peel back correctly.
    const entries = [...this.checkpoints.entries()].reverse();
    const restored: string[] = [];
    for (const [turnId, cp] of entries) {
      try {
        const r = await restore(this.deps.root, cp);
        restored.push(...r);
        this.checkpoints.delete(turnId);
        this.sessionFiles.delete(turnId);
      } catch {
        /* keep going — best-effort session rollback */
      }
    }
    this.deps.send({
      t: "agent-session-undone",
      restored: [...new Set(restored)],
    });
  }

  handleCommitSession(msg: AgentCommitSessionMsg): void {
    void this.runCommitSession(msg);
  }

  private async runCommitSession(
    msg: AgentCommitSessionMsg,
  ): Promise<void> {
    const files = [...new Set([...this.sessionFiles.values()].flat())];
    const fail = (m: string) =>
      this.deps.send({
        t: "agent-stream",
        event: {
          t: "agent-error",
          turnId: "session",
          code: "internal",
          message: `commit-session: ${m}`,
        },
      });
    if (!files.length) {
      fail("nothing applied this session to commit");
      return;
    }
    try {
      const { commit, files: committed } = await commitFiles(
        this.deps.root,
        files,
        msg.message?.trim() || "InSitu session changes",
      );
      // Committed = durable; a later undo of these would fight git.
      this.checkpoints.clear();
      this.sessionFiles.clear();
      this.deps.send({
        t: "agent-session-committed",
        commit,
        files: committed,
      });
    } catch (e) {
      fail((e as Error).message);
    }
  }
}
