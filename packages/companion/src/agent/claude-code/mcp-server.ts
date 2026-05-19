/**
 * InSitu MCP server (stdio) — the `mcp` transport. The companion spawns
 * `claude` with this registered via `--mcp-config`; the model pulls the
 * grounded selection context by calling the `insitu_context` tool
 * instead of having it inlined in the prompt. This is a standalone
 * entry (`node dist/agent/claude-code/mcp-server.js`); it imports only
 * the MIT MCP SDK + node fs — never ws/the companion server.
 *
 * The context is handed over out-of-band via `INSITU_CONTEXT_FILE`
 * (a temp file the companion writes per turn) so it never rides argv.
 */
import { readFileSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

const server = new McpServer({ name: "insitu", version: "0.0.0" });

server.registerTool(
  "insitu_context",
  {
    description:
      "The developer's in-situ selection: the resolved source span, " +
      "component stack, styles, runtime context, and their request. " +
      "Call this FIRST, then answer or propose edits per its protocol.",
    inputSchema: {},
  },
  async () => {
    const file = process.env.INSITU_CONTEXT_FILE;
    let text = "(no InSitu context available)";
    try {
      if (file) text = readFileSync(file, "utf8");
    } catch {
      /* fall through to the placeholder */
    }
    return { content: [{ type: "text" as const, text }] };
  },
);

await server.connect(new StdioServerTransport());
