// Shim → @insitue/agent-core (C0). Side-effect import: connects the
// stdio MCP server. Preserves dist/agent/claude-code/mcp-server.js so
// transport-mcp's relative URL resolution is unchanged.
import "@insitue/agent-core/mcp-server";
