/**
 * Real-browser test for the SDK capture pipeline.
 *
 * Boots the screenshot-stress static server, opens it in headless
 * chromium, and calls `buildBundle()` against every case on the
 * page. Exits non-zero if any case fails to produce a screenshot.
 *
 * This is the regression net for the rasterise pipeline — every
 * historical screenshot bug should leave behind a stress case here.
 */
import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..", "..", "..");
const SERVE = resolve(REPO, "examples", "screenshot-stress", "serve.mjs");
const PORT = Number(process.env.PORT ?? 4555);
const URL = `http://localhost:${PORT}`;

const cases = [
  { label: "case 1 — next/image fill", selector: ".case-next-image .target" },
  { label: "case 2 — same-origin <img>", selector: ".grid .case:nth-of-type(2) .target" },
  { label: "case 3 — cors-friendly", selector: ".grid .case:nth-of-type(3) .target" },
  { label: "case 4 — bg-image", selector: ".case-bg-image .target" },
  { label: "case 5 — video", selector: ".grid .case:nth-of-type(5) .target" },
  { label: "case 6 — canvas", selector: ".grid .case:nth-of-type(6) .target" },
  { label: "case 7 — motion", selector: ".case-motion .target" },
  { label: "case 8 — shadow DOM", selector: ".grid .case:nth-of-type(8) .target" },
  { label: "case 11 — transform", selector: ".case-transform .target" },
];

const server = spawn("node", [SERVE], {
  env: { ...process.env, PORT: String(PORT) },
  stdio: ["ignore", "pipe", "inherit"],
});

async function waitForServer() {
  for (let i = 0; i < 40; i++) {
    try {
      const r = await fetch(URL);
      if (r.ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`stress server did not respond on ${URL}`);
}

let exitCode = 0;
try {
  await waitForServer();

  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();

  const consoleLog = [];
  page.on("console", (m) => consoleLog.push(`[${m.type()}] ${m.text()}`));
  page.on("pageerror", (e) => consoleLog.push(`[pageerror] ${e.message}`));

  await page.goto(URL, { waitUntil: "networkidle" });
  await page.waitForFunction(
    () => !!document.getElementById("insitue-capture-root")?.shadowRoot,
    { timeout: 5000 },
  );

  // Expose `buildBundle` (a real export of capture-only) on the window.
  await page.addScriptTag({
    type: "module",
    content: `
      const mod = await import("/sdk/dist/capture-only.js");
      window.__buildBundle = mod.buildBundle;
      window.__buildBundleReady = true;
    `,
  });
  await page.waitForFunction(() => window.__buildBundleReady === true, { timeout: 5000 });

  async function run(label, selector) {
    return await page.evaluate(
      async ([sel, lbl]) => {
        const el = document.querySelector(sel);
        if (!el) return { label: lbl, error: `selector not found: ${sel}` };
        try {
          const bundle = await window.__buildBundle({ mode: "element", pointerPath: [el] });
          return {
            label: lbl,
            hasScreenshot: !!bundle.screenshot,
            source: bundle.screenshot?.source,
            qualityNote: bundle.screenshot?.qualityNote,
            dataUrlLen: bundle.screenshot?.dataUrl?.length,
            unavailable: bundle.screenshotUnavailable,
          };
        } catch (e) {
          return { label: lbl, error: e instanceof Error ? e.message : String(e) };
        }
      },
      [selector, label],
    );
  }

  const results = [];
  for (const c of cases) results.push(await run(c.label, c.selector));

  console.log(`=== Stress test: ${URL} (${cases.length} cases) ===`);
  let failed = 0;
  for (const r of results) {
    let status;
    if (r.error) {
      status = `FAIL  error: ${r.error.slice(0, 120)}`;
      failed++;
    } else if (r.hasScreenshot) {
      const note = r.qualityNote ? ` · ${r.qualityNote.slice(0, 60)}` : "";
      status = `PASS  ${r.dataUrlLen}b · ${r.source}${note}`;
    } else {
      status = `FAIL  unavailable: ${r.unavailable}`;
      failed++;
    }
    console.log(`  ${r.label.padEnd(34)} ${status}`);
  }

  if (failed > 0) {
    console.log(`\n${failed}/${cases.length} cases failed.`);
    const sdkMsgs = consoleLog.filter(
      (l) => l.includes("[insitue]") || l.includes("pageerror"),
    );
    if (sdkMsgs.length) {
      console.log("\nSDK console output:");
      for (const m of sdkMsgs.slice(0, 30)) console.log(`  ${m.slice(0, 220)}`);
    }
    exitCode = 1;
  } else {
    console.log(`\nAll ${cases.length} cases produced screenshots.`);
  }

  await browser.close();
} catch (e) {
  console.error(e instanceof Error ? e.stack : e);
  exitCode = 1;
} finally {
  server.kill("SIGTERM");
  process.exit(exitCode);
}
