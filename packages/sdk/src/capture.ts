/**
 * Assembles a `CaptureBundle` from a picker selection — the SDK's
 * `CaptureCore.buildBundle`. Screenshot capture is the primary signal
 * a reviewer (human or agent) uses to verify a bug, so it gets a
 * layered, perfect-by-default strategy:
 *
 *   1. **html-to-image rasterise** — full-document render + crop.
 *      `html-to-image@1.11.13` already fetches cross-origin `<img>`
 *      URLs via `fetch()` and embeds them as `data:` URLs before the
 *      canvas paints, so CORS-friendly CDNs (Supabase, Cloudinary,
 *      most S3-with-CORS setups) render correctly with NO permission
 *      ask. Non-CORS URLs fall back to an explicit placeholder.
 *
 *   2. **`getDisplayMedia` escalation** — when layer 1's quality
 *      check reports unembeddable content (failed `<img>`, any
 *      `<video>`, any `<canvas>`) the SDK requests one-time tab-
 *      capture permission for a pixel-perfect OS-compositor grab.
 *      The MediaStream is cached for the session so subsequent
 *      captures skip the prompt.
 *
 *   3. **Graceful degrade** — if `getDisplayMedia` is unsupported or
 *      denied, ship the layer-1 result with a `qualityNote` and
 *      surface a retry nudge in the overlay.
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
import { getCaptureSettings } from "./capture-settings.js";

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

/** Visually-honest "image unavailable" marker used as html-to-image's
 *  `imagePlaceholder` AND as the swap-in for our own pre-resolve
 *  failures. Base64 (not `;utf8`) for cross-browser reliability —
 *  the `;utf8` shorthand isn't part of the data-URL spec and gets
 *  rejected inside `<foreignObject>` rendering on some browsers. */
const IMAGE_PLACEHOLDER =
  "data:image/svg+xml;base64," +
  (typeof btoa !== "undefined"
    ? btoa(
        '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32">' +
          '<rect width="32" height="32" fill="#e8e8e8"/>' +
          '<path d="M0 0 L32 32 M32 0 L0 32" stroke="#b0b0b0" stroke-width="1.5"/>' +
          "</svg>",
      )
    : "");

// Why we don't pre-resolve <img> srcs into data URLs before the
// html-to-image clone: it causes a visible page-image flash (the
// live <img> momentarily shows the data-URL load cycle), and
// doesn't actually fix next/image — html-to-image still drops the
// img because the underlying problem is layout
// (position:absolute + aspect-ratio + object-fit:cover inside
// foreignObject), not fetch. The right answer is to let
// html-to-image handle CORS-friendly imgs, detect when it
// silently dropped one (pixel sampling), and auto-escalate to
// `getDisplayMedia` for pixel-perfect.

/** An element we can screenshot — has rect + inline style. Both
 *  HTMLElement and SVGElement (incl. SVGGElement, the "g" group)
 *  qualify; widening from HTMLElement-only is what lets SVG picks
 *  produce a screenshot at all. */
type RasterisableElement = HTMLElement | SVGElement;

/** Walk up from the picked element to find a meaningfully-sized
 *  ancestor to screenshot — so the thumbnail has enough visual
 *  context for a human reviewer to recognise the bug. */
function findContextAncestor(el: RasterisableElement): RasterisableElement {
  const minW = 420;
  const minH = 140;
  const maxW = window.innerWidth * 1.2;
  const maxH = window.innerHeight * 1.2;
  let cur: RasterisableElement = el;
  for (let depth = 0; depth < 8; depth++) {
    const r = cur.getBoundingClientRect();
    if (r.width >= minW && r.height >= minH) return cur;
    const parent = cur.parentElement;
    if (!parent) return cur;
    const pr = parent.getBoundingClientRect();
    if (pr.width > maxW || pr.height > maxH) return cur;
    cur = parent as RasterisableElement;
  }
  return cur;
}

/** Rasterise the FULL document and crop to `cropRect` (viewport
 *  coords, CSS pixels). Rendering the whole document — not just the
 *  picked subtree — is the only honest way to capture html/body
 *  backgrounds, parent backdrop decorations, fixed/sticky chrome,
 *  and sibling overlays that compose what the user actually sees.
 *
 *  Cross-origin handling: we let html-to-image's built-in
 *  `embedImages` do its job (`fetch()` cross-origin URLs, embed as
 *  data URLs — canvas is never tainted). Non-CORS fetch failures
 *  fall back to `IMAGE_PLACEHOLDER`. */
