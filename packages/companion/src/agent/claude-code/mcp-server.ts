// Shim → @insitu/agent-core (C0). Side-effect import: connects the
// stdio MCP server. Preserves dist/agent/claude-code/mcp-server.js so
// transport-mcp's relative URL resolution is unchanged.
import "@insitu/agent-core/mcp-server";
