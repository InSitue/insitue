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
  placeholderMeta: PlaceholderMeta,
): Promise<{
  dataUrl: string | null;
  /** True when the rasterised canvas's 16-pixel sample grid hit a
   *  single colour. */
  looksBlank: boolean;
  /** 0..1 — fraction of the sample grid hitting the most-common
   *  pixel. 1.0 = `looksBlank: true`. */
  blankScore: number;
  failedImages: Set<HTMLImageElement>;
  /** When set, the screenshot ISN'T an actual rasterise — it's the
   *  "selection captured" placeholder. Two trigger paths:
   *    - "rasterise-error": html-to-image threw on both attempts.
   *    - "looks-blank": rasterise succeeded but the sample grid was
   *      bytewise uniform (e.g. case 4 — CSS bg-image that html-to-
   *      image silently drops, leaving a solid fill). */
  placeholderReason?: "rasterise-error" | "looks-blank";
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
  //
  //    `toCanvas` can throw for many reasons — most commonly an
  //    `<img>` load failure inside the foreignObject pipeline
  //    rejects with an Event (NOT an Error), which cascades up and
  //    aborts the whole render. One unloadable image on the page
  //    kills every capture. The widget's core flow CAN'T have that
  //    failure mode (insitue#10 / 0.5.0).
  //
  //    Two-tier retry:
  //    a) Full render with image embedding — happy path, best
  //       fidelity.
  //    b) If (a) throws: retry with all `<img>` and `<svg>` images
  //       filtered out. Loses the bitmaps but keeps layout, colors,
  //       backgrounds, text — far more useful than a placeholder.
  //       The drawAbsoluteImagesOnto step below layers images back
  //       in directly from the live page (CORS-friendly only).
  //    c) If (b) also throws: paint a labeled placeholder so the
  //       bundle still ships *something* (handled outside this fn).
  // CRITICAL: `cacheBust: false`. html-to-image's cacheBust appends
  // `?t=<timestamp>` to every image URL — which BREAKS `data:` URLs
  // (they don't accept query params). One data-URL img on the page
  // (including our own `IMAGE_PLACEHOLDER`) makes the whole render
  // throw a `<img>.onerror` Event. Discovered in dogfood with the
  // stress page's `data:image/svg+xml` hero img. We don't need
  // cache busting in a one-shot capture anyway — the browser's
  // HTTP cache is exactly what we want to read from.
  let fullCanvas: HTMLCanvasElement | null = null;
  let htiError: Error | null = null;
  // Defensive filter — see `shouldSkipForHti` below for the
  // enumerated reasons. ONE problematic element on the page
  // (e.g. a `<video>` with no src AND no poster) kills the entire
  // html-to-image render via internal `resourceToDataURL("")` →
  // fetch(page) → `<img>.src = data:text/html;base64,<page HTML>` →
  // load fails → entire toCanvas rejects. We filter those out
  // upfront so the render always succeeds.
  const filterForHtmlToImage = (n: Node): boolean => {
    if (
      n instanceof Element &&
      n.closest?.("#insitue-root, [data-insitue-layer]")
    ) {
      return false;
    }
    return !shouldSkipForHti(n);
  };
  try {
    fullCanvas = await toCanvas(document.body, {
      pixelRatio,
      cacheBust: false,
      backgroundColor,
      imagePlaceholder: IMAGE_PLACEHOLDER,
      filter: filterForHtmlToImage,
    });
  } catch (e) {
    htiError = describeHtmlToImageError(e);
    // eslint-disable-next-line no-console
    console.warn(
      "[insitue] html-to-image full render failed, retrying without imgs:",
      htiError.message,
    );
    // Mutate the live DOM: replace every <img>.src with a
    // 1×1 transparent PNG before rendering, then restore after.
    // html-to-image's filter doesn't reliably skip the embed step;
    // the only sure way to avoid `<img>.onerror` is to make every
    // src trivially loadable. drawAbsoluteImagesOnto layers the
    // real bitmaps back in afterwards.
    const TRANSPARENT_PNG =
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";
    const imgs = Array.from(document.querySelectorAll("img"));
    const originals = imgs.map((i) => i.getAttribute("src"));
    try {
      for (const img of imgs) img.setAttribute("src", TRANSPARENT_PNG);
      fullCanvas = await toCanvas(document.body, {
        pixelRatio,
        cacheBust: false,
        backgroundColor,
        imagePlaceholder: IMAGE_PLACEHOLDER,
        filter: filterForHtmlToImage,
      });
      htiError = null;
    } catch (e2) {
      htiError = describeHtmlToImageError(e2);
      // eslint-disable-next-line no-console
      console.error(
        "[insitue] html-to-image both attempts failed:",
        htiError.message,
      );
    } finally {
      // Always restore — never leave the page in a degraded state.
      for (let i = 0; i < imgs.length; i++) {
        const orig = originals[i];
        if (orig == null) imgs[i]!.removeAttribute("src");
        else imgs[i]!.setAttribute("src", orig);
      }
    }
  }

  if (!fullCanvas) {
    // html-to-image gave up. Paint the "selection captured"
    // placeholder onto the out canvas so the bundle ships a clean
    // confirmation card rather than nothing.
    paintCapturePlaceholder(ctx, out.width, out.height, placeholderMeta);
    return {
      dataUrl: out.toDataURL("image/png"),
      looksBlank: false,
      blankScore: 0,
      failedImages,
      placeholderReason: "rasterise-error",
    };
  }

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

  // Fully-uniform raster — html-to-image returned bytes but every
  // sample is bytewise identical. Two possibilities:
  //   a) Render-fail: the element painted nothing, so we're seeing
  //      the page background bleeding through (case 4: bg-image
  //      dropped, surface is the white body bg).
  //   b) Legitimate uniform content: a solid-colour `<img>`, a
  //      flat-painted card, a green tile.
  //
  // Differentiate by comparing the uniform fill to the resolved
  // page background. If they match → render-fail → swap in the
  // "Selection captured" card. If they don't → the pixels ARE the
  // content (even if uniform) → ship as-is.
  //
  // IMG / CANVAS / VIDEO get an additional escape (the
  // `canBeUniformContent` flag) so legitimate solid-colour media
  // never gets misread as a fail.
  if (
    looksBlank &&
    !placeholderMeta.canBeUniformContent &&
    sampledFillMatchesBackground(ctx, out.width, out.height, backgroundColor)
  ) {
    paintCapturePlaceholder(ctx, out.width, out.height, placeholderMeta);
    return {
      dataUrl: out.toDataURL("image/png"),
      looksBlank,
      blankScore,
      failedImages,
      placeholderReason: "looks-blank",
    };
  }

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
/** Enumerated elements that, if left in the DOM, will reliably break
 *  html-to-image's render with no useful error message. We filter
 *  these out upfront so the screenshot ALWAYS lands.
 *
 *  Confirmed cases:
 *
 *  - **`<video>` with no `src` AND no `poster`** — `cloneVideoElement`
 *    falls through to `resourceToDataURL("", "", options)`, which does
 *    `fetch("")` which resolves to the current page URL. The browser
 *    returns the page HTML with `content-type: text/html`. html-to-
 *    image base64-encodes it as `data:text/html;base64,<page HTML>` and
 *    assigns to its internal `<img>.src`. The img can't load HTML →
 *    rejects with an onerror Event → entire toCanvas throws.
 *    Confirmed in dogfood with the stress page; reproducible in
 *    isolation with `<video></video>` on any page.
 *
 *  Add more entries here as we find them — each one with a comment
 *  explaining the failure mode. Better to filter known-broken
 *  elements out than ship a generic try/catch that hides bugs. */
function shouldSkipForHti(n: Node): boolean {
  if (n instanceof HTMLVideoElement) {
    const hasSrc = !!(n.currentSrc || n.src);
    const hasPoster = !!n.poster;
    if (!hasSrc && !hasPoster) return true;
  }
  return false;
}

/** Stringify whatever html-to-image (and its foreignObject pipeline)
 *  rejected with. The most common failure is an `<img>.onerror` event
 *  bubbling up — that's an `Event` object, not an Error. Default
 *  string-coercion gives the useless `[object Event]`. Pull out the
 *  target's tag + src so the qualityNote is actually actionable.
 *  (insitue#10 — dogfood found `screenshot couldn't be rendered:
 *  [object Event]` shipped in real captures.) */
function describeHtmlToImageError(e: unknown): Error {
  if (e instanceof Error) return e;
  if (typeof Event !== "undefined" && e instanceof Event) {
    const t = e.target as
      | (HTMLElement & { src?: string; href?: string })
      | null;
    const tag = t?.tagName?.toLowerCase();
    const src =
      (t && "src" in t && t.src) ||
      (t && "href" in t && (t as unknown as { href?: string }).href) ||
      "";
    const where = tag
      ? src
        ? `<${tag}> failed to load (${truncate(src, 120)})`
        : `<${tag}> emitted ${e.type}`
      : `resource emitted ${e.type}`;
    return new Error(where);
  }
  // Some libs reject with a string or arbitrary object.
  if (typeof e === "string") return new Error(e);
  if (e && typeof e === "object" && "message" in e) {
    return new Error(String((e as { message: unknown }).message));
  }
  return new Error(`unknown rejection: ${Object.prototype.toString.call(e)}`);
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

/** Paint the "selection captured" placeholder. Replaces the actual
 *  screenshot when either html-to-image gave up entirely OR the
 *  shipped raster sampled as fully uniform (the failure mode behind
 *  case 4 in the stress page: CSS bg-images that html-to-image can't
 *  embed render as solid background colour, which technically returns
 *  bytes but visually communicates nothing).
 *
 *  Designed to read as a confirmation card — light surface, the
 *  picked element's tag chip top-left, a centered reassurance, and
 *  the selector + dimensions in mono below. The reviewer should know
 *  immediately that the right element was captured, even though the
 *  bitmap couldn't be rasterised. (Design benchmark: Vercel/Linear/
 *  Resend — restrained, hierarchical, never apologetic.) */
function paintCapturePlaceholder(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  meta: PlaceholderMeta,
): void {
  // Base surface — neutral light. Reads cleanly inside both the
  // companion sink's dark compose panel and the cloud sink's white
  // card.
  const surface = "#fafafa";
  const border = "#e7e7ea";
  const ink = "#16161a";
  const sub = "#6b6c77";
  const faint = "#a3a3ac";
  const brand = "#ff6b00";
  const sans = '-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif';
  const mono = '"SF Mono", ui-monospace, Menlo, Consolas, monospace';

  ctx.fillStyle = surface;
  ctx.fillRect(0, 0, w, h);

  // Inset stroke — single hairline, hugs the canvas edge.
  ctx.strokeStyle = border;
  ctx.lineWidth = 1;
  ctx.strokeRect(0.5, 0.5, w - 1, h - 1);

  // Scale-aware type ramp. Anchored on the smaller dimension so a
  // tall narrow crop and a short wide crop both look balanced. Clamps
  // keep things legible on extreme sizes.
  const base = Math.min(w, h);
  const headlinePx = Math.max(14, Math.min(20, Math.round(base / 12)));
  const subPx = Math.max(11, Math.min(14, Math.round(headlinePx * 0.78)));
  const monoPx = Math.max(10, Math.min(13, Math.round(headlinePx * 0.72)));
  const chipTextPx = Math.max(9, Math.min(11, Math.round(headlinePx * 0.6)));
  const pad = Math.max(14, Math.round(base / 14));

  // Top-left: brand dot + uppercase tag chip.
  const dotR = Math.max(3, Math.round(chipTextPx * 0.42));
  const dotX = pad + dotR;
  const dotY = pad + dotR;
  ctx.fillStyle = brand;
  ctx.beginPath();
  ctx.arc(dotX, dotY, dotR, 0, Math.PI * 2);
  ctx.fill();

  ctx.font = `600 ${chipTextPx}px ${mono}`;
  ctx.fillStyle = ink;
  ctx.textBaseline = "middle";
  ctx.textAlign = "left";
  ctx.fillText(meta.tag.toUpperCase(), dotX + dotR + 8, dotY + 0.5);

  // Centered cluster: headline + reassurance + selector + dims.
  ctx.textAlign = "center";
  ctx.textBaseline = "alphabetic";

  // Gap between lines, scaled to headline.
  const gap = Math.round(headlinePx * 0.55);
  const monoGap = Math.round(monoPx * 0.5);

  // Total cluster height for vertical centering.
  const clusterH = headlinePx + gap + subPx + gap * 2 + monoPx + monoGap + monoPx;
  let y = Math.round((h - clusterH) / 2 + headlinePx);

  ctx.font = `600 ${headlinePx}px ${sans}`;
  ctx.fillStyle = ink;
  ctx.fillText("Selection captured", w / 2, y);

  y += gap + subPx;
  ctx.font = `400 ${subPx}px ${sans}`;
  ctx.fillStyle = sub;
  ctx.fillText("This is the element you picked.", w / 2, y);

  y += gap * 2 + monoPx;
  ctx.font = `500 ${monoPx}px ${mono}`;
  ctx.fillStyle = sub;
  const selectorText = truncateForWidth(
    ctx,
    meta.selector,
    w - pad * 2,
  );
  ctx.fillText(selectorText, w / 2, y);

  y += monoGap + monoPx;
  ctx.font = `400 ${monoPx}px ${mono}`;
  ctx.fillStyle = faint;
  ctx.fillText(
    `${meta.widthPx} × ${meta.heightPx} @ ${meta.dpr}x`,
    w / 2,
    y,
  );
}

/** Trim a string with an ellipsis until it fits the given pixel
 *  width under the current ctx font. Used for long selectors. */
function truncateForWidth(
  ctx: CanvasRenderingContext2D,
  text: string,
  maxWidth: number,
): string {
  if (ctx.measureText(text).width <= maxWidth) return text;
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = Math.floor((lo + hi + 1) / 2);
    if (ctx.measureText(text.slice(0, mid) + "…").width <= maxWidth) lo = mid;
    else hi = mid - 1;
  }
  return text.slice(0, lo) + "…";
}

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

/** Metadata about the picked element, threaded into the placeholder
 *  painter so the placeholder reads as a confirmation card ("we got
 *  the right element, here's its tag/selector/size") rather than an
 *  error. Built in `buildBundle` from `el` + selector helper. */
export interface PlaceholderMeta {
  tag: string;
  selector: string;
  widthPx: number;
  heightPx: number;
  dpr: number;
  /** True for IMG / CANVAS / VIDEO — elements where uniform pixels
   *  are legitimately content (a solid-colour image, a blank
   *  canvas, a single-frame video) rather than a render-fail signal.
   *  Suppresses the `looks-blank → placeholder` swap so the actual
   *  captured pixels ship through. Rasterise-error swap still fires
   *  regardless. */
  canBeUniformContent: boolean;
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
/** True when the canvas's centre pixel matches the resolved page
 *  background colour — the signal we use to distinguish "render
 *  failed and we're seeing the page bg" from "uniform pixels are
 *  legitimate content (a solid-colour card)."
 *
 *  Parses the CSS background colour string (e.g. `rgb(255, 255, 255)`)
 *  into [r,g,b,a], then compares with a tolerance of ±6 per channel
 *  to absorb tiny sub-pixel rasterisation drift. */
function sampledFillMatchesBackground(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  bg: string,
): boolean {
  const bgRgba = parseCssRgba(bg);
  if (!bgRgba) return false;
  try {
    const px = ctx.getImageData(Math.floor(w / 2), Math.floor(h / 2), 1, 1)
      .data;
    const dr = Math.abs(px[0]! - bgRgba[0]);
    const dg = Math.abs(px[1]! - bgRgba[1]);
    const db = Math.abs(px[2]! - bgRgba[2]);
    return dr <= 6 && dg <= 6 && db <= 6;
  } catch {
    return false;
  }
}

/** Best-effort parse of a CSS colour string (`rgb(…)`, `rgba(…)`,
 *  `#rrggbb`, `#rgb`) into [r,g,b,a]. Returns null on anything
 *  exotic — caller treats that as "can't compare, ship as-is". */
function parseCssRgba(s: string): [number, number, number, number] | null {
  const m = s.match(/^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+))?\s*\)$/i);
  if (m) {
    return [
      Number(m[1]),
      Number(m[2]),
      Number(m[3]),
      m[4] != null ? Math.round(Number(m[4]) * 255) : 255,
    ];
  }
  const hex = s.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (hex) {
    const h = hex[1]!;
    if (h.length === 3) {
      return [
        parseInt(h[0]! + h[0]!, 16),
        parseInt(h[1]! + h[1]!, 16),
        parseInt(h[2]! + h[2]!, 16),
        255,
      ];
    }
    return [
      parseInt(h.slice(0, 2), 16),
      parseInt(h.slice(2, 4), 16),
      parseInt(h.slice(4, 6), 16),
      255,
    ];
  }
  return null;
}

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

    // Build the placeholder card metadata up-front so the painter
    // has tag + selector + dimensions ready if it needs to swap.
    const placeholderMeta: PlaceholderMeta = {
      tag: el.tagName.toLowerCase(),
      selector: buildSelector(el),
      widthPx: Math.round(pickedRect.width),
      heightPx: Math.round(pickedRect.height),
      dpr: Math.round(dpr * 10) / 10,
      canBeUniformContent:
        el instanceof HTMLImageElement ||
        el instanceof HTMLCanvasElement ||
        el instanceof HTMLVideoElement ||
        el instanceof SVGElement,
    };

    try {
      // Single capture path: html-to-image rasterise of the full
      // document, cropped to the picked element's surroundings.
      // No permission prompts, no fallback chains, no escalation.
      // When html-to-image can't faithfully capture a region
      // (video frames, canvas pixels, cross-origin iframe content,
      // non-CORS images) the manual-overlay path inside
      // renderViewportCrop paints an explicit placeholder so the
      // user always sees SOMETHING shaped like their selection —
      // never a silent blank.
      const t0 = performance.now();
      try {
        const r = await renderViewportCrop(
          cropRect,
          pixelRatioUsed,
          placeholderMeta,
        );
        const dur = performance.now() - t0;
        failedImagesCount = r.failedImages.size;
        const quality = assessCaptureQuality(cropRect, r.failedImages);
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
        if (r.dataUrl) {
          // `placeholderReason` set ⇒ we shipped the "selection
          // captured" card instead of the raster (either html-to-
          // image threw, or the raster came back fully uniform).
          // The card itself carries the message; the qualityNote
          // gives the reviewer one short reassuring line.
          const qualityNote = r.placeholderReason
            ? "Element selection confirmed — describe what to change below."
            : quality.unembeddableImages > 0 ||
                quality.hasVideo ||
                quality.hasCanvas
              ? `${describeImperfection(quality)} couldn't be embedded — those regions are shown as placeholders in the screenshot`
              : undefined;
          screenshot = {
            mime: "image/png",
            dataUrl: r.dataUrl,
            bounds: {
              x: cropRect.x,
              y: cropRect.y,
              width: cropRect.width,
              height: cropRect.height,
            },
            source: "rasterise",
            ...(qualityNote ? { qualityNote } : {}),
          };
          shippedBlankScore = r.blankScore;
          shippedLooksBlank = r.looksBlank;
        } else {
          screenshotUnavailable =
            "rasterise produced no output — the picked region may be empty or the renderer failed";
        }
      } catch (e) {
        attempts.push({
          layer: 1,
          outcome: "error",
          durationMs: Math.round(performance.now() - t0),
          error: (e as Error).message,
        });
        screenshotUnavailable =
          e instanceof Error ? `rasterise failed: ${e.message}` : "rasterise failed";
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
    // landed or not. After the layer-2 removal, strategy is always
    // `layer1-only` (success branch) or `both-failed` (when the
    // single attempt errored / returned nothing). Kept as a field
    // so existing receivers stay backwards-compatible.
    const l1 = attempts.find((a) => a.layer === 1);
    const strategy: import("@insitue/capture-core").CaptureDiagnostics["strategy"] =
      l1 && (l1.outcome === "success" || l1.outcome === "blank")
        ? "layer1-only"
        : "both-failed";
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
