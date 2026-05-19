/**
 * `mcp` transport: spawn `claude` with the InSitu MCP server attached
 * (via a generated `--mcp-config`) instead of inlining the selection.
 * The model calls the `insitu_context` tool to pull grounded context.
 * It still emits the stream-json envelope, so it funnels through the
 * SAME `normalizeNative` as cli-headless/sdk → transport parity.
 *
 * Context is passed to the MCP server out-of-band via a temp file
 * (`INSITU_CONTEXT_FILE`) so it never rides argv or env content.
 */
import { createInterface } from "node:readline";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { execa } from "execa";
import type { AgentEvent } from "@insitu/capture-core";
import type { AgentSession, AgentSessionInput } from "../provider.js";
import { buildPrompt } from "../context.js";
import { normalizeNative, type NativeMessage } from "./normalize.js";

interface Killable {
  kill: (signal?: NodeJS.Signals | number) => boolean;
}

export interface McpSessionOpts {
  root: string;
  env: NodeJS.ProcessEnv;
}

const SERVER_ENTRY = fileURLToPath(
  new URL("./agent/claude-code/mcp-server.js", import.meta.url),
);

export class ClaudeMcpSession implements AgentSession {
  readonly sessionId = `mcp_${Date.now().toString(36)}`;
  private child: Killable | null = null;

  constructor(private readonly opts: McpSessionOpts) {}

  async sendTurn(
    input: AgentSessionInput,
    onEvent: (e: AgentEvent) => void,
  ): Promise<void> {
    const turnId = input.bundle.id;
    const dir = mkdtempSync(join(tmpdir(), "insitu-mcp-"));
    const ctxFile = join(dir, "context.txt");
    const cfgFile = join(dir, "mcp.json");
    writeFileSync(ctxFile, buildPrompt(input), "utf8");
    writeFileSync(
      cfgFile,
      JSON.stringify({
        mcpServers: {
          insitu: {
            command: process.execPath,
            args: [SERVER_ENTRY],
            env: { INSITU_CONTEXT_FILE: ctxFile },
          },
        },
      }),
      "utf8",
    );

    let sawResult = false;
    try {
      const child = execa(
        "claude",
        [
          "-p",
          "Call the `insitu_context` tool, then follow its instructions exactly.",
          "--output-format",
          "stream-json",
          "--verbose",
          "--mcp-config",
          cfgFile,
          "--strict-mcp-config",
          "--allowedTools",
          "Read,Grep,Glob,mcp__insitu__insitu_context",
        ],
        { cwd: this.opts.root, env: this.opts.env, reject: false },
      );
      this.child = child;

      if (child.stdout) {
        const rl = createInterface({ input: child.stdout });
        for await (const line of rl) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          let msg: NativeMessage;
          try {
            msg = JSON.parse(trimmed) as NativeMessage;
          } catch {
            continue;
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
        onEvent(
          res.exitCode === 0
            ? { t: "agent-turn-complete", turnId }
            : {
                t: "agent-error",
                turnId,
                code: "transport",
                message:
                  (typeof res.stderr === "string" && res.stderr.trim()) ||
                  `claude exited ${res.exitCode}`,
              },
        );
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
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
