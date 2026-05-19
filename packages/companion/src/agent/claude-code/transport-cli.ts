/**
 * `cli-headless` transport: one `claude -p ... --output-format
 * stream-json --verbose` child per turn (one-shot; multi-turn
 * persistence is deferred to M3). Parses the newline-delimited JSON
 * tolerantly and normalizes it to the pure `AgentEvent` union — the
 * orchestrator/overlay never see Claude Code's native shapes.
 *
 * P2 = read-only (allowedTools = Read/Grep/Glob, no Edit/Write/Bash):
 * the agent explains/proposes in text; edit interception is P3.
 */
import { createInterface } from "node:readline";
import { execa } from "execa";
import type { AgentEvent } from "@insitu/capture-core";
import type { AgentSession, AgentSessionInput } from "../provider.js";
import { buildPrompt } from "../context.js";
import { normalizeNative, type NativeMessage } from "./normalize.js";

export interface CliSessionOpts {
  root: string;
  env: NodeJS.ProcessEnv;
}

/** Only what cancel() needs — sidesteps execa's options-parameterized
 *  ResultPromise generic (invariant, awkward to store as a field). */
interface Killable {
  kill: (signal?: NodeJS.Signals | number) => boolean;
}

export class ClaudeCliSession implements AgentSession {
  readonly sessionId = `cli_${Date.now().toString(36)}`;
  private child: Killable | null = null;

  constructor(private readonly opts: CliSessionOpts) {}

  async sendTurn(
    input: AgentSessionInput,
    onEvent: (e: AgentEvent) => void,
  ): Promise<void> {
    const turnId = input.bundle.id;
    const prompt = buildPrompt(input);
    const child = execa(
      "claude",
      [
        "-p",
        prompt,
        "--output-format",
        "stream-json",
        "--verbose",
        "--allowedTools",
        "Read,Grep,Glob",
      ],
      { cwd: this.opts.root, env: this.opts.env, reject: false },
    );
    this.child = child;

    let sawResult = false;
    if (child.stdout) {
      const rl = createInterface({ input: child.stdout });
      for await (const line of rl) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        let msg: NativeMessage;
        try {
          msg = JSON.parse(trimmed) as NativeMessage;
        } catch {
          continue; // tolerant: skip diagnostic / partial noise
        }
        for (const ev of normalizeNative(msg, turnId)) {
          if (ev.t === "agent-turn-complete" || ev.t === "agent-error") {
            sawResult = true;
          }
          onEvent(ev);
        }
      }
    }

    const res = await child;
    this.child = null;
    if (!sawResult) {
      if (res.exitCode === 0) {
        onEvent({ t: "agent-turn-complete", turnId });
      } else {
        onEvent({
          t: "agent-error",
          turnId,
          code: "transport",
          message:
            (typeof res.stderr === "string" && res.stderr.trim()) ||
            `claude exited ${res.exitCode}`,
        });
      }
    }
  }

  cancel(): void {
    this.child?.kill("SIGTERM");
    this.child = null;
  }

  dispose(): void {
    this.cancel();
  }
}
