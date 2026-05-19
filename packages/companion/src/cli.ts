#!/usr/bin/env node
/**
 * `npx insitu` — starts the companion beside your dev server.
 */
import { resolve } from "node:path";
import { Command } from "commander";
import { startCompanion, COMPANION_VERSION } from "./server.js";

const program = new Command();

program
  .name("insitu")
  .description("InSitu companion — local visual agentic loop for your own codebase")
  .version(COMPANION_VERSION)
  .option("-p, --port <number>", "loopback port", "5747")
  .option(
    "-o, --origin <origin...>",
    "allowed dev-app origin(s)",
    ["http://localhost:3000", "http://127.0.0.1:3000"],
  )
  .option("-r, --root <path>", "project root to scope to", process.cwd())
  .action((opts: { port: string; origin: string[]; root: string }) => {
    const port = Number(opts.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      console.error(`[insitu] invalid port: ${opts.port}`);
      process.exit(1);
    }
    const root = resolve(opts.root);
    let server;
    try {
      server = startCompanion({ port, origins: opts.origin, root });
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
