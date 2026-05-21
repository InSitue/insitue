/**
 * Pure DOM → data helpers. Browser APIs only — no transport/agent/fs,
 * no dependencies. Shared by every vehicle.
 */
import type { SerializedNode } from "./index.js";

const SKIP_TAGS = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE"]);
const ATTR_DENY = /^(on|data-insitue)/i;
const SECRETISH = /(token|secret|key|password|authorization|bearer)/i;

/** Prune + sanitize a subtree: depth/breadth-capped, event handlers
 *  and secret-looking attrs stripped, text truncated. */
export function serializeNode(
  el: Element,
  depth = 3,
  maxChildren = 12,
): SerializedNode {
  const attrs: Record<string, string> = {};
  for (const a of Array.from(el.attributes)) {
    if (ATTR_DENY.test(a.name)) continue;
    const v = SECRETISH.test(a.name) ? "[redacted]" : a.value;
    attrs[a.name] = v.length > 300 ? v.slice(0, 300) + "…" : v;
  }
  const node: SerializedNode = {
    tag: el.tagName.toLowerCase(),
    attrs,
    children: [],
  };
  const directText = Array.from(el.childNodes)
    .filter((n) => n.nodeType === Node.TEXT_NODE)
    .map((n) => n.textContent ?? "")
    .join(" ")
    .trim();
  if (directText) node.text = directText.slice(0, 200);
  if (depth > 0) {
    const kids = Array.from(el.children)
      .filter((c) => !SKIP_TAGS.has(c.tagName))
      .slice(0, maxChildren);
    node.children = kids.map((c) => serializeNode(c, depth - 1, maxChildren));
  }
  return node;
}

/** A curated, stable subset of computed styles — box model, layout,
 *  typography, color. Enough for the agent without dumping ~400 props. */
const STYLE_KEYS = [
  "display",
  "position",
  "boxSizing",
  "width",
  "height",
  "margin",
  "padding",
  "border",
  "flexDirection",
  "alignItems",
  "justifyContent",
  "gap",
  "gridTemplateColumns",
  "color",
  "backgroundColor",
  "fontFamily",
  "fontSize",
  "fontWeight",
  "lineHeight",
  "letterSpacing",
  "textAlign",
  "borderRadius",
  "boxShadow",
  "opacity",
  "zIndex",
] as const;

export function curateComputedStyles(el: Element): Record<string, string> {
  const cs = getComputedStyle(el);
  const out: Record<string, string> = {};
  for (const k of STYLE_KEYS) {
    const v = cs[k as keyof CSSStyleDeclaration];
    if (typeof v === "string" && v && v !== "normal" && v !== "none") {
      out[k] = v;
    }
  }
  return out;
}

/** The verbatim class list — the agent edits Tailwind classes, not
 *  inline styles, so the source-of-truth is `className`. */
export function extractTailwindClasses(el: Element): string[] {
  const cls =
    typeof el.className === "string"
      ? el.className
      : el.getAttribute("class") ?? "";
  return cls.split(/\s+/).filter(Boolean);
}

/** A robust, reasonably-stable CSS path. Prefers #id, then a
 *  data-testid, else tag + nth-of-type up to a shortest unique path.
 *  Always present — the last-resort locator. */
export function buildSelector(el: Element): string {
  if (el.id && document.querySelectorAll(`#${CSS.escape(el.id)}`).length === 1) {
    return `#${CSS.escape(el.id)}`;
  }
  const parts: string[] = [];
  let cur: Element | null = el;
  while (cur && cur.nodeType === Node.ELEMENT_NODE && parts.length < 6) {
    const tid = cur.getAttribute("data-testid");
    if (tid) {
      parts.unshift(`[data-testid="${CSS.escape(tid)}"]`);
      break;
    }
    const tag = cur.tagName.toLowerCase();
    const parent: Element | null = cur.parentElement;
    if (!parent) {
      parts.unshift(tag);
      break;
    }
    const sibs = Array.from(parent.children).filter(
      (c) => c.tagName === cur!.tagName,
    );
    const idx = sibs.indexOf(cur);
    parts.unshift(
      sibs.length > 1 ? `${tag}:nth-of-type(${idx + 1})` : tag,
    );
    if (cur.id) {
      parts.unshift(`#${CSS.escape(cur.id)}`);
      break;
    }
    cur = parent;
  }
  return parts.join(" > ");
}

/** Tailwind-ish breakpoint label from viewport width. */
export function breakpointFor(w: number): string {
  if (w < 640) return "xs";
  if (w < 768) return "sm";
  if (w < 1024) return "md";
  if (w < 1280) return "lg";
  if (w < 1536) return "xl";
  return "2xl";
}
