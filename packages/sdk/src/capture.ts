/**
 * Assembles a `CaptureBundle` from a picker selection using the pure
 * capture-core resolvers + an html-to-image screenshot crop + the
 * runtime ring buffers. This is the SDK's `CaptureCore.buildBundle`.
 */
import { toCanvas } from "html-to-image";
import {
  CAPTURE_SCHEMA_VERSION,
  breakpointFor,
  buildSelector,
  curateComputedStyles,
  extractTailwindClasses,
  resolveTarget,
  serializeNode,
  type CaptureBundle,
  type SelectionInput,
} from "@insitue/capture-core";
import { runtimeSnapshot } from "./runtime.js";

/** Is `url` a cross-origin resource that would taint a canvas?
 *  data:/blob: and same-origin are safe; anything else is a risk. */
function crossOrigin(url: string | null | undefined): boolean {
  if (!url || url.startsWith("data:") || url.startsWith("blob:")) {
    return false;
  }
  try {
    return new URL(url, location.href).origin !== location.origin;
  } catch {
    return false;
  }
}

/** `html-to-image` rasterises via canvas; a cross-origin <img>/<video>/
 *  CSS background with no working CORS taints it and `toPng` returns a
 *  blank-but-valid data URL (it does NOT throw). Detect the offender up
 *  front so we can be honest instead of showing an empty box. Returns a
 *  short human reason, or null if a screenshot should be safe. */
function crossOriginMediaReason(root: Element): string | null {
  const els = [root, ...root.querySelectorAll("*")];
  for (const el of els) {
    if (el instanceof HTMLImageElement) {
      if (
        crossOrigin(el.currentSrc || el.src) &&
        el.crossOrigin == null
      ) {
        const host = (() => {
          try {
            return new URL(el.currentSrc || el.src).host;
          } catch {
            return "cross-origin";
          }
        })();
        return `cross-origin <img> (${host})`;
      }
    }
    const bg = getComputedStyle(el).backgroundImage;
    const m = bg && bg !== "none" ? /url\(["']?([^"')]+)["']?\)/.exec(bg) : null;
    if (m && crossOrigin(m[1])) return "cross-origin CSS background image";
    if (
      (el instanceof HTMLVideoElement || el instanceof HTMLCanvasElement) &&
      crossOrigin((el as HTMLVideoElement).src)
    ) {
      return `cross-origin <${el.tagName.toLowerCase()}>`;
    }
  }
  return null;
}

/** Walk up from the picked element to find a meaningfully-sized
 *  ancestor to screenshot — so the thumbnail has enough visual
 *  context for a human reviewer to recognise the bug. Heuristic:
 *  the first ancestor at least 420×140 pixels, but stop short of
 *  anything larger than ~1.2× the viewport (otherwise we'd
 *  screenshot the whole page). Bounded by depth so we never run
 *  away. */
function findContextAncestor(el: HTMLElement): HTMLElement {
  const minW = 420;
  const minH = 140;
  const maxW = window.innerWidth * 1.2;
  const maxH = window.innerHeight * 1.2;
  let cur: HTMLElement = el;
  for (let depth = 0; depth < 8; depth++) {
    const r = cur.getBoundingClientRect();
    // Big enough already — stop here.
    if (r.width >= minW && r.height >= minH) return cur;
    // About to overshoot — stop one level back. (`cur` itself is
    // returned so the screenshot is still as large as we can get
    // without blowing the viewport.)
    const parent = cur.parentElement;
    if (!parent) return cur;
    const pr = parent.getBoundingClientRect();
    if (pr.width > maxW || pr.height > maxH) return cur;
    cur = parent;
  }
  return cur;
}

/** Rasterise the FULL document and crop to `cropRect` (viewport
 *  coords, CSS pixels). Rendering the whole document — not just
 *  the targeted subtree — is the only honest way to capture
 *  html/body backgrounds, parent backdrop decorations, fixed/
 *  sticky chrome, and sibling overlays that compose what the
 *  user actually sees. Falls back gracefully on cross-origin
 *  media by filtering it out (a blank rect inside the picked
 *  region is better than refusing the whole capture). */
