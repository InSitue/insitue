/**
 * Provider-agnostic agent seam. Concrete providers (Claude Code now;
 * Claude API / OpenAI-compatible / MCP later) implement this; the
 * orchestrator + overlay only ever see this interface and the pure
 * `AgentEvent` union from capture-core. Never leaks a provider type.
 */
import type {
  AgentEvent,
  CaptureBundle,
  ResolvedSource,
} from "@insitu/capture-core";

export interface PreflightResult {
  ready: boolean;
  warnings: string[];
  blockers: string[];
}

export interface AgentSessionInput {
  bundle: CaptureBundle;
  resolved: ResolvedSource | null;
  userMessage: string;
}

export interface AgentSession {
  readonly sessionId: string;
  /** Run one turn; stream normalized events. Resolves when complete. */
  sendTurn(
    input: AgentSessionInput,
    onEvent: (e: AgentEvent) => void,
  ): Promise<void>;
  cancel(): void;
  dispose(): void;
}

export interface AgentProvider {
  readonly id: string;
  /** Cheap, non-billable readiness/auth check. */
  preflight(): Promise<PreflightResult>;
  startSession(): Promise<AgentSession>;
}
