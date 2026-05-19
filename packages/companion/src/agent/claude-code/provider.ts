/**
 * ClaudeCodeProvider — v1 agent. Three transports behind one
 * interface: `cli-headless` (default, `claude -p` stream-json),
 * `mcp` (interactive parity, M2-P5), `sdk` (M2-P5). P1 implements
 * preflight for all; only `cli-headless` gets a session in P2.
 */
import { execa } from "execa";
import type { AgentProvider, AgentSession, PreflightResult } from "../provider.js";
import { apiKeyVarsPresent } from "../env.js";

export type ClaudeTransport = "cli-headless" | "mcp" | "sdk";

export interface ClaudeCodeProviderOpts {
  transport: ClaudeTransport;
  allowApiKey: boolean;
  root: string;
}

export class ClaudeCodeProvider implements AgentProvider {
  readonly id = "claude-code";
  constructor(private readonly opts: ClaudeCodeProviderOpts) {}

  async preflight(): Promise<PreflightResult> {
    const warnings: string[] = [];
    const blockers: string[] = [];

    if (this.opts.transport !== "cli-headless") {
      blockers.push(
        `transport "${this.opts.transport}" arrives in M2-P5 — use cli-headless`,
      );
    }

    // `claude` present?
    let version = "";
    try {
      const r = await execa("claude", ["--version"], { timeout: 8000 });
      version = r.stdout.trim();
    } catch {
      blockers.push(
        "`claude` CLI not found on PATH — install Claude Code, then `claude login`",
      );
    }

    // API-key billing footgun.
    const keys = apiKeyVarsPresent();
    if (keys.length) {
      warnings.push(
        this.opts.allowApiKey
          ? `${keys.join("/")} set and --allow-api-key given → turns bill the Anthropic API, not your Max plan`
          : `${keys.join("/")} detected — scrubbed from the agent env so turns bill your Max plan (use --allow-api-key to bill the API instead)`,
      );
    }

    // Login can't be verified cheaply without a billable call; surface
    // it as guidance. A real auth failure shows on the first turn.
    if (version) {
      warnings.push(
        `claude ${version} — ensure you've run \`claude login\` with your Pro/Max plan`,
      );
    }

    return { ready: blockers.length === 0, warnings, blockers };
  }

  startSession(): Promise<AgentSession> {
    // Filled in M2-P2 (cli-headless transport).
    return Promise.reject(
      new Error("agent session not implemented until M2-P2"),
    );
  }
}
