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

/** Rasteriser selection.
 *
 *  `--rasteriser=html-to-image` (default) — current production lib.
 *  `--rasteriser=modern-screenshot`       — spike candidate.
 *  `--rasteriser=both`                    — A/B harness, runs each
 *                                           case twice and prints a
 *                                           comparison table.
 *
 *  CI gating uses the default; comparisons are for spike PRs. */
const rasteriserArg =
  process.argv.find((a) => a.startsWith("--rasteriser="))?.split("=")[1] ??
  "html-to-image";
const rasterisers =
  rasteriserArg === "both"
    ? ["html-to-image", "modern-screenshot"]
    : [rasteriserArg];

/** Each case is a discrete capture probe.
 *
 *  `prep` runs in the page context BEFORE the pick happens, so it
 *  can scroll the page / inner-scroll a container / trigger a
 *  layout shift. `assertFraming` (default true for new framing
 *  cases) requires the picked element to be visible inside the
 *  bundle's `screenshot.bounds`. */
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
  {
    label: "case 12 — fixed target after scroll",
    selector: ".case-fixed-target .target",
    prep: "window.__stressPrep_fixedTarget && window.__stressPrep_fixedTarget()",
    assertFraming: true,
  },
  {
    label: "case 13 — sticky stuck",
    selector: ".case-sticky-stuck .target",
    prep: "window.__stressPrep_stickyStuck && window.__stressPrep_stickyStuck()",
    assertFraming: true,
  },
  {
    label: "case 14 — transformed ancestor",
    selector: ".case-transformed-ancestor .target",
    assertFraming: true,
  },
  {
    label: "case 15 — inner-scroll container",
    selector: ".case-inner-scroll .target",
    prep: "window.__stressPrep_innerScroll && window.__stressPrep_innerScroll()",
    assertFraming: true,
  },
  {
    label: "case 16 — layout shift mid-capture",
    selector: ".case-layout-shift .target",
    prep: "window.__stressPrep_layoutShift && window.__stressPrep_layoutShift()",
    assertFraming: true,
  },
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

  async function run(label, selector, prep, assertFraming, rasteriser) {
    return await page.evaluate(
      async ([sel, lbl, prepCode, framingFlag, ras]) => {
        // Flip the runtime rasteriser selector. Read by
        // currentRasteriser() inside capture.ts on every buildBundle.
        window.__INSITUE_RASTERISER__ = ras;
        // Reset page state between cases so prep (scroll, inner-scroll,
        // layout-shift) doesn't leak.
        try {
          window.__stressPrep_reset && window.__stressPrep_reset();
          // Give a frame for the reset to take effect.
          await new Promise((r) => requestAnimationFrame(() => r()));
        } catch {}
        const el = document.querySelector(sel);
        if (!el) return { label: lbl, error: `selector not found: ${sel}` };
        // Bring the target into the viewport before any prep runs —
        // real users only pick elements they can see. Cases with
        // explicit scroll preps (12, 13) override this immediately
        // after with their own scroll positioning.
        try {
          el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
          await new Promise((r) => requestAnimationFrame(() => r()));
        } catch {}
        if (prepCode) {
          try {
            // eslint-disable-next-line no-eval
            (0, eval)(prepCode);
            await new Promise((r) => requestAnimationFrame(() => r()));
          } catch (e) {
            return { label: lbl, error: `prep failed: ${e?.message ?? e}` };
          }
        }
        const rectAtPick = el.getBoundingClientRect();
        try {
          const bundle = await window.__buildBundle({
            mode: "element",
            pointerPath: [el],
          });
          // Framing assertion — picked element must overlap the
          // shipped screenshot bounds by ≥ half its size on each axis.
          let framingOk = null;
          let framingDebug = null;
          if (framingFlag && bundle.screenshot?.bounds) {
            const b = bundle.screenshot.bounds;
            const finalRect =
              bundle.captureDiagnostics?.pickedBboxAtComposite ?? rectAtPick;
            const ox = Math.max(
              0,
              Math.min(b.x + b.width, finalRect.x + finalRect.width)
                - Math.max(b.x, finalRect.x),
            );
            const oy = Math.max(
              0,
              Math.min(b.y + b.height, finalRect.y + finalRect.height)
                - Math.max(b.y, finalRect.y),
            );
            framingOk =
              ox >= finalRect.width / 2 && oy >= finalRect.height / 2;
            if (!framingOk) {
              framingDebug = {
                bounds: { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height) },
                bbox: {
                  x: Math.round(finalRect.x),
                  y: Math.round(finalRect.y),
                  w: Math.round(finalRect.width),
                  h: Math.round(finalRect.height),
                },
                overlap: { x: Math.round(ox), y: Math.round(oy) },
                drift: bundle.captureDiagnostics?.pickedBboxDriftPx,
              };
            }
          }
          const renderMs = Math.round(
            bundle.captureDiagnostics?.attemptedLayers?.[0]?.durationMs ?? 0,
          );
          return {
            label: lbl,
            rasteriser: ras,
            hasScreenshot: !!bundle.screenshot,
            source: bundle.screenshot?.source,
            qualityNote: bundle.screenshot?.qualityNote,
            dataUrlLen: bundle.screenshot?.dataUrl?.length,
            unavailable: bundle.screenshotUnavailable,
            framingOk,
            framingDebug,
            pickedPosition: bundle.captureDiagnostics?.pickedPosition,
            pickedBboxDrift: bundle.captureDiagnostics?.pickedBboxDriftPx,
            shippedLooksBlank: !!bundle.captureDiagnostics?.shippedLooksBlank,
            failedImages:
              bundle.captureDiagnostics?.layer1FailedImages ?? 0,
            renderMs,
          };
        } catch (e) {
          return {
            label: lbl,
            rasteriser: ras,
            error: e instanceof Error ? e.message : String(e),
          };
        }
      },
      [selector, label, prep ?? null, !!assertFraming, rasteriser],
    );
  }

  const allResults = [];
  for (const ras of rasterisers) {
    for (const c of cases) {
      allResults.push(
        await run(c.label, c.selector, c.prep, c.assertFraming, ras),
      );
    }
  }
  const results = allResults;

  console.log(
    `=== Stress test: ${URL} (${cases.length} cases × ${rasterisers.length} rasteriser${rasterisers.length === 1 ? "" : "s"}) ===`,
  );
  let failed = 0;
  if (rasterisers.length > 1) {
    // A/B comparison table. One row per (case, rasteriser).
    console.log(
      `\n${"case".padEnd(38)} ${"rasteriser".padEnd(18)} ${"ms".padStart(5)}  ${"size".padStart(7)}  blank  framing  fail-img  notes`,
    );
    console.log("-".repeat(120));
    for (const r of results) {
      const ms = r.renderMs != null ? String(r.renderMs) : "—";
      const size = r.dataUrlLen != null ? String(r.dataUrlLen) : "—";
      const blank = r.shippedLooksBlank ? "Y" : ".";
      const framing =
        r.framingOk === true ? "ok" : r.framingOk === false ? "BAD" : "—";
      const fimg = r.failedImages != null ? String(r.failedImages) : "—";
      const notes =
        r.error ?? r.unavailable ?? (r.qualityNote ? r.qualityNote.slice(0, 60) : "");
      console.log(
        `${r.label.padEnd(38)} ${r.rasteriser.padEnd(18)} ${ms.padStart(5)}  ${size.padStart(7)}    ${blank}    ${framing.padEnd(4)}    ${fimg.padStart(2)}    ${notes}`,
      );
      const isFailure =
        !!r.error ||
        !r.hasScreenshot ||
        r.framingOk === false;
      if (isFailure) failed++;
    }
  } else {
    for (const r of results) {
      let status;
      if (r.error) {
        status = `FAIL  error: ${r.error.slice(0, 120)}`;
        failed++;
      } else if (!r.hasScreenshot) {
        status = `FAIL  unavailable: ${r.unavailable}`;
        failed++;
      } else if (r.framingOk === false) {
        const d = r.framingDebug;
        status = d
          ? `FAIL  framing  bounds=${d.bounds.x},${d.bounds.y} ${d.bounds.w}x${d.bounds.h}` +
            `  bbox=${d.bbox.x},${d.bbox.y} ${d.bbox.w}x${d.bbox.h}` +
            `  overlap=(${d.overlap.x},${d.overlap.y})  drift=${d.drift ?? "—"}`
          : `FAIL  framing: picked bbox outside screenshot bounds`;
        failed++;
      } else {
        const note = r.qualityNote ? ` · ${r.qualityNote.slice(0, 50)}` : "";
        const frameTag = r.framingOk === true ? " · framing-ok" : "";
        const posTag = r.pickedPosition ? ` · pos=${r.pickedPosition}` : "";
        status = `PASS  ${r.dataUrlLen}b · ${r.source}${frameTag}${posTag}${note}`;
      }
      console.log(`  ${r.label.padEnd(38)} ${status}`);
    }
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
