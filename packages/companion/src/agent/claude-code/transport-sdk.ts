/**
 * `sdk` transport: `@anthropic-ai/claude-agent-sdk` `query()` in-process
 * (richer tool-use interception later). The SDK is an OPTIONAL PEER —
 * NOT a dependency of this package — because its license is non-SPDX
 * ("SEE LICENSE IN README.md") and would fail `license:check
 * --production`. It is dynamically imported only when the user opts in
 * with `--agent-transport sdk`; absent → an actionable preflight
 * blocker. The SDK yields the same Claude message envelope the CLI
 * does, so it shares `normalizeNative` → transport parity.
 */
import { createRequire } from "node:module";
import type { AgentEvent } from "@insitu/capture-core";
import type { AgentSession, AgentSessionInput } from "../provider.js";
import { buildPrompt } from "../context.js";
import { apiKeyVarsPresent } from "../env.js";
import { normalizeNative, type NativeMessage } from "./normalize.js";

const SDK_PKG = "@anthropic-ai/claude-agent-sdk";

/** Is the optional peer installed? Cheap, no import side effects. */
export function sdkAvailable(): boolean {
  try {
    createRequire(import.meta.url).resolve(SDK_PKG);
    return true;
  } catch {
    return false;
  }
}

export interface SdkSessionOpts {
  root: string;
  allowApiKey: boolean;
}

export class ClaudeSdkSession implements AgentSession {
  readonly sessionId = `sdk_${Date.now().toString(36)}`;
  private aborter: AbortController | null = null;

  constructor(private readonly opts: SdkSessionOpts) {}

  async sendTurn(
    input: AgentSessionInput,
    onEvent: (e: AgentEvent) => void,
  ): Promise<void> {
    const turnId = input.bundle.id;
    const mod = (await import(SDK_PKG).catch(() => {
      throw new Error(
        `${SDK_PKG} not installed — \`pnpm add -D ${SDK_PKG}\` or use --agent-transport cli-headless`,
      );
    })) as {
      query: (a: {
        prompt: string;
        options?: Record<string, unknown>;
      }) => AsyncIterable<NativeMessage>;
    };

    // In-process: Claude Code resolves auth from process.env, so scrub
    // the API-key vars for the duration of the query (restore in
    // finally) — same Max-billing protection the spawned transports
    // get from a scrubbed child env.
    const saved: Record<string, string | undefined> = {};
    if (!this.opts.allowApiKey) {
      for (const k of apiKeyVarsPresent()) {
        saved[k] = process.env[k];
        delete process.env[k];
      }
    }
    this.aborter = new AbortController();
    try {
      const stream = mod.query({
        prompt: buildPrompt(input),
        options: {
          cwd: this.opts.root,
          allowedTools: ["Read", "Grep", "Glob"],
          abortController: this.aborter,
        },
      });
      for await (const msg of stream) {
        for (const ev of normalizeNative(msg, turnId)) onEvent(ev);
      }
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v !== undefined) process.env[k] = v;
      }
      this.aborter = null;
    }
  }

  cancel(): void {
    this.aborter?.abort();
    this.aborter = null;
  }

  dispose(): void {
    this.cancel();
  }
}
