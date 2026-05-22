#!/usr/bin/env node
/**
 * `insitue` — setup + diagnostics CLI.
 *
 * Subcommands:
 *   setup [--desktop|--code|--both] [--project=PATH] [--name=NAME] [--dry-run]
 *       Wire the InSitue MCP into Claude Desktop (and/or print the
 *       Claude Code snippet). For Desktop we directly edit
 *       `claude_desktop_config.json` with an idempotent merge —
 *       always backing up the previous file.
 *   diagnose [--project=PATH]
 *       Run the same health check the MCP exposes as a tool, but
 *       from the terminal.
 *   help
 *       Print usage.
 *
 * Cross-platform paths:
 *   macOS:   ~/Library/Application Support/Claude/claude_desktop_config.json
 *   Windows: %APPDATA%\Claude\claude_desktop_config.json
 *   Linux:   ~/.config/Claude/claude_desktop_config.json
 *
 * Idempotency: setup writes a `mcpServers["insitue-<project>"]`
 * entry keyed by the project name (or `--name`). Re-running setup
 * for the same project updates that entry without touching other
 * MCP servers the user has configured.
 */
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { homedir, platform } from "node:os";
import { diagnose } from "./diagnose.js";
import { resolveProjectDir } from "./project-dir.js";

// ── Argv parsing ────────────────────────────────────────────────────

type Args = Map<string, string | true>;

function parseArgs(argv: string[]): { positional: string[]; flags: Args } {
  const positional: string[] = [];
  const flags: Args = new Map();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith("--")) {
      positional.push(a);
      continue;
    }
    const eq = a.indexOf("=");
    if (eq !== -1) {
      flags.set(a.slice(2, eq), a.slice(eq + 1));
    } else if (i + 1 < argv.length && !argv[i + 1]!.startsWith("--")) {
      flags.set(a.slice(2), argv[++i]!);
    } else {
      flags.set(a.slice(2), true);
    }
  }
  return { positional, flags };
}

// ── Desktop config path ─────────────────────────────────────────────

function desktopConfigPath(): string {
  const home = homedir();
  switch (platform()) {
    case "darwin":
      return join(
        home,
        "Library",
        "Application Support",
        "Claude",
        "claude_desktop_config.json",
      );
    case "win32":
      return join(
        process.env.APPDATA ?? join(home, "AppData", "Roaming"),
        "Claude",
        "claude_desktop_config.json",
      );
    default:
      // Claude Desktop on Linux is unofficial; XDG convention.
      return join(
        process.env.XDG_CONFIG_HOME ?? join(home, ".config"),
        "Claude",
        "claude_desktop_config.json",
      );
  }
}

// ── Desktop config writer ───────────────────────────────────────────

interface DesktopMcpEntry {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

interface DesktopConfig {
  mcpServers?: Record<string, DesktopMcpEntry>;
  [k: string]: unknown;
}

function makeEntryName(projectDir: string, explicit?: string): string {
  if (explicit) return explicit;
  const base = basename(projectDir).toLowerCase().replace(/[^a-z0-9-]+/g, "-");
  return `insitue-${base || "project"}`;
}

function buildEntry(projectDir: string): DesktopMcpEntry {
  return {
    command: "npx",
    args: ["-y", "@insitue/claude-plugin@latest"],
    env: {
      INSITUE_PROJECT_DIR: projectDir,
    },
  };
}

function readDesktopConfig(path: string): DesktopConfig {
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, "utf8")) as DesktopConfig;
  } catch (err) {
    throw new Error(
      `Couldn't parse existing config at ${path}: ${(err as Error).message}. ` +
        `Fix the JSON manually and re-run.`,
    );
  }
}

function writeDesktopConfig(path: string, cfg: DesktopConfig): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(cfg, null, 2) + "\n", "utf8");
}

function backupConfig(path: string): string | null {
  if (!existsSync(path)) return null;
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backup = `${path}.insitue-backup-${stamp}`;
  copyFileSync(path, backup);
  return backup;
}

// ── Subcommands ─────────────────────────────────────────────────────

