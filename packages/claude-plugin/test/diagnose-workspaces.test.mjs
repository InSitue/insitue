/**
 * Regression net for #32 — diagnose must walk one level into common
 * monorepo workspace dirs (`apps/*`, `packages/*`) when looking for
 * `@insitue/sdk`, `@insitue/swc-source-attr`, and the SWC plugin
 * config. Before the fix, running diagnose from the monorepo root
 * with `CLAUDE_PROJECT_DIR` pointing there returned false-positive
 * "not installed" warnings on every dogfooder's machine.
 *
 * Each test builds a small synthetic monorepo on disk and asserts
 * the diagnose output. No mocks — exercises the real filesystem
 * resolution paths.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { diagnose } from "../dist/diagnose.js";

function makeMonorepo({ rootSdk, dashboardSdk, dashboardPluginConfigured }) {
  const root = mkdtempSync(join(tmpdir(), "insitue-diagnose-"));
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "root" }));
  writeFileSync(join(root, "pnpm-workspace.yaml"), 'packages:\n  - "apps/*"\n');

  if (rootSdk) {
    mkdirSync(join(root, "node_modules", "@insitue", "sdk"), { recursive: true });
    writeFileSync(
      join(root, "node_modules", "@insitue", "sdk", "package.json"),
      JSON.stringify({ name: "@insitue/sdk", version: rootSdk }),
    );
  }

  mkdirSync(join(root, "apps", "dashboard"), { recursive: true });
  writeFileSync(
    join(root, "apps", "dashboard", "package.json"),
    JSON.stringify({ name: "dashboard", dependencies: { "@insitue/sdk": "*" } }),
  );

  if (dashboardSdk) {
    mkdirSync(
      join(root, "apps", "dashboard", "node_modules", "@insitue", "sdk"),
      { recursive: true },
    );
    writeFileSync(
      join(
        root,
        "apps",
        "dashboard",
        "node_modules",
        "@insitue",
        "sdk",
        "package.json",
      ),
      JSON.stringify({ name: "@insitue/sdk", version: dashboardSdk }),
    );
  }

  // next.config in the workspace, not at root — the typical layout
  writeFileSync(
    join(root, "apps", "dashboard", "next.config.mjs"),
    dashboardPluginConfigured
      ? 'export default { experimental: { swcPlugins: [["@insitue/swc-source-attr", {}]] } };\n'
      : "export default {};\n",
  );

  return root;
}

test("finds SDK installed in apps/dashboard from monorepo root (#32)", async () => {
  const root = makeMonorepo({ dashboardSdk: "0.4.16" });
  const report = await diagnose({ dir: root, source: "CLAUDE_PROJECT_DIR" });
  assert.equal(report.sdkVersion, "0.4.16");
  assert.ok(
    !report.recommendations.some((r) => r.includes("not installed in the project")),
    `unexpected 'not installed' recommendation: ${JSON.stringify(report.recommendations)}`,
  );
});

test("prefers root-hoisted SDK when present", async () => {
  const root = makeMonorepo({ rootSdk: "0.4.15", dashboardSdk: "0.4.16" });
  const report = await diagnose({ dir: root, source: "CLAUDE_PROJECT_DIR" });
  // Root takes precedence — readPkgVersion checks the root first.
  assert.equal(report.sdkVersion, "0.4.15");
});

test("still reports null when SDK absent everywhere", async () => {
  const root = makeMonorepo({});
  const report = await diagnose({ dir: root, source: "CLAUDE_PROJECT_DIR" });
  assert.equal(report.sdkVersion, null);
  assert.ok(
    report.recommendations.some((r) => r.includes("not installed")),
    "expected 'not installed' recommendation when SDK absent",
  );
});

test("detects SWC plugin configured in apps/dashboard/next.config.mjs from monorepo root (#32)", async () => {
  const root = makeMonorepo({
    dashboardSdk: "0.4.16",
    dashboardPluginConfigured: true,
  });
  const report = await diagnose({ dir: root, source: "CLAUDE_PROJECT_DIR" });
  assert.equal(report.swcPluginConfigured, true);
});

test("reports swcPluginConfigured=false when config exists but doesn't wire plugin", async () => {
  const root = makeMonorepo({
    dashboardSdk: "0.4.16",
    dashboardPluginConfigured: false,
  });
  const report = await diagnose({ dir: root, source: "CLAUDE_PROJECT_DIR" });
  assert.equal(report.swcPluginConfigured, false);
});
