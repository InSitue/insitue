#!/usr/bin/env node
/**
 * Single binary that dispatches to either the MCP server (default,
 * stdio-based, what Claude Code/Desktop spawn) or the setup CLI
 * (`setup`/`diagnose`/`help` subcommands) based on argv.
 *
 * Why: the package needs ONE bin so that `npx @insitue/claude-plugin
 * <subcommand>` resolves unambiguously. Multiple bins force the user
 * to remember an awkward `npx -p` invocation.
 *
 * Routing:
 *   npx @insitue/claude-plugin               → MCP server (stdio)
 *   npx @insitue/claude-plugin setup …       → setup CLI
 *   npx @insitue/claude-plugin diagnose …    → setup CLI
 *   npx @insitue/claude-plugin help|--help   → setup CLI
 *
 * Dynamic imports keep startup cost minimal — the unused side has
 * its top-level work skipped entirely.
 */

const SUBCOMMANDS = new Set(["setup", "diagnose", "help", "--help", "-h"]);

const first = process.argv[2];
if (first && SUBCOMMANDS.has(first)) {
  await import("./setup-cli.js");
} else {
  await import("./mcp-server.js");
}