async function renderViewportCrop(
  cropRect: DOMRect,
  pixelRatio: number,
): Promise<{
  dataUrl: string | null;
  /** True when the rasterised canvas's 16-pixel sample grid hit a
   *  single colour. Caller decides: when layer-2 is available, treat
   *  this as a failed rasterise and escalate; when layer-2 is off
   *  (dev overlay), trust it (legitimate uniform-colour crops happen,
   *  e.g. a small element inside a solid-background section, and a
   *  uniform thumbnail beats no thumbnail). */
  looksBlank: boolean;
  /** 0..1 — fraction of the sample grid hitting the most-common
   *  pixel. 1.0 = `looksBlank: true`. Threaded through to
   *  `captureDiagnostics.shippedBlankScore` (insitue#10). */
  blankScore: number;
  failedImages: Set<HTMLImageElement>;
}> {
  const bodyBg = getComputedStyle(document.body).backgroundColor;
  const htmlBg = getComputedStyle(document.documentElement).backgroundColor;
  const backgroundColor =
    bodyBg && bodyBg !== "rgba(0, 0, 0, 0)" && bodyBg !== "transparent"
      ? bodyBg
      : htmlBg && htmlBg !== "rgba(0, 0, 0, 0)" && htmlBg !== "transparent"
        ? htmlBg
        : "#ffffff";

  const failedImages = new Set<HTMLImageElement>();
  const out = document.createElement("canvas");
  out.width = Math.max(1, Math.round(cropRect.width * pixelRatio));
  out.height = Math.max(1, Math.round(cropRect.height * pixelRatio));
  const ctx = out.getContext("2d");
  if (!ctx)
    return {
      dataUrl: null,
      looksBlank: false,
      blankScore: 0,
      failedImages,
    };

  // 1. html-to-image renders the document. For
  //    absolutely-positioned <img>s (the next/image fill pattern)
  //    its foreignObject pipeline drops the image and shows the
  //    parent's background instead. We'll patch over that next.
  const fullCanvas = await toCanvas(document.documentElement, {
    pixelRatio,
    cacheBust: true,
    backgroundColor,
    imagePlaceholder: IMAGE_PLACEHOLDER,
    filter: (n) =>
      !(
        n instanceof Element &&
        n.closest?.("#insitue-root, [data-insitue-layer]")
      ),
  });

  // 2. Composite html-to-image output onto our crop canvas.
  const sx = window.scrollX;
  const sy = window.scrollY;
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

  // 3. Manual <img> overlay — paint absolutely-positioned imgs on
  //    TOP, replacing the empty/parent-bg areas html-to-image left
  //    behind.
  //
  //    Two failure modes the fresh-load + CORS draw handles:
  //     - `drawImage(liveImg, …)` on a next/image element paints
  //       pure black (Next dev's image pipeline leaves the live
  //       img's bitmap inaccessible to canvas — verified).
  //     - html-to-image's clone drops the same imgs entirely
  //       (foreignObject layout breaks position:absolute +
  //       aspect-ratio + object-fit combos).
  //    The fresh `Image` with `crossOrigin="anonymous"` re-fetches
  //    via the standard pipeline (HTTP-cached) and produces a
  //    paintable bitmap.
  //
  //    Z-order trade-off: imgs paint AFTER UI/text, so any text
  //    overlay positioned ABOVE the img bbox gets covered. Common
  //    on hero patterns (text-on-image). The trade-off is
  //    deliberate — having the image visible matters more than
  //    perfect text-over-image z-order for a bug-report capture.
  //    Users who need pixel-perfect z-order should opt into
  //    `defaultPixelPerfect` (getDisplayMedia, no compromises).
  const drawnImgs = await drawAbsoluteImagesOnto(
    ctx,
    cropRect,
    pixelRatio,
    failedImages,
  );
  void drawnImgs; // Used to satisfy the type — flagged imgs are
  // collected via the `failedImages` set, which `assessCaptureQuality`
  // reads after the rasterise.

  const { looksBlank, blankScore } = looksBlankUniform(
    ctx,
    out.width,
    out.height,
  );
  detectUnrenderedImages(ctx, cropRect, out, pixelRatio, failedImages);
  return {
    dataUrl: out.toDataURL("image/png"),
    looksBlank,
    blankScore,
    failedImages,
  };
}

/** Walk every absolutely-positioned `<img>` whose bbox overlaps
 *  the crop region, fetch each via a fresh `Image` with
 *  `crossOrigin="anonymous"`, and draw the fresh bitmap to `ctx`
 *  with `object-fit` / `object-position` math.
 *
 *  Why a fresh `Image` instead of `drawImage(liveImg, …)`: the
 *  live `<img>` rendered by next/image produces uniform black
 *  pixels when drawn to canvas directly — its bitmap isn't
 *  accessible to the canvas paint path. A fresh same-URL load
 *  through the standard image pipeline IS canvas-paintable. We
 *  use the browser HTTP cache so usually no extra network. */
async function drawAbsoluteImagesOnto(
  ctx: CanvasRenderingContext2D,
  cropRect: DOMRect,
  pixelRatio: number,
  failedImages: Set<HTMLImageElement>,
): Promise<Set<HTMLImageElement>> {
  const drawn = new Set<HTMLImageElement>();
  const imgs = Array.from(
    document.querySelectorAll<HTMLImageElement>("img"),
  ).filter(
    (img) => !img.closest?.("#insitue-root, [data-insitue-layer]"),
  );

  /** Per-image hard timeout so one slow asset can't stall the
   *  whole capture via Promise.allSettled. 3s covers cache-hit +
   *  a small network round-trip; if it takes longer than that the
   *  fix isn't going to ship. */
  const PER_IMAGE_TIMEOUT_MS = 3_000;

  await Promise.allSettled(
    imgs.map(async (img) => {
      const r = img.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) return;
      const cs = getComputedStyle(img);
      if (cs.position !== "absolute" && cs.position !== "fixed") return;
      // Skip imgs outside the crop region.
      if (
        r.right < cropRect.x ||
        r.left > cropRect.x + cropRect.width ||
        r.bottom < cropRect.y ||
        r.top > cropRect.y + cropRect.height
      ) {
        return;
      }
      const src = img.currentSrc || img.src;
      if (!src) return;
      // data:/blob: URLs are inherently same-origin and trivially
      // drawable; fall through to direct drawImage to avoid the
      // re-load round-trip.
      const usesFreshLoad =
        !src.startsWith("data:") && !src.startsWith("blob:");

      let source: HTMLImageElement;
      if (usesFreshLoad) {
        try {
          source = await loadFresh(src, PER_IMAGE_TIMEOUT_MS);
        } catch {
          // Either the server didn't send CORS headers, the URL
          // was unreachable, or the timeout fired. Flag for
          // layer-2 escalation; we can't draw this in layer 1.
          failedImages.add(img);
          return;
        }
      } else {
        // Live data:/blob: img is paintable.
        if (!img.complete || img.naturalWidth === 0) {
          failedImages.add(img);
          return;
        }
        source = img;
      }
      // Object-fit math uses the FRESH image's natural dimensions
      // (Next dev's live img often reports a placeholder size).
      const objFit = computeObjectFitSource(
        { naturalWidth: source.naturalWidth, naturalHeight: source.naturalHeight },
        r.width,
        r.height,
        cs.objectFit || "fill",
      );
      const dest = {
        x: (r.left - cropRect.x) * pixelRatio,
        y: (r.top - cropRect.y) * pixelRatio,
        w: r.width * pixelRatio,
        h: r.height * pixelRatio,
      };
      try {
        ctx.drawImage(
          source,
          objFit.sx,
          objFit.sy,
          objFit.sw,
          objFit.sh,
          dest.x,
          dest.y,
          dest.w,
          dest.h,
        );
        drawn.add(img);
      } catch {
        failedImages.add(img);
      }
    }),
  );
  return drawn;
}

