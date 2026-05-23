#!/usr/bin/env node
/**
 * `insitue` CLI.
 *
 *   insitue dev      — start the companion alongside your dev server
 *                      (the bin is `insitue`, the package on npm is
 *                      `@insitue/companion`; `npx @insitue/companion`
 *                      with no args still defaults to `dev`)
 *   insitue connect  — attach this terminal to a running companion;
 *                      every browser pick streams to stdout. Pipeable
 *                      into Claude / Aider / any AI tool. (#147 M1)
 */
import { resolve } from "node:path";
import { Command } from "commander";
import { startCompanion, COMPANION_VERSION, type AgentTransport } from "./server.js";
import { runConnect } from "./cli-connect.js";

const TRANSPORTS: AgentTransport[] = ["cli-headless", "mcp", "sdk"];

const program = new Command();

program
  .name("insitue")
  .description(
    "InSitue — local visual agentic loop for your codebase. " +
      "Free, MIT, never requires an account or API key.",
  )
  .version(COMPANION_VERSION);

// ── dev (default) ─────────────────────────────────────────────────
function devOptions(cmd: Command): Command {
  return cmd
    .option("-p, --port <number>", "loopback port", "5747")
    .option(
      "-o, --origin <origin...>",
      "additional allowed dev-app origin(s) on top of localhost wildcard",
      [],
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
    .option(
      "--strict-origins",
      "require an explicit --origin allowlist (disables localhost wildcard). " +
        "Off by default for `dev` so users don't have to know their dev port. " +
        "The loopback bind + per-session token remain the auth boundary regardless.",
      false,
    );
}

interface DevOpts {
  port: string;
  origin: string[];
  root: string;
  agentTransport: string;
  allowApiKey: boolean;
  strictOrigins: boolean;
}

function startDev(opts: DevOpts): void {
  const port = Number(opts.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    console.error(`[insitue] invalid port: ${opts.port}`);
    process.exit(1);
  }
  if (!TRANSPORTS.includes(opts.agentTransport as AgentTransport)) {
    console.error(
      `[insitue] invalid --agent-transport: ${opts.agentTransport} (cli-headless | mcp | sdk)`,
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
      allowLocalhost: !opts.strictOrigins,
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
        `[insitue] port ${port} is already in use — another companion running? ` +
          `Stop it or pass \`--port <n>\`.`,
      );
    } else {
      console.error(`[insitue] server error: ${err.message}`);
    }
    process.exit(1);
  });
  const originsLabel = opts.strictOrigins
    ? opts.origin.length
      ? opts.origin.join(", ")
      : "(none — strict mode + empty list = nothing allowed)"
    : opts.origin.length
      ? `localhost:* + ${opts.origin.join(", ")}`
      : "localhost:* (any port on http://localhost or http://127.0.0.1)";
  console.log(
    `[insitue] companion ${COMPANION_VERSION} on 127.0.0.1:${port}\n` +
      `[insitue] scoped to ${root}\n` +
      `[insitue] origins: ${originsLabel}\n` +
      `[insitue] session token written to .insitue/session.json\n` +
      `[insitue] tip: \`insitue connect\` in another terminal to pipe picks to your AI tool`,
  );
}

devOptions(program.command("dev").description("start the companion"))
  .action(startDev);

// Backwards-compat: `npx @insitue/companion` (no subcommand) still
// starts dev mode. commander runs the program-level action when no
// subcommand is specified and the program itself has an action.
devOptions(program).action(startDev);

// ── connect ──────────────────────────────────────────────────────
program
  .command("connect")
  .description(
    "stream selections from a running companion to stdout " +
      "(pipe into claude / aider / your AI tool of choice)",
  )
  .option("--json", "emit NDJSON instead of pretty text", false)
  .action(async (opts: { json: boolean }) => {
    await runConnect({ json: !!opts.json });
  });

program.parse();