async function renderViewportCrop(
  cropRect: DOMRect,
  pixelRatio: number,
): Promise<string | null> {
  const bodyBg = getComputedStyle(document.body).backgroundColor;
  const htmlBg = getComputedStyle(document.documentElement).backgroundColor;
  // Pick whichever root has a non-transparent paint; html-to-image
  // composites against this, so it has to match the visual.
  const backgroundColor =
    bodyBg && bodyBg !== "rgba(0, 0, 0, 0)" && bodyBg !== "transparent"
      ? bodyBg
      : htmlBg && htmlBg !== "rgba(0, 0, 0, 0)" && htmlBg !== "transparent"
        ? htmlBg
        : "#ffffff";

  const fullCanvas = await toCanvas(document.documentElement, {
    pixelRatio,
    cacheBust: true,
    backgroundColor,
    filter: (n) => {
      if (
        n instanceof Element &&
        n.closest?.("#insitu-root, [data-insitu-layer]")
      ) {
        return false;
      }
      // Drop cross-origin images that would taint the canvas. We'd
      // rather render a hole than fail the whole capture — the
      // surrounding context still helps the reviewer.
      if (n instanceof HTMLImageElement) {
        if (crossOrigin(n.currentSrc || n.src) && n.crossOrigin == null) {
          return false;
        }
      }
      return true;
    },
  });

  // cropRect is viewport-relative; the full-document render is
  // document-relative — shift by scroll offset to line them up.
  const sx = window.scrollX;
  const sy = window.scrollY;
  const out = document.createElement("canvas");
  out.width = Math.max(1, Math.round(cropRect.width * pixelRatio));
  out.height = Math.max(1, Math.round(cropRect.height * pixelRatio));
  const ctx = out.getContext("2d");
  if (!ctx) return null;
  ctx.drawImage(
    fullCanvas,
    Math.round((cropRect.x + sx) * pixelRatio),
    Math.round((cropRect.y + sy) * pixelRatio),
    Math.round(cropRect.width * pixelRatio),
    Math.round(cropRect.height * pixelRatio),
    0,
    0,
    out.width,
    out.height,
  );
  return out.toDataURL("image/png");
}

function elementFor(sel: SelectionInput): Element | null {
  if (sel.mode === "element") return sel.pointerPath?.[0] ?? null;
  if (sel.rect) {
    const cx = sel.rect.x + sel.rect.width / 2;
    const cy = sel.rect.y + sel.rect.height / 2;
    return document.elementFromPoint(cx, cy);
  }
  return null;
}

export async function buildBundle(
  sel: SelectionInput,
): Promise<CaptureBundle> {
  const el = elementFor(sel);
  const rt = runtimeSnapshot();
  const dpr = window.devicePixelRatio || 1;

  let screenshot: CaptureBundle["screenshot"];
  let screenshotUnavailable: string | undefined;
  if (el instanceof HTMLElement) {
    // Walk up to a usefully-sized ancestor so the screenshot has
    // enough visual context for a reviewer to recognise the bug
    // (single letters or tiny icons in isolation are useless).
    const context = findContextAncestor(el);
    // Clamp to the visible viewport — a context that extends off-
    // screen would otherwise produce a crop that's mostly blank.
    const cr = context.getBoundingClientRect();
    const cropRect = new DOMRect(
      Math.max(0, cr.x),
      Math.max(0, cr.y),
      Math.min(window.innerWidth, cr.right) - Math.max(0, cr.x),
      Math.min(window.innerHeight, cr.bottom) - Math.max(0, cr.y),
    );
    // Highlight the picked element so the reviewer can see exactly
    // what was selected within the surrounding context. Inline
    // outline wins against most stylesheets without !important.
    const orig = {
      outline: el.style.outline,
      outlineOffset: el.style.outlineOffset,
    };
    el.style.outline = "3px solid #ff6b00";
    el.style.outlineOffset = "2px";
    try {
      const dataUrl = await renderViewportCrop(
        cropRect,
        // Cap pixel ratio for full-document rasterise — 2× of a
        // long page is enough to blow per-tab canvas memory caps
        // on some browsers (and 1.5× still looks crisp).
        Math.min(dpr, 1.5),
      );
      if (!dataUrl || dataUrl.length < 1024) {
        // Either the page has cross-origin media we had to filter
        // out and the crop region was nothing but that, or the
        // browser refused the size. Flag honestly.
        const taint = crossOriginMediaReason(el);
        screenshotUnavailable = taint
          ? `${taint} — can't rasterise in-browser`
          : "rasterise produced an empty image";
      } else {
        screenshot = {
          mime: "image/png",
          dataUrl,
          // Bounds describe the SCREENSHOT (the crop region) so
          // the dashboard knows what slice of viewport this is.
          bounds: {
            x: cropRect.x,
            y: cropRect.y,
            width: cropRect.width,
            height: cropRect.height,
          },
        };
      }
    } catch {
      screenshotUnavailable = "rasterise failed";
    } finally {
      // Restore — even if rasterise threw.
      el.style.outline = orig.outline;
      el.style.outlineOffset = orig.outlineOffset;
    }
  }

  return {
    schemaVersion: CAPTURE_SCHEMA_VERSION,
    id:
      typeof crypto !== "undefined" && "randomUUID" in crypto
        ? crypto.randomUUID()
        : `cap_${Date.now()}_${Math.random().toString(36).slice(2)}`,
    createdAt: new Date().toISOString(),
    target: el ? resolveTarget(el) : null,
    domSubtree: el
      ? serializeNode(el)
      : { tag: "unknown", attrs: {}, children: [] },
    computedStyles: el ? curateComputedStyles(el) : {},
    tailwindClasses: el ? extractTailwindClasses(el) : [],
    ...(screenshot ? { screenshot } : {}),
    ...(screenshotUnavailable ? { screenshotUnavailable } : {}),
    viewport: {
      w: window.innerWidth,
      h: window.innerHeight,
      dpr,
      breakpoint: breakpointFor(window.innerWidth),
    },
    runtime: {
      url: location.href,
      route: location.pathname,
      console: rt.console,
      network: rt.network,
      errors: rt.errors,
    },
  };
}

export { buildSelector };