/** Load a URL into a fresh `Image` with `crossOrigin="anonymous"`,
 *  await decode, return the element. Rejects on load error or
 *  timeout. The hard timeout matters because one stuck request
 *  otherwise stalls Promise.allSettled in the caller. */
function loadFresh(url: string, timeoutMs: number): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    const timer = setTimeout(() => {
      img.src = ""; // abort
      reject(new Error("timeout"));
    }, timeoutMs);
    img.onload = async () => {
      clearTimeout(timer);
      try {
        await img.decode();
      } catch {
        // Decode races aren't fatal; the bitmap is usually ready
        // anyway. Continue.
      }
      resolve(img);
    };
    img.onerror = () => {
      clearTimeout(timer);
      reject(new Error("load failed"));
    };
    img.src = url;
  });
}

/** Translate the picked img's `object-fit` + `object-position` into
 *  a source rectangle for `ctx.drawImage`. Covers the common cases
 *  (fill / cover / contain / none); `scale-down` falls back to
 *  contain semantics. Object-position is centred-only for now —
 *  most next/image usage is the default `center`. */
function computeObjectFitSource(
  natural: { naturalWidth: number; naturalHeight: number },
  dw: number,
  dh: number,
  fit: string,
): { sx: number; sy: number; sw: number; sh: number } {
  const nw = natural.naturalWidth;
  const nh = natural.naturalHeight;
  if (!nw || !nh || !dw || !dh) {
    return { sx: 0, sy: 0, sw: nw || 1, sh: nh || 1 };
  }
  if (fit === "fill") {
    return { sx: 0, sy: 0, sw: nw, sh: nh };
  }
  const destAR = dw / dh;
  const srcAR = nw / nh;
  if (fit === "cover") {
    if (srcAR > destAR) {
      // Source is wider — crop sides.
      const sw = nh * destAR;
      return { sx: (nw - sw) / 2, sy: 0, sw, sh: nh };
    }
    const sh = nw / destAR;
    return { sx: 0, sy: (nh - sh) / 2, sw: nw, sh };
  }
  if (fit === "contain" || fit === "scale-down") {
    // No source crop — drawImage stretches the whole source to dest.
    // (For perfect letterboxing we'd need to inset dest; skipped
    // for now — letterbox edges sit on background colour, fine.)
    return { sx: 0, sy: 0, sw: nw, sh: nh };
  }
  // `none` — 1:1 from centre.
  if (fit === "none") {
    const sw = Math.min(nw, dw);
    const sh = Math.min(nh, dh);
    return {
      sx: (nw - sw) / 2,
      sy: (nh - sh) / 2,
      sw,
      sh,
    };
  }
  return { sx: 0, sy: 0, sw: nw, sh: nh };
}

/** Post-render image verification — for each `<img>` whose bbox
 *  intersects the crop, sample pixels in the rasterised canvas at
 *  the img's expected location. If the area is uniform (single
 *  colour, alpha ~ background) the image DIDN'T actually render
 *  inside html-to-image's foreignObject pipeline — common with
 *  next/image (`<img style="position:absolute; object-fit:cover">`
 *  inside an `aspect-ratio` parent — modern CSS that html-to-image
 *  doesn't fully support). Detection adds the affected `<img>` to
 *  `failedImages` which `assessCaptureQuality` then uses to trigger
 *  the layer-2 `getDisplayMedia` escalation — so the user gets a
 *  pixel-perfect capture (with permission) instead of a silent
 *  empty image. */
function detectUnrenderedImages(
  cropCtx: CanvasRenderingContext2D,
  cropRect: DOMRect,
  cropCanvas: HTMLCanvasElement,
  pixelRatio: number,
  failedImages: Set<HTMLImageElement>,
): void {
  const imgs = Array.from(
    document.querySelectorAll<HTMLImageElement>("img"),
  ).filter(
    (img) => !img.closest?.("#insitue-root, [data-insitue-layer]"),
  );

  for (const img of imgs) {
    if (failedImages.has(img)) continue; // already known-bad
    const r = img.getBoundingClientRect();
    // Only verify images visible in the crop, and large enough to
    // sample meaningfully (sub-32px icons aren't worth the cost).
    if (r.width < 32 || r.height < 32) continue;
    const overlapX = Math.min(r.right, cropRect.x + cropRect.width)
      - Math.max(r.left, cropRect.x);
    const overlapY = Math.min(r.bottom, cropRect.y + cropRect.height)
      - Math.max(r.top, cropRect.y);
    if (overlapX <= 0 || overlapY <= 0) continue;

    // Sample 9 evenly-spaced points in the overlapping region.
    // If all 9 are byte-identical → uniform fill → almost
    // certainly the image is missing (real photos vary across
    // any 3×3 grid).
    const baseX = Math.max(r.left, cropRect.x);
    const baseY = Math.max(r.top, cropRect.y);
    const samples = new Set<string>();
    try {
      for (let i = 0; i < 3; i++) {
        for (let j = 0; j < 3; j++) {
          const px = baseX + (overlapX * (i + 0.5)) / 3;
          const py = baseY + (overlapY * (j + 0.5)) / 3;
          // Convert viewport coords → crop-canvas pixel coords.
          const cx = Math.max(
            0,
            Math.min(
              cropCanvas.width - 1,
              Math.round((px - cropRect.x) * pixelRatio),
            ),
          );
          const cy = Math.max(
            0,
            Math.min(
              cropCanvas.height - 1,
              Math.round((py - cropRect.y) * pixelRatio),
            ),
          );
          const d = cropCtx.getImageData(cx, cy, 1, 1).data;
          samples.add(`${d[0]},${d[1]},${d[2]},${d[3]}`);
        }
      }
    } catch {
      // Tainted canvas — shouldn't happen with our embed path.
      continue;
    }
    if (samples.size === 1) {
      // Uniform fill where a real image should be → render failed.
      failedImages.add(img);
    }
  }
}

