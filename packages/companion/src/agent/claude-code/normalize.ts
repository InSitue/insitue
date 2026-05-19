/**
 * The transport-parity core. `cli-headless` (spawned `claude -p
 * --output-format stream-json`), `mcp` (spawned `claude` with an
 * InSitu MCP server attached — same stream-json envelope), and `sdk`
 * (`@anthropic-ai/claude-agent-sdk` `query()`) all surface the SAME
 * Claude Code message objects. Every transport funnels each native
 * message through THIS function, so the orchestrator/overlay see one
 * identical `AgentEvent` stream regardless of transport — that is what
 * the scripted parity test pins.
 */
import type { AgentEvent } from "@insitu/capture-core";

/** The subset of the Claude Code message envelope we depend on. */
export interface NativeMessage {
  type?: string;
  subtype?: string;
  is_error?: boolean;
  result?: string;
  message?: {
    content?: Array<{
      type?: string;
      text?: string;
      thinking?: string;
      name?: string;
      input?: Record<string, unknown>;
    }>;
  };
}

/** A concise human label for a tool_use block, e.g.
 *  `Read components/HubHero.tsx` / `Grep "Indie-designed"`. */
function toolLabel(name: string, input: Record<string, unknown>): string {
  const s = (v: unknown) =>
    typeof v === "string" ? v : v == null ? "" : String(v);
  const base = (p: string) => p.split("/").pop() || p;
  switch (name) {
    case "Read":
    case "Edit":
    case "Write":
    case "NotebookEdit":
      return `${name} ${base(s(input.file_path ?? input.path))}`;
    case "Grep":
      return `Grep "${s(input.pattern).slice(0, 40)}"`;
    case "Glob":
      return `Glob ${s(input.pattern).slice(0, 40)}`;
    case "Bash":
      return `Bash ${s(input.command).slice(0, 50)}`;
    default:
      return name || "tool";
  }
}

/** Map one native message to zero or more normalized AgentEvents.
 *  Pure + total: unknown shapes yield `[]` (tolerant by design). */
export function normalizeNative(
  msg: NativeMessage,
  turnId: string,
): AgentEvent[] {
  const out: AgentEvent[] = [];

  if (msg.type === "assistant" && msg.message?.content) {
    for (const block of msg.message.content) {
      if (block.type === "text" && block.text) {
        out.push({ t: "agent-text", turnId, delta: block.text });
      } else if (block.type === "thinking" && block.thinking) {
        out.push({ t: "agent-thinking", turnId, note: block.thinking });
        out.push({
          t: "agent-activity",
          turnId,
          kind: "thinking",
          label: "thinking",
        });
      } else if (block.type === "tool_use" && block.name) {
        out.push({
          t: "agent-activity",
          turnId,
          kind: "tool",
          label: toolLabel(block.name, block.input ?? {}),
        });
      }
    }
    return out;
  }

  if (msg.type === "result") {
    if (msg.is_error) {
      out.push({
        t: "agent-error",
        turnId,
        code: "transport",
        message: msg.result || msg.subtype || "claude reported an error",
      });
    } else {
      out.push({ t: "agent-turn-complete", turnId });
    }
  }
  return out;
}