async function cmdSetup(flags: Args): Promise<number> {
  const projectFlag = flags.get("project");
  const projectDir = resolve(
    typeof projectFlag === "string" ? projectFlag : process.cwd(),
  );
  if (!existsSync(projectDir)) {
    process.stderr.write(`error: project dir doesn't exist: ${projectDir}\n`);
    return 1;
  }

  const wantDesktop = flags.has("desktop") || flags.has("both");
  const wantCode = flags.has("code") || flags.has("both");
  const wantInteractive = !flags.has("desktop") && !flags.has("code") && !flags.has("both");

  const name =
    typeof flags.get("name") === "string"
      ? (flags.get("name") as string)
      : makeEntryName(projectDir);
  const entry = buildEntry(projectDir);
  const dryRun = flags.has("dry-run");

  if (wantInteractive) {
    process.stdout.write(
      "InSitue setup\n" +
        "─────────────\n" +
        `Project: ${projectDir}\n` +
        `Entry name: ${name}\n\n` +
        "Pass one of:\n" +
        "  --desktop       Wire into Claude Desktop\n" +
        "  --code          Print the Claude Code marketplace install hint\n" +
        "  --both          Both runtimes\n\n" +
        "Example:\n" +
        `  npx @insitue/claude-plugin setup --desktop --project=${projectDir}\n`,
    );
    return 0;
  }

  if (wantCode) {
    process.stdout.write(
      "\nClaude Code setup\n" +
        "─────────────────\n" +
        "Inside `claude`, run:\n\n" +
        "  /plugin marketplace add InSitue/insitue\n" +
        "  /plugin install insitue@insitue-plugins\n\n" +
        "Then `/insitue:connect` to start the loop. No further config\n" +
        "needed — claude provides ${CLAUDE_PROJECT_DIR} automatically.\n",
    );
  }

  if (wantDesktop) {
    const cfgPath = desktopConfigPath();
    process.stdout.write(
      "\nClaude Desktop setup\n" +
        "────────────────────\n" +
        `Config file: ${cfgPath}\n` +
        `Entry name:  ${name}\n` +
        `Project:     ${projectDir}\n`,
    );

    const cfg = readDesktopConfig(cfgPath);
    const current = cfg.mcpServers?.[name];
    const same =
      current &&
      JSON.stringify(current) === JSON.stringify(entry);

    if (same) {
      process.stdout.write(
        "✓ Already wired correctly — no changes needed.\n",
      );
    } else if (dryRun) {
      process.stdout.write(
        "\n[dry-run] Would write entry:\n" +
          `  "${name}": ${JSON.stringify(entry, null, 2).replace(/\n/g, "\n  ")}\n`,
      );
    } else {
      const backup = backupConfig(cfgPath);
      const next: DesktopConfig = { ...cfg };
      next.mcpServers = { ...(cfg.mcpServers ?? {}), [name]: entry };
      writeDesktopConfig(cfgPath, next);
      process.stdout.write(
        (backup
          ? `✓ Backed up existing config → ${backup}\n`
          : "✓ Created new config (no existing file).\n") +
          `✓ Wrote entry "${name}".\n\n` +
          "Restart Claude Desktop, then start a new chat and tell\n" +
          'claude: "Use the InSitue MCP — call `start_session` and\n' +
          'follow the instructions it returns."\n',
      );
    }
  }

  process.stdout.write("\n");
  return 0;
}

async function cmdDiagnose(flags: Args): Promise<number> {
  const projectFlag = flags.get("project");
  const argv =
    typeof projectFlag === "string"
      ? ["--project-dir", projectFlag]
      : [];
  const projectDir = resolveProjectDir(argv);
  const report = await diagnose(projectDir);

  const tick = (b: boolean) => (b ? "✓" : "✗");
  const lines: string[] = [
    "InSitue diagnostics",
    "───────────────────",
    `Project:    ${report.projectDir.dir} (via ${report.projectDir.source})`,
    `Session:    ${tick(report.hasSessionFile)} .insitue/session.json ${
      report.hasSessionFile ? "exists" : "missing"
    }`,
    `Companion:  ${tick(report.companionReachable)} ${
      report.companionReachable
        ? `reachable on port ${report.companionPort}`
        : "not reachable"
    }`,
    `@insitue/sdk:              ${report.sdkVersion ?? "(not installed)"}`,
    `@insitue/swc-source-attr:  ${report.swcPluginVersion ?? "(not installed)"}`,
    `SWC plugin configured:     ${
      report.swcPluginConfigured == null
        ? "(no next/vite config found)"
        : report.swcPluginConfigured
          ? "yes"
          : "no"
    }`,
  ];
  if (report.recommendations.length) {
    lines.push("", "Recommendations:");
    for (const r of report.recommendations) lines.push(`  · ${r}`);
  } else {
    lines.push("", "No recommendations — everything looks healthy.");
  }
  process.stdout.write(lines.join("\n") + "\n");
  return 0;
}

function cmdHelp(): number {
  process.stdout.write(
    "Usage: insitue <command> [flags]\n" +
      "\n" +
      "Commands:\n" +
      "  setup       Wire the InSitue MCP into Claude Desktop / Code\n" +
      "  diagnose    Health-check the local InSitue setup\n" +
      "  help        Show this message\n" +
      "\n" +
      "Flags (setup):\n" +
      "  --desktop                  Configure Claude Desktop\n" +
      "  --code                     Print the Claude Code install hint\n" +
      "  --both                     Configure both\n" +
      "  --project=PATH             Project directory (default: cwd)\n" +
      "  --name=NAME                Desktop MCP entry name (default: insitue-<dirname>)\n" +
      "  --dry-run                  Show what would change without writing\n" +
      "\n" +
      "Flags (diagnose):\n" +
      "  --project=PATH             Project directory (default: walk-up from cwd)\n",
  );
  return 0;
}

// ── Entry ───────────────────────────────────────────────────────────

const { positional, flags } = parseArgs(process.argv.slice(2));
const sub = positional[0] ?? "help";

try {
  let code: number;
  switch (sub) {
    case "setup":
      code = await cmdSetup(flags);
      break;
    case "diagnose":
      code = await cmdDiagnose(flags);
      break;
    case "help":
    case "--help":
    case "-h":
      code = cmdHelp();
      break;
    default:
      process.stderr.write(`unknown command: ${sub}\n`);
      cmdHelp();
      code = 2;
  }
  process.exit(code);
} catch (err) {
  process.stderr.write(`error: ${(err as Error).message}\n`);
  process.exit(1);
}
