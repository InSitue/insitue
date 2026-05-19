/**
 * ClaudeCodeProvider — v1 agent. Three transports behind one
 * interface: `cli-headless` (default, `claude -p` stream-json),
 * `mcp` (interactive parity, M2-P5), `sdk` (M2-P5). P1 implements
 * preflight for all; only `cli-headless` gets a session in P2.
 */
import { execa } from "execa";
import type { AgentProvider, AgentSession, PreflightResult } from "../provider.js";
import { apiKeyVarsPresent, scrubbedEnv } from "../env.js";
import { ClaudeCliSession } from "./transport-cli.js";
import { ClaudeMcpSession } from "./transport-mcp.js";
import { ClaudeSdkSession, sdkAvailable } from "./transport-sdk.js";

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

    // `sdk` is the only transport that doesn't shell out to `claude`.
    const needsCli = this.opts.transport !== "sdk";

    if (this.opts.transport === "sdk" && !sdkAvailable()) {
      blockers.push(
        "transport sdk: @anthropic-ai/claude-agent-sdk not installed — " +
          "`pnpm add -D @anthropic-ai/claude-agent-sdk` or use cli-headless",
      );
    }

    // `claude` present? (cli-headless + mcp spawn it)
    let version = "";
    if (needsCli) {
      try {
        const r = await execa("claude", ["--version"], { timeout: 8000 });
        version = r.stdout.trim();
      } catch {
        blockers.push(
          "`claude` CLI not found on PATH — install Claude Code, then `claude login`",
        );
      }
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
    const { root, allowApiKey, transport } = this.opts;
    switch (transport) {
      case "cli-headless":
        return Promise.resolve(
          new ClaudeCliSession({ root, env: scrubbedEnv(allowApiKey) }),
        );
      case "mcp":
        return Promise.resolve(
          new ClaudeMcpSession({ root, env: scrubbedEnv(allowApiKey) }),
        );
      case "sdk":
        if (!sdkAvailable()) {
          return Promise.reject(
            new Error(
              "@anthropic-ai/claude-agent-sdk not installed (transport sdk)",
            ),
          );
        }
        return Promise.resolve(new ClaudeSdkSession({ root, allowApiKey }));
      default:
        return Promise.reject(
          new Error(`unknown transport "${transport as string}"`),
        );
    }
  }
}
