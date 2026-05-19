#!/usr/bin/env node
/**
 * `npx insitue` — starts the companion beside your dev server.
 */
import { resolve } from "node:path";
import { Command } from "commander";
import { startCompanion, COMPANION_VERSION, type AgentTransport } from "./server.js";

const TRANSPORTS: AgentTransport[] = ["cli-headless", "mcp", "sdk"];

const program = new Command();

program
  .name("insitu")
  .description("InSitue companion — local visual agentic loop for your own codebase")
  .version(COMPANION_VERSION)
  .option("-p, --port <number>", "loopback port", "5747")
  .option(
    "-o, --origin <origin...>",
    "allowed dev-app origin(s)",
    ["http://localhost:3000", "http://127.0.0.1:3000"],
  )
  .option("-r, --root <path>", "project root to scope to", process.cwd())
  .option(
    "-t, --agent-transport <transport>",
    "cli-headless | mcp | sdk",
    "cli-headless",
  )
  .option(
    "--allow-api-key",
    "let ANTHROPIC_API_KEY reach the agent (bills the API, not your Max plan)",
    false,
  )
  .action(
    (opts: {
      port: string;
      origin: string[];
      root: string;
      agentTransport: string;
      allowApiKey: boolean;
    }) => {
      const port = Number(opts.port);
      if (!Number.isInteger(port) || port < 1 || port > 65535) {
        console.error(`[insitu] invalid port: ${opts.port}`);
        process.exit(1);
      }
      if (!TRANSPORTS.includes(opts.agentTransport as AgentTransport)) {
        console.error(
          `[insitu] invalid --agent-transport: ${opts.agentTransport} (cli-headless | mcp | sdk)`,
        );
        process.exit(1);
      }
      const transport = opts.agentTransport as AgentTransport;
      const root = resolve(opts.root);
      let server;
      try {
        server = startCompanion({
          port,
          origins: opts.origin,
          root,
          transport,
          allowApiKey: opts.allowApiKey,
        });
      } catch (err) {
      console.error((err as Error).message);
      process.exit(1);
    }
    server.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE") {
        console.error(
          `[insitu] port ${port} is already in use — another companion running? ` +
            `Stop it or pass \`--port <n>\`.`,
        );
      } else {
        console.error(`[insitu] server error: ${err.message}`);
      }
      process.exit(1);
    });
    console.log(
      `[insitu] companion ${COMPANION_VERSION} on 127.0.0.1:${port}\n` +
        `[insitu] scoped to ${root}\n` +
        `[insitu] origins: ${opts.origin.join(", ")}\n` +
        `[insitu] session token written to .insitu/session.json`,
    );
  });

program.parse();
