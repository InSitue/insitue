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

export interface OrchestratorDeps {
  root: string;
  transport: "cli-headless" | "mcp" | "sdk";
  send: (msg: ServerMessage) => void;
}

export class AgentOrchestrator {
  constructor(private readonly deps: OrchestratorDeps) {}

  /** Sent once after the WS session authenticates. */
  announce(): void {
    this.deps.send({
      t: "agent-status",
      ready: false,
      transport: this.deps.transport,
      warnings: [],
      blockers: ["agent loop not implemented yet (M2-P0 scaffold)"],
    });
  }

  handleTurn(msg: AgentTurnMsg): void {
    this.deps.send({
      t: "agent-stream",
      event: {
        t: "agent-error",
        turnId: msg.turnId,
        code: "internal",
        message: "agent not wired yet (M2-P0)",
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
