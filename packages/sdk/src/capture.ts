/**
 * Assembles a `CaptureBundle` from a picker selection using the pure
 * capture-core resolvers + an html-to-image screenshot crop + the
 * runtime ring buffers. This is the SDK's `CaptureCore.buildBundle`.
 */
import { toPng } from "html-to-image";
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
    const taint = crossOriginMediaReason(el);
    if (taint) {
      // Don't even attempt — toPng would silently return a blank PNG.
      screenshotUnavailable = `${taint} — can't rasterise in-browser`;
    } else {
      try {
        const r = el.getBoundingClientRect();
        const dataUrl = await toPng(el, {
          pixelRatio: Math.min(dpr, 2),
          cacheBust: true,
          // Don't try to screenshot our own overlay if it overlaps.
          filter: (n) =>
            !(n instanceof Element &&
              n.closest?.("#insitu-root, [data-insitu-layer]")),
        });
        // A degenerate result (toPng didn't throw but produced nothing
        // usable) is just as dishonest as a blank box.
        if (!dataUrl || dataUrl.length < 256) {
          screenshotUnavailable = "rasterise produced an empty image";
        } else {
          screenshot = {
            mime: "image/png",
            dataUrl,
            bounds: { x: r.x, y: r.y, width: r.width, height: r.height },
          };
        }
      } catch {
        screenshotUnavailable = "rasterise failed";
      }
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