/** Cheap blank-detection — sample 16 evenly spaced pixels.
 *
 *  `looksBlank` is the single-color verdict (every sampled pixel
 *  bytewise identical). One-color real UI is rare enough that a
 *  false positive here just escalates to the pixel-perfect path
 *  (or shows a qualityNote) — not a regression.
 *
 *  `blankScore` is the fraction of the sample grid that hit the
 *  most-common color. 1.0 = total uniform (definitely blank);
 *  0.0625 = every sample unique (16 samples = full variety).
 *  Surfaced in `captureDiagnostics.shippedBlankScore` (insitue#10)
 *  for aggregate analysis: a hard `looksBlank` threshold might miss
 *  near-blank cases, but `score > 0.9` is a useful warning signal. */
function looksBlankUniform(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
): { looksBlank: boolean; blankScore: number } {
  if (w < 4 || h < 4) return { looksBlank: false, blankScore: 0 };
  const samples: string[] = [];
  for (let i = 0; i < 4; i++) {
    for (let j = 0; j < 4; j++) {
      const x = Math.floor((w * (i + 0.5)) / 4);
      const y = Math.floor((h * (j + 0.5)) / 4);
      try {
        const px = ctx.getImageData(x, y, 1, 1).data;
        samples.push(`${px[0]},${px[1]},${px[2]},${px[3]}`);
      } catch {
        // Tainted canvas (shouldn't happen with our embed path —
        // but if it does, treat as opaque-blank, escalate).
        return { looksBlank: true, blankScore: 1 };
      }
    }
  }
  // Score = max-bucket count / total samples. 1 = all same color.
  const counts = new Map<string, number>();
  for (const s of samples) counts.set(s, (counts.get(s) ?? 0) + 1);
  const maxBucket = Math.max(...counts.values());
  return {
    looksBlank: counts.size === 1,
    blankScore: maxBucket / samples.length,
  };
}

interface QualityAssessment {
  /** A non-placeholder `<img>` failed to load (naturalWidth/Height
   *  === 0 with a non-empty src) — html-to-image's fetch-embed
   *  probably hit a non-CORS origin. */
  unembeddableImages: number;
  /** Any `<video>` element in the crop — its current frame can't be
   *  pulled cross-origin via canvas, so escalate to OS-compositor. */
  hasVideo: boolean;
  /** Any `<canvas>` element with non-trivial content — html-to-image
   *  can't always read its pixels (tainted by upstream draws). */
  hasCanvas: boolean;
}

/** Walk the elements geometrically inside `cropRect` and decide
 *  whether the layer-1 screenshot is structurally perfect. The
 *  `failedImages` set comes from `preResolveImages` — it's the
 *  ground truth of which `<img>` elements we couldn't fetch+inline
 *  (typically: cross-origin without CORS). Anything flagged here
 *  triggers the layer-2 `getDisplayMedia` escalation. */
function assessCaptureQuality(
  cropRect: DOMRect,
  failedImages: Set<HTMLImageElement>,
): QualityAssessment {
  const out: QualityAssessment = {
    unembeddableImages: 0,
    hasVideo: false,
    hasCanvas: false,
  };
  const all = document.querySelectorAll("img, video, canvas");
  for (const el of all) {
    if (
      el instanceof Element &&
      el.closest?.("#insitue-root, [data-insitue-layer]")
    ) {
      continue;
    }
    const r = el.getBoundingClientRect();
    const overlaps =
      r.right >= cropRect.x &&
      r.left <= cropRect.x + cropRect.width &&
      r.bottom >= cropRect.y &&
      r.top <= cropRect.y + cropRect.height;
    if (!overlaps) continue;
    if (el instanceof HTMLImageElement) {
      if (failedImages.has(el)) out.unembeddableImages++;
    } else if (el instanceof HTMLVideoElement) {
      // Videos can be same-origin but we still can't extract the
      // current frame via html-to-image — escalate.
      if (r.width > 0 && r.height > 0) out.hasVideo = true;
    } else if (el instanceof HTMLCanvasElement) {
      if (r.width > 0 && r.height > 0) out.hasCanvas = true;
    }
  }
  return out;
}

/** Content-type tripwires inside the crop region (insitue#10).
 *  Separate from `assessCaptureQuality` because that one drives the
 *  layer-2 escalation decision; THIS one is pure telemetry for the
 *  `captureDiagnostics` field. Includes `iframe` (which assessment
 *  ignores — we can't capture across an origin boundary anyway) and
 *  Shadow DOM depth (which silently makes html-to-image miss children). */
interface CropContent {
  hasVideo: boolean;
  hasCanvas: boolean;
  hasIframe: boolean;
  shadowDomDepth: number;
}
function inspectCropContent(cropRect: DOMRect): CropContent {
  const out: CropContent = {
    hasVideo: false,
    hasCanvas: false,
    hasIframe: false,
    shadowDomDepth: 0,
  };
  const overlaps = (r: DOMRect) =>
    r.right >= cropRect.x &&
    r.left <= cropRect.x + cropRect.width &&
    r.bottom >= cropRect.y &&
    r.top <= cropRect.y + cropRect.height &&
    r.width > 0 &&
    r.height > 0;
  const all = document.querySelectorAll("video, canvas, iframe");
  for (const el of all) {
    if (
      el instanceof Element &&
      el.closest?.("#insitue-root, [data-insitue-layer]")
    ) {
      continue;
    }
    if (!overlaps(el.getBoundingClientRect())) continue;
    if (el instanceof HTMLVideoElement) out.hasVideo = true;
    else if (el instanceof HTMLCanvasElement) out.hasCanvas = true;
    else if (el instanceof HTMLIFrameElement) out.hasIframe = true;
  }
  // Shadow DOM depth: walk down from the cropped region's elements,
  // descend into shadowRoots, track the deepest open one.
  // Closed shadowRoots are invisible to JS — we accept that gap.
  function depthAt(node: Element, current = 0): number {
    let max = current;
    const root = (node as Element & { shadowRoot?: ShadowRoot | null })
      .shadowRoot;
    if (root) {
      max = Math.max(max, current + 1);
      for (const c of Array.from(root.children)) {
        max = Math.max(max, depthAt(c, current + 1));
      }
    }
    for (const c of Array.from(node.children)) {
      max = Math.max(max, depthAt(c, current));
    }
    return max;
  }
  // Sample a few elements inside the crop rather than walking the
  // whole document — at the corners and center.
  const samplePoints = [
    [cropRect.x + 4, cropRect.y + 4],
    [cropRect.x + cropRect.width - 4, cropRect.y + 4],
    [cropRect.x + 4, cropRect.y + cropRect.height - 4],
    [cropRect.x + cropRect.width - 4, cropRect.y + cropRect.height - 4],
    [cropRect.x + cropRect.width / 2, cropRect.y + cropRect.height / 2],
  ];
  for (const [x, y] of samplePoints) {
    const els = document.elementsFromPoint(x!, y!);
    if (els[0]) out.shadowDomDepth = Math.max(out.shadowDomDepth, depthAt(els[0]));
  }
  return out;
}

