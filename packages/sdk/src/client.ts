/**
 * Secure companion client: loopback handshake → token → WS hello →
 * ping/pong. The Origin pin + token are enforced server-side; this
 * just speaks the pinned protocol.
 */
import {
  PROTOCOL_VERSION,
  type AgentEvent,
  type CaptureBundle,
  type ResolvedSource,
  type ServerMessage,
} from "@insitu/capture-core";

export type ConnState = "idle" | "connecting" | "connected" | "error";

export interface AgentStatus {
  ready: boolean;
  transport: string;
  warnings: string[];
  blockers: string[];
}

export interface ClientEvents {
  onState(state: ConnState, detail?: string): void;
  onResolved?(
    id: string,
    resolved: ResolvedSource | null,
    note: string,
  ): void;
  onAgentStatus?(s: AgentStatus): void;
  onAgentEvent?(e: AgentEvent): void;
  onChangeset?(
    turnId: string,
    files: Array<{ file: string; diff: string; bytes: number }>,
  ): void;
}

export class CompanionClient {
  private ws: WebSocket | null = null;
  private readonly base: string;
  private readonly wsUrl: string;
  private readonly pending = new Map<string, (rttMs: number) => void>();

  constructor(
    private readonly port: number,
    private readonly events: ClientEvents,
  ) {
    this.base = `http://127.0.0.1:${port}`;
    this.wsUrl = `ws://127.0.0.1:${port}`;
  }

  async connect(): Promise<void> {
    this.events.onState("connecting");
    let token: string;
    try {
      const res = await fetch(`${this.base}/insitu/handshake`);
      if (!res.ok) throw new Error(`handshake ${res.status}`);
      token = (await res.json()).token as string;
    } catch (e) {
      this.events.onState("error", `companion unreachable (run \`npx insitu\`)`);
      return;
    }
    await new Promise<void>((done) => {
      const ws = new WebSocket(this.wsUrl);
      this.ws = ws;
      ws.onopen = () =>
        ws.send(
          JSON.stringify({ t: "hello", protocolVersion: PROTOCOL_VERSION, token }),
        );
      ws.onmessage = (ev) => {
        const msg = JSON.parse(ev.data as string) as ServerMessage;
        if (msg.t === "hello-ok") {
          this.events.onState("connected", `companion ${msg.companionVersion}`);
          done();
        } else if (msg.t === "pong") {
          const cb = this.pending.get(msg.nonce);
          if (cb) {
            this.pending.delete(msg.nonce);
            cb(performance.now() - Number(msg.nonce.split(":")[1]));
          }
        } else if (msg.t === "agent-status") {
          this.events.onAgentStatus?.({
            ready: msg.ready,
            transport: msg.transport,
            warnings: msg.warnings,
            blockers: msg.blockers,
          });
        } else if (msg.t === "agent-stream") {
          this.events.onAgentEvent?.(msg.event);
        } else if (msg.t === "changeset-proposed") {
          this.events.onChangeset?.(msg.turnId, msg.files);
        } else if (msg.t === "capture-resolved") {
          this.events.onResolved?.(msg.id, msg.resolved, msg.note);
        } else if (msg.t === "error") {
          this.events.onState("error", `${msg.code}: ${msg.message}`);
          done();
        }
      };
      ws.onerror = () => {
        this.events.onState("error", "websocket error");
        done();
      };
      ws.onclose = () => {
        if (this.ws === ws) this.events.onState("idle");
      };
    });
  }

  ping(): Promise<number> {
    return new Promise((resolve, reject) => {
      const ws = this.ws;
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        reject(new Error("not connected"));
        return;
      }
      const nonce = `n:${performance.now()}:${Math.random()}`;
      this.pending.set(nonce, resolve);
      ws.send(JSON.stringify({ t: "ping", nonce }));
      setTimeout(() => {
        if (this.pending.delete(nonce)) reject(new Error("ping timeout"));
      }, 3000);
    });
  }

  submitCapture(bundle: CaptureBundle): boolean {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;
    ws.send(JSON.stringify({ t: "capture", bundle }));
    return true;
  }

  sendTurn(turnId: string, bundleId: string, userMessage: string): boolean {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;
    ws.send(
      JSON.stringify({ t: "agent-turn", turnId, bundleId, userMessage }),
    );
    return true;
  }

  cancelTurn(turnId: string): void {
    this.ws?.send(JSON.stringify({ t: "agent-cancel", turnId }));
  }

  dispose(): void {
    this.ws?.close();
    this.ws = null;
  }
}
