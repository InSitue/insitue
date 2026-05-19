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
} from "@insitu/capture-core";
import { runtimeSnapshot } from "./runtime.js";

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
  if (el instanceof HTMLElement) {
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
      screenshot = {
        mime: "image/png",
        dataUrl,
        bounds: { x: r.x, y: r.y, width: r.width, height: r.height },
      };
    } catch {
      /* screenshot is best-effort; bundle is still useful without it */
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