function describeImperfection(q: QualityAssessment): string {
  const parts: string[] = [];
  if (q.unembeddableImages > 0) {
    parts.push(
      `${q.unembeddableImages} non-CORS image${q.unembeddableImages > 1 ? "s" : ""}`,
    );
  }
  if (q.hasVideo) parts.push("video frame");
  if (q.hasCanvas) parts.push("canvas content");
  return parts.join(" + ");
}

// ---------------------------------------------------------------
// Layer 2 — `getDisplayMedia` pixel-perfect capture.

/** Session-scoped cache for the active tab-capture MediaStream. The
 *  stream pays a one-time browser permission prompt; subsequent
 *  captures in the same session reuse it instantly. */
const displayMediaState: {
  stream: MediaStream | null;
  trackEndedHandler: (() => void) | null;
  idleTimer: ReturnType<typeof setTimeout> | null;
  deniedAt: number | null;
} = {
  stream: null,
  trackEndedHandler: null,
  idleTimer: null,
  deniedAt: null,
};

const IDLE_MS = 90_000;

/** Listeners that want to react when the tab-capture stream is
 *  granted, ended, or denied — used by the overlay to flip the
 *  "tab capture active" pill on/off. */
type DisplayMediaListener = (active: boolean, reason?: string) => void;
const displayMediaListeners = new Set<DisplayMediaListener>();
export function onDisplayMediaChange(l: DisplayMediaListener): () => void {
  displayMediaListeners.add(l);
  // Initial sync.
  l(displayMediaState.stream != null);
  return () => displayMediaListeners.delete(l);
}
function notifyDisplayMedia(reason?: string): void {
  const active = displayMediaState.stream != null;
  for (const l of displayMediaListeners) l(active, reason);
}

/** Stop the cached stream and clear all hooks. Called on overlay
 *  close, page hide, idle expiry, or explicit user stop. */
export function stopDisplayMedia(reason = "stopped"): void {
  if (displayMediaState.stream) {
    for (const t of displayMediaState.stream.getTracks()) t.stop();
  }
  if (displayMediaState.idleTimer) clearTimeout(displayMediaState.idleTimer);
  if (
    displayMediaState.trackEndedHandler &&
    displayMediaState.stream
  ) {
    for (const t of displayMediaState.stream.getTracks()) {
      t.removeEventListener("ended", displayMediaState.trackEndedHandler);
    }
  }
  displayMediaState.stream = null;
  displayMediaState.trackEndedHandler = null;
  displayMediaState.idleTimer = null;
  notifyDisplayMedia(reason);
}

function bumpIdleTimer(): void {
  if (displayMediaState.idleTimer) clearTimeout(displayMediaState.idleTimer);
  displayMediaState.idleTimer = setTimeout(
    () => stopDisplayMedia("idle"),
    IDLE_MS,
  );
}

/** True when the browser supports the tab-capture API. */
function supportsDisplayMedia(): boolean {
  return (
    typeof navigator !== "undefined" &&
    typeof navigator.mediaDevices?.getDisplayMedia === "function"
  );
}

/** Resolve (or create) the session-scoped `getDisplayMedia`
 *  MediaStream. Returns null if unsupported, denied, or already
 *  denied this session (debounced — we don't re-prompt the same
 *  session if the user said no). */
async function ensureDisplayMediaStream(): Promise<MediaStream | null> {
  if (!supportsDisplayMedia()) return null;
  if (displayMediaState.stream) {
    bumpIdleTimer();
    return displayMediaState.stream;
  }
  // Debounce repeated prompts after a deny — re-prompting on every
  // capture would be hostile UX. The overlay's explicit "Enable"
  // nudge clears this flag.
  if (displayMediaState.deniedAt && Date.now() - displayMediaState.deniedAt < 60_000) {
    return null;
  }
  try {
    const stream = await navigator.mediaDevices.getDisplayMedia({
      // `displaySurface: 'browser'` + `preferCurrentTab: true` makes
      // Chrome/Edge default-select the current tab in the prompt.
      // Other browsers ignore the hints; user still picks manually.
      video: {
        // displaySurface is in the spec but the lib.dom MediaTrackConstraints
        // type doesn't expose it yet — cast keeps us strict without lying.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        displaySurface: "browser",
      } as MediaTrackConstraints,
      audio: false,
      // preferCurrentTab is Chromium-only and not in the standard
      // DisplayMediaStreamOptions; same lib.dom-typing gap.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      preferCurrentTab: true,
    } as DisplayMediaStreamOptions);
    displayMediaState.stream = stream;
    displayMediaState.deniedAt = null;
    // If the user clicks the browser's native "Stop sharing" button,
    // tracks end on their own — sync our state.
    const handler = () => stopDisplayMedia("track-ended");
    for (const t of stream.getTracks()) t.addEventListener("ended", handler);
    displayMediaState.trackEndedHandler = handler;
    bumpIdleTimer();
    notifyDisplayMedia("granted");
    return stream;
  } catch {
    displayMediaState.deniedAt = Date.now();
    notifyDisplayMedia("denied");
    return null;
  }
}

/** User-initiated retry — clears the deny-debounce and re-prompts. */
export async function retryDisplayMedia(): Promise<boolean> {
  displayMediaState.deniedAt = null;
  const s = await ensureDisplayMediaStream();
  return s != null;
}

/** Hide our overlay layers for the single frame we capture so the
 *  panel and picker UI don't appear in the screenshot. Restores on
 *  the next animation frame so the user barely sees the flicker. */
