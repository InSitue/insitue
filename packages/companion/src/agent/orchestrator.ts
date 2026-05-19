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
  ServerMessage,
} from "@insitu/capture-core";
import { ClaudeCodeProvider } from "./claude-code/provider.js";
import type { AgentProvider } from "./provider.js";

export interface OrchestratorDeps {
  root: string;
  transport: "cli-headless" | "mcp" | "sdk";
  allowApiKey: boolean;
  send: (msg: ServerMessage) => void;
}

export class AgentOrchestrator {
  private readonly provider: AgentProvider;
  constructor(private readonly deps: OrchestratorDeps) {
    this.provider = new ClaudeCodeProvider({
      transport: deps.transport,
      allowApiKey: deps.allowApiKey,
      root: deps.root,
    });
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
    // P2 wires provider.startSession()/sendTurn(); P1 = preflight only.
    this.deps.send({
      t: "agent-stream",
      event: {
        t: "agent-error",
        turnId: msg.turnId,
        code: "internal",
        message: "turn handling arrives in M2-P2",
      },
    });
  }

  handleDecision(_msg: AgentDecisionMsg): void {
    /* P3+ */
  }
  handleCancel(_msg: AgentCancelMsg): void {
    /* P2+ */
  }
  handleUndo(_msg: AgentUndoMsg): void {
    /* P5 */
  }
}
