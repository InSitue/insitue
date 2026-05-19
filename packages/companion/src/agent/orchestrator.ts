/**
 * AgentOrchestrator — the only thing that knows both an AgentProvider
 * and the EditGateway exist. Wires provider `AgentEvent`s into the
 * changeset buffer and emits the agent WS messages. P0 = scaffold:
 * validates the message path end-to-end and reports "not wired yet";
 * P1+ fill in preflight, transports, and the edit gateway.
 */
import type {
  AgentCancelMsg,
  AgentDecisionMsg,
  AgentTurnMsg,
  AgentUndoMsg,
  CaptureBundle,
  ResolvedSource,
  ServerMessage,
} from "@insitu/capture-core";
import { ClaudeCodeProvider } from "./claude-code/provider.js";
import type { AgentProvider, AgentSession } from "./provider.js";

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
    try {
      if (!this.session) this.session = await this.provider.startSession();
      await this.session.sendTurn(
        {
          bundle: stored.bundle,
          resolved: stored.resolved,
          userMessage: msg.userMessage,
        },
        (event) => this.deps.send({ t: "agent-stream", event }),
      );
    } catch (e) {
      fail("transport", (e as Error).message);
    } finally {
      this.busy = false;
    }
  }

  handleDecision(_msg: AgentDecisionMsg): void {
    /* P3+ */
  }
  handleCancel(_msg: AgentCancelMsg): void {
    this.session?.cancel();
    this.busy = false;
  }
  handleUndo(_msg: AgentUndoMsg): void {
    /* P5 */
  }
}