function hideOverlayLayersBriefly(): () => void {
  const id = "insitue-capture-hide";
  // Hide via attribute selector so we don't fight specific
  // implementations of the overlay layer.
  const style = document.createElement("style");
  style.id = id;
  style.textContent = `
    #insitue-root, [data-insitue-layer] { visibility: hidden !important; }
  `;
  document.head.appendChild(style);
  return () => {
    style.remove();
  };
}

interface DisplayMediaGrab {
  dataUrl: string;
  /** True if the stream was just granted in this call (vs cached). */
  fresh: boolean;
  /** Post-capture blank verdict — `getDisplayMedia` can return all-
   *  black under certain browser/OS conditions (Chrome on macOS
   *  Sonoma had a known case). Threaded through so the layer-2
   *  attempt outcome can be `"blank"` instead of false-positive
   *  `"success"`. */
  looksBlank: boolean;
  blankScore: number;
}

/** Grab a single frame from the tab-capture stream and crop to
 *  `cropRect`. Returns null if no stream, frame grab fails, or the
 *  user declines the permission. */
async function tryGrabViaDisplayMedia(
  cropRect: DOMRect,
  pixelRatio: number,
): Promise<DisplayMediaGrab | null> {
  const wasActive = displayMediaState.stream != null;
  const stream = await ensureDisplayMediaStream();
  if (!stream) return null;
  const fresh = !wasActive;
  bumpIdleTimer();

  // Hide our overlay so it doesn't appear in the captured frame.
  const restoreOverlay = hideOverlayLayersBriefly();
  // Yield one paint so the visibility change takes effect before
  // the frame grab fires. Two rAFs is paranoid but stable across
  // browsers.
  await new Promise<void>((r) =>
    requestAnimationFrame(() => requestAnimationFrame(() => r())),
  );

  try {
    const track = stream.getVideoTracks()[0];
    if (!track) return null;
    let bitmap: ImageBitmap | null = null;
    // ImageCapture is the cleanest path; fall back to a hidden
    // <video> + drawImage where the API isn't exposed (Safari, older
    // Firefox). ImageCapture isn't in lib.dom — feature-detect it.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const Ctor = (window as any).ImageCapture as
      | (new (track: MediaStreamTrack) => {
          grabFrame: () => Promise<ImageBitmap>;
        })
      | undefined;
    if (Ctor) {
      bitmap = await new Ctor(track).grabFrame();
    } else {
      bitmap = await grabFrameViaVideo(stream);
    }
    if (!bitmap) return null;

    // Stream resolution can differ from logical viewport pixels on
    // HiDPI displays. Convert viewport-coord `cropRect` to stream-
    // pixel coords using the actual frame size.
    const frameW = bitmap.width;
    const frameH = bitmap.height;
    const scaleX = frameW / window.innerWidth;
    const scaleY = frameH / window.innerHeight;
    const sx = Math.max(0, Math.round(cropRect.x * scaleX));
    const sy = Math.max(0, Math.round(cropRect.y * scaleY));
    const sw = Math.min(frameW - sx, Math.round(cropRect.width * scaleX));
    const sh = Math.min(frameH - sy, Math.round(cropRect.height * scaleY));

    const out = document.createElement("canvas");
    out.width = Math.max(1, Math.round(cropRect.width * pixelRatio));
    out.height = Math.max(1, Math.round(cropRect.height * pixelRatio));
    const ctx = out.getContext("2d");
    if (!ctx) return null;
    ctx.drawImage(bitmap, sx, sy, sw, sh, 0, 0, out.width, out.height);
    bitmap.close?.();
    const { looksBlank, blankScore } = looksBlankUniform(
      ctx,
      out.width,
      out.height,
    );
    return {
      dataUrl: out.toDataURL("image/png"),
      fresh,
      looksBlank,
      blankScore,
    };
  } finally {
    restoreOverlay();
  }
}

/** Fallback frame grab via a hidden `<video>` + `drawImage` for
 *  browsers without the `ImageCapture` API. */
async function grabFrameViaVideo(stream: MediaStream): Promise<ImageBitmap> {
  const video = document.createElement("video");
  video.srcObject = stream;
  video.muted = true;
  video.playsInline = true;
  video.style.position = "fixed";
  video.style.pointerEvents = "none";
  video.style.opacity = "0";
  video.style.width = "1px";
  video.style.height = "1px";
  document.body.appendChild(video);
  try {
    await video.play().catch(() => undefined);
    // Wait for a non-zero size before grabbing.
    await new Promise<void>((resolve, reject) => {
      const onReady = () => {
        video.removeEventListener("loadeddata", onReady);
        resolve();
      };
      video.addEventListener("loadeddata", onReady, { once: true });
      setTimeout(() => reject(new Error("video timeout")), 2_000);
    });
    const tmp = document.createElement("canvas");
    tmp.width = video.videoWidth;
    tmp.height = video.videoHeight;
    const ctx = tmp.getContext("2d");
    if (!ctx) throw new Error("no 2d ctx");
    ctx.drawImage(video, 0, 0);
    return await createImageBitmap(tmp);
  } finally {
    video.remove();
  }
}

// ---------------------------------------------------------------
// Lifecycle hooks — auto-stop the stream when the user leaves.

