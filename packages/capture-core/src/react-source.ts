/**
 * Pure React-fiber → source resolver. No React dependency: reads the
 * `__reactFiber$*` expando React attaches to host DOM nodes in dev,
 * walks `_debugOwner`/`return`, and harvests `_debugSource`
 * ({ fileName, lineNumber, columnNumber }) plus component names.
 * Falls back to a build-injected `data-insitue-source` attribute.
 */
import type {
  CaptureTarget,
  SourceConfidence,
  SourceLoc,
} from "./index.js";
import { buildSelector } from "./dom.js";

interface DebugSource {
  fileName?: string;
  lineNumber?: number;
  columnNumber?: number;
}
interface Fiber {
  type?: unknown;
  return?: Fiber | null;
  _debugSource?: DebugSource;
  _debugOwner?: Fiber | null;
}

function getFiber(el: Element): Fiber | null {
  for (const k of Object.keys(el)) {
    if (k.startsWith("__reactFiber$") || k.startsWith("__reactInternalInstance$")) {
      return (el as unknown as Record<string, Fiber>)[k] ?? null;
    }
  }
  return null;
}

function compName(type: unknown): string | null {
  if (typeof type === "function") {
    const f = type as { displayName?: string; name?: string };
    return f.displayName || f.name || "Anonymous";
  }
  if (type && typeof type === "object") {
    const o = type as { displayName?: string; render?: { name?: string } };
    return o.displayName || o.render?.name || null;
  }
  return null;
}

function toLoc(src: DebugSource): SourceLoc | null {
  if (!src.fileName) return null;
  return {
    // React gives an absolute path in dev; the companion re-roots it.
    file: src.fileName,
    line: src.lineNumber ?? 1,
    column: src.columnNumber ?? 1,
  };
}

/** Parse a build-injected `data-insitue-source="relpath:line:col"`. */
function fromAttribute(el: Element): SourceLoc | null {
  let cur: Element | null = el;
  for (let i = 0; cur && i < 8; i++, cur = cur.parentElement) {
    const raw = cur.getAttribute("data-insitue-source");
    if (raw) {
      const m = /^(.*):(\d+):(\d+)$/.exec(raw);
      if (m) return { file: m[1]!, line: Number(m[2]), column: Number(m[3]) };
    }
  }
  return null;
}

/** Find the nearest ancestor (incl. el itself) stamped with a
 *  `data-insitue-cms` attribute. Host apps emit this on CMS-rendered
 *  roots so the picker can attribute content to its CMS row, not
 *  just the rendering component. Walks up to 16 levels — CMS roots
 *  are typically a few wrappers up from any given paragraph. */
function fromCmsAttribute(
  el: Element,
): CaptureTarget["cmsSource"] | undefined {
  let cur: Element | null = el;
  for (let i = 0; cur && i < 16; i++, cur = cur.parentElement) {
    const handle = cur.getAttribute("data-insitue-cms");
    if (handle) {
      const adminUrl =
        cur.getAttribute("data-insitue-cms-url") ?? undefined;
      return adminUrl ? { handle, adminUrl } : { handle };
    }
  }
  return undefined;
}

export function resolveTarget(el: Element): CaptureTarget {
  const selector = buildSelector(el);
  const fiber = getFiber(el);
  const componentStack: CaptureTarget["componentStack"] = [];

  if (fiber) {
    let f: Fiber | null = fiber;
    let guard = 0;
    while (f && guard++ < 60) {
      const name = compName(f.type);
      if (name) {
        const src = f._debugSource ? toLoc(f._debugSource) : null;
        componentStack.push(
          src ? { name, source: src } : { name },
        );
      }
      f = f._debugOwner ?? f.return ?? null;
    }
  }

  // Best source, best confidence:
  //  1. host fiber _debugSource (the JSX site of the element)  → exact
  //  2. build-injected data-insitue-source attribute            → exact
  //  3. nearest owning component with _debugSource             → approximate
  //  4. nothing                                                → selector-only
  let source: SourceLoc | undefined;
  let confidence: SourceConfidence = "selector-only";

  const hostSrc = fiber?._debugSource ? toLoc(fiber._debugSource) : null;
  if (hostSrc) {
    source = hostSrc;
    confidence = "exact";
  } else {
    const attrSrc = fromAttribute(el);
    if (attrSrc) {
      source = attrSrc;
      confidence = "exact";
    } else {
      const ownerWithSrc = componentStack.find((c) => c.source);
      if (ownerWithSrc?.source) {
        source = ownerWithSrc.source;
        confidence = "approximate";
      }
    }
  }

  const cmsSource = fromCmsAttribute(el);

  const base: CaptureTarget =
    source === undefined
      ? { confidence, componentStack, selector }
      : { source, confidence, componentStack, selector };
  return cmsSource ? { ...base, cmsSource } : base;
}