if (typeof window !== "undefined") {
  window.addEventListener("pagehide", () => stopDisplayMedia("pagehide"));
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
  const settings = getCaptureSettings();

  let screenshot: CaptureBundle["screenshot"];
  let screenshotUnavailable: string | undefined;
  let captureDiagnostics:
    | import("@insitue/capture-core").CaptureDiagnostics
    | undefined;

  // SVGElement gets the same path — without this, picking an SVG
  // node (e.g. an icon's <g>) silently produced a bundle with
  // neither `screenshot` nor `screenshotUnavailable` set.
  if (el instanceof HTMLElement || el instanceof SVGElement) {
    // 1. Compute crop region — context-sized, but CENTERED on the
    //    picked element. The previous implementation used the
    //    context-ancestor's own bounding rect as the crop, which
    //    drifted: if the ancestor was much larger than the picked
    //    element (an article wrapper containing a sub-paragraph div),
    //    the picked element ended up off-screen in the crop while
    //    the screenshot showed neighbouring content (a hero image,
    //    say). Reviewers couldn't tell what was actually clicked.
    //
    //    The fix: only the ancestor's SIZE informs the crop —
    //    "enough surrounding pixels to recognise the area" — and we
    //    always center on the picked element. The outline already
    //    applied at line ~887 then highlights the exact selection
    //    inside the rendered thumbnail.
    const pickedRect = el.getBoundingClientRect();
    const context = findContextAncestor(el);
    const ar = context.getBoundingClientRect();

    const MIN_W = 420;
    const MIN_H = 140;
    const cropW = Math.min(
      window.innerWidth,
      Math.max(MIN_W, ar.width, pickedRect.width),
    );
    const cropH = Math.min(
      window.innerHeight,
      Math.max(MIN_H, ar.height, pickedRect.height),
    );
    const pickedCx = pickedRect.x + pickedRect.width / 2;
    const pickedCy = pickedRect.y + pickedRect.height / 2;
    const cropX = Math.max(
      0,
      Math.min(window.innerWidth - cropW, pickedCx - cropW / 2),
    );
    const cropY = Math.max(
      0,
      Math.min(window.innerHeight - cropH, pickedCy - cropH / 2),
    );
    const cropRect = new DOMRect(cropX, cropY, cropW, cropH);

    // 2. Highlight the picked element so the reviewer can see exactly
    // what was selected within the surrounding context.
    const orig = {
      outline: el.style.outline,
      outlineOffset: el.style.outlineOffset,
    };
    el.style.outline = "3px solid #ff6b00";
    el.style.outlineOffset = "2px";

    // Per-layer attempt log (insitue#10) — every layer's outcome is
    // recorded for the diagnostics field, regardless of which one
    // ended up shipping. `attempts.find(a => a.layer === N)` reads
    // back like a slot.
    const attempts: import("@insitue/capture-core").CaptureLayerAttempt[] = [];
    const cropContent = inspectCropContent(cropRect);
    const elementBboxRaw = pickedRect;
    const pixelRatioUsed = Math.min(dpr, 1.5);
    let shippedBlankScore: number | undefined;
    let shippedLooksBlank = false;
    let failedImagesCount = 0;

    try {
      // 3. Decide which path to try first.
      //    - alwaysPixelPerfect setting → skip layer 1, go straight
      //      to display-media (if a stream is already active or the
      //      user explicitly opted in).
      //    - otherwise → layer 1 → assess → layer 2 if imperfect.
      const skipLayer1 = settings.alwaysPixelPerfect;

      let layer1Result: string | null = null;
      let layer1LooksBlank = false;
      let layer1BlankScore = 0;
      let quality: QualityAssessment | null = null;

      if (!skipLayer1) {
        const t0 = performance.now();
        try {
          const r = await renderViewportCrop(cropRect, pixelRatioUsed);
          const dur = performance.now() - t0;
          layer1Result = r.dataUrl;
          layer1LooksBlank = r.looksBlank;
          layer1BlankScore = r.blankScore;
          failedImagesCount = r.failedImages.size;
          quality = assessCaptureQuality(cropRect, r.failedImages);
          attempts.push({
            layer: 1,
            outcome: !r.dataUrl
              ? "error"
              : r.looksBlank
                ? "blank"
                : "success",
            durationMs: Math.round(dur),
            ...(!r.dataUrl ? { error: "renderViewportCrop returned null" } : {}),
          });
        } catch (e) {
          attempts.push({
            layer: 1,
            outcome: "error",
            durationMs: Math.round(performance.now() - t0),
            error: (e as Error).message,
          });
        }
      } else {
        attempts.push({ layer: 1, outcome: "skipped", durationMs: 0 });
      }

      const imperfect =
        !layer1Result ||
        layer1LooksBlank ||
        (quality != null &&
          (quality.unembeddableImages > 0 ||
            quality.hasVideo ||
            quality.hasCanvas));

      // `disableLayer2` — dev overlay sets this on mount. Layer-2
      // requires a tab-share permission prompt mid-flow, which is
      // hostile for the local agent loop. The SaaS widget keeps
      // layer-2 enabled (end-user bug reports need perfect pixels).
      const allowLayer2 = !settings.disableLayer2;

      if ((imperfect || skipLayer1) && allowLayer2) {
        // 4. Layer 2 — try `getDisplayMedia` for a pixel-perfect grab.
        const t0 = performance.now();
        let grab: DisplayMediaGrab | null = null;
        try {
          grab = await tryGrabViaDisplayMedia(cropRect, Math.min(dpr, 2));
          const dur = performance.now() - t0;
          attempts.push({
            layer: 2,
            outcome: !grab
              ? "error"
              : grab.looksBlank
                ? "blank"
                : "success",
            durationMs: Math.round(dur),
            ...(!grab ? { error: "getDisplayMedia returned null" } : {}),
          });
        } catch (e) {
          attempts.push({
            layer: 2,
            outcome: "error",
            durationMs: Math.round(performance.now() - t0),
            error: (e as Error).message,
          });
        }
        if (grab && !grab.looksBlank) {
          screenshot = {
            mime: "image/png",
            dataUrl: grab.dataUrl,
            bounds: {
              x: cropRect.x,
              y: cropRect.y,
              width: cropRect.width,
              height: cropRect.height,
            },
            source: "display-media",
          };
          shippedBlankScore = grab.blankScore;
          shippedLooksBlank = false;
        } else if (layer1Result) {
          // 5. Layer 3 — graceful degrade. Ship layer-1 result with
          // an honest qualityNote so the dashboard can surface it.
          // If layer-1 also looks blank, escalate the note rather
          // than silently shipping a blank thumbnail (insitue#10 fix).
          const reason = quality
            ? describeImperfection(quality)
            : "non-CORS content";
          const baseNote = `${reason} couldn't be embedded — grant tab capture for pixel-perfect screenshots`;
          const blankNote = layer1LooksBlank
            ? "captured image looks blank — likely an embed failure; grant tab capture for pixel-perfect screenshots"
            : null;
          screenshot = {
            mime: "image/png",
            dataUrl: layer1Result,
            bounds: {
              x: cropRect.x,
              y: cropRect.y,
              width: cropRect.width,
              height: cropRect.height,
            },
            source: "rasterise",
            qualityNote: blankNote ?? baseNote,
          };
          shippedBlankScore = layer1BlankScore;
          shippedLooksBlank = layer1LooksBlank;
        } else if (skipLayer1) {
          // Rasterise was deliberately skipped (alwaysPixelPerfect),
          // so the only failure mode here is the user declining the
          // tab-share prompt (or the browser not supporting it).
          // Reporting "rasterise failed" would be technically false
          // and reads as "the SDK is broken" — see #61.
          screenshotUnavailable = supportsDisplayMedia()
            ? "tab capture was declined — grant it for pixel-perfect screenshots, or turn off “Always pixel-perfect” in the gear to fall back to the rasterise path"
            : "tab capture unsupported in this browser — turn off “Always pixel-perfect” in the gear to fall back to the rasterise path";
        } else {
          // Layer 1 was attempted and produced nothing usable; layer 2
          // also declined or unsupported. Honest "both paths failed".
          screenshotUnavailable = supportsDisplayMedia()
            ? "rasterise failed — grant tab capture for pixel-perfect screenshots"
            : "rasterise failed and tab capture unsupported in this browser";
        }
      } else if (layer1Result) {
        // Layer 1 was clean — ship it, no escalation needed.
        // BUT if it looksBlank, surface that even when layer-2 is
        // disabled (dev/companion path). Better an honest qualityNote
        // than a silent blank thumbnail (insitue#10 fix).
        screenshot = {
          mime: "image/png",
          dataUrl: layer1Result,
          bounds: {
            x: cropRect.x,
            y: cropRect.y,
            width: cropRect.width,
            height: cropRect.height,
          },
          source: "rasterise",
          ...(layer1LooksBlank
            ? {
                qualityNote:
                  "captured image looks blank — embed step may have dropped the picked element; enable pixel-perfect in the gear to retry with tab capture",
              }
            : {}),
        };
        shippedBlankScore = layer1BlankScore;
        shippedLooksBlank = layer1LooksBlank;
      } else {
        screenshotUnavailable = "rasterise produced an empty image";
      }

      // Mark layers that were never considered as `skipped`. After
      // the dispatch above, exactly one of {1, 2} may still be
      // missing from `attempts`.
      if (!attempts.some((a) => a.layer === 2)) {
        attempts.push({ layer: 2, outcome: "skipped", durationMs: 0 });
      }
    } catch (err) {
      // Last-ditch — if something completely unexpected happened,
      // still ship the bundle without a screenshot rather than
      // failing the capture entirely.
      screenshotUnavailable =
        err instanceof Error
          ? `rasterise failed: ${err.message}`
          : "rasterise failed";
    } finally {
      el.style.outline = orig.outline;
      el.style.outlineOffset = orig.outlineOffset;
    }

    // Build the diagnostics record — runs whether the screenshot
    // landed or not. Strategy field is derived from which attempts
    // were recorded as success/blank (insitue#10).
    const succeeded = attempts.filter((a) => a.outcome === "success");
    const blanked = attempts.filter((a) => a.outcome === "blank");
    let strategy: import("@insitue/capture-core").CaptureDiagnostics["strategy"];
    const l1 = attempts.find((a) => a.layer === 1);
    const l2 = attempts.find((a) => a.layer === 2);
    if (
      l1 &&
      ["success", "blank"].includes(l1.outcome) &&
      l2?.outcome === "skipped"
    ) {
      strategy = "layer1-only";
    } else if (
      l2 &&
      ["success", "blank"].includes(l2.outcome) &&
      l1?.outcome === "skipped"
    ) {
      strategy = "layer2-only";
    } else if (succeeded.some((a) => a.layer === 2)) {
      strategy = "layer1-then-layer2";
    } else if (
      blanked.some((a) => a.layer === 2) &&
      succeeded.some((a) => a.layer === 1)
    ) {
      strategy = "layer1-degraded";
    } else if (succeeded.length === 0) {
      strategy = "both-failed";
    } else {
      strategy = "layer1-only";
    }
    captureDiagnostics = {
      strategy,
      attemptedLayers: attempts,
      shippedLooksBlank,
      ...(shippedBlankScore !== undefined ? { shippedBlankScore } : {}),
      cropRect: {
        x: Math.round(cropRect.x),
        y: Math.round(cropRect.y),
        width: Math.round(cropRect.width),
        height: Math.round(cropRect.height),
        outsideViewport:
          cropRect.x < 0 ||
          cropRect.y < 0 ||
          cropRect.x + cropRect.width > window.innerWidth ||
          cropRect.y + cropRect.height > window.innerHeight,
      },
      elementBbox: {
        x: Math.round(elementBboxRaw.x),
        y: Math.round(elementBboxRaw.y),
        width: Math.round(elementBboxRaw.width),
        height: Math.round(elementBboxRaw.height),
      },
      pixelRatioUsed,
      layer1FailedImages: failedImagesCount,
      hasVideoInCrop: cropContent.hasVideo,
      hasCanvasInCrop: cropContent.hasCanvas,
      hasIframeInCrop: cropContent.hasIframe,
      shadowDomDepthInCrop: cropContent.shadowDomDepth,
      browserUA:
        typeof navigator !== "undefined" ? navigator.userAgent.slice(0, 240) : "",
    };
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
    // "Never silent" — if neither screenshot nor screenshotUnavailable
    // got set above (an unexpected fallthrough), surface that fact
    // so the widget never renders a blank where a result should be.
    // The structured diagnostic below tells future-me exactly which
    // branch ran, surfaced as `__insitue_capture__.bundle` in dev.
    ...(screenshotUnavailable
      ? { screenshotUnavailable }
      : !screenshot
        ? {
            screenshotUnavailable: el
              ? `screenshot path didn't set a result (el=${el.tagName.toLowerCase()}; rasterisable=${
                  el instanceof HTMLElement || el instanceof SVGElement
                })`
              : "no element selected",
          }
        : {}),
    ...(captureDiagnostics ? { captureDiagnostics } : {}),
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
