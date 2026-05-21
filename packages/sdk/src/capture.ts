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
 *
 * See `~/.claude/plans/curious-waddling-milner.md` for the full
 * rationale + rejected alternatives.
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

// (preResolveImages removed 2026-05-21) — was meant to sidestep
// html-to-image's srcset / decode-race quirks by fetching imgs
// ourselves and swapping `.src` to a data URL before clone. In
// practice it:
//   1. Caused a visible page-image flash (the live `<img>`
//      momentarily showed the data URL load cycle).
//   2. Didn't actually fix next/image: html-to-image still
//      dropped the img because the underlying problem is layout
//      (position:absolute + aspect-ratio + object-fit:cover
//      inside foreignObject), not fetch.
// The right answer is `detectUnrenderedImages` + layer-2
// escalation: let html-to-image handle CORS-friendly imgs
// natively, detect when it silently dropped one (pixel sampling),
// auto-escalate to `getDisplayMedia` for pixel-perfect.

/** An element we can screenshot — has rect + inline style. Both
 *  HTMLElement and SVGElement (incl. SVGGElement, the "g" group)
 *  qualify; widening from HTMLElement-only fixes the silent-skip
 *  bug where picking an SVG node produced a bundle with neither
 *  `screenshot` nor `screenshotUnavailable` set. */
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
): Promise<{ dataUrl: string | null; failedImages: Set<HTMLImageElement> }> {
  const bodyBg = getComputedStyle(document.body).backgroundColor;
  const htmlBg = getComputedStyle(document.documentElement).backgroundColor;
  const backgroundColor =
    bodyBg && bodyBg !== "rgba(0, 0, 0, 0)" && bodyBg !== "transparent"
      ? bodyBg
      : htmlBg && htmlBg !== "rgba(0, 0, 0, 0)" && htmlBg !== "transparent"
        ? htmlBg
        : "#ffffff";

  // Trust html-to-image's built-in `embedImages` to handle CORS-
  // friendly imgs natively (it fetches + inlines as data URLs).
  // For imgs that fail to render anyway (next/image-style layout
  // breaks under foreignObject; placeholder fallbacks; etc.) we
  // catch them with `detectUnrenderedImages` post-render and route
  // through the layer-2 escalation. Never touches the live DOM, so
  // no visible page-image flash.
  const failedImages = new Set<HTMLImageElement>();
  const fullCanvas = await toCanvas(document.documentElement, {
    pixelRatio,
    cacheBust: true,
    backgroundColor,
    imagePlaceholder: IMAGE_PLACEHOLDER,
    filter: (n) =>
      !(
        n instanceof Element &&
        n.closest?.("#insitu-root, [data-insitu-layer]")
      ),
  });

  const sx = window.scrollX;
  const sy = window.scrollY;
  const out = document.createElement("canvas");
  out.width = Math.max(1, Math.round(cropRect.width * pixelRatio));
  out.height = Math.max(1, Math.round(cropRect.height * pixelRatio));
  const ctx = out.getContext("2d");
  if (!ctx) return { dataUrl: null, failedImages };
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
  if (looksBlankUniform(ctx, out.width, out.height)) {
    return { dataUrl: null, failedImages };
  }
  // Verify each <img> actually rendered. Pixel-sample where the
  // img's bbox should be; if uniformly filled, html-to-image
  // dropped it (next/image layout break, etc.) — flag for the
  // layer-2 escalation.
  detectUnrenderedImages(ctx, cropRect, out, pixelRatio, failedImages);
  return { dataUrl: out.toDataURL("image/png"), failedImages };
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
    (img) => !img.closest?.("#insitu-root, [data-insitu-layer]"),
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

/** Cheap blank-detection — sample 16 evenly spaced pixels; if they're
 *  all bytewise identical, the canvas is almost certainly a single-
 *  colour rectangle (silent rasterise failure). One-colour real UI
 *  is rare enough that a false positive here just escalates to the
 *  pixel-perfect path — not a regression. */
function looksBlankUniform(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
): boolean {
  if (w < 4 || h < 4) return false;
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
        return true;
      }
    }
  }
  return new Set(samples).size === 1;
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
      el.closest?.("#insitu-root, [data-insitu-layer]")
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
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        displaySurface: "browser",
      } as MediaTrackConstraints,
      audio: false,
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
  const id = "insitu-capture-hide";
  // Hide via attribute selector so we don't fight specific
  // implementations of the overlay layer.
  const style = document.createElement("style");
  style.id = id;
  style.textContent = `
    #insitu-root, [data-insitu-layer] { visibility: hidden !important; }
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
    // <video> + drawImage where the API isn't exposed.
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
    return { dataUrl: out.toDataURL("image/png"), fresh };
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

  // SVGElement gets the same path — the silent-skip on SVG picks
  // (e.g. an icon's <g>) was the "I see nothing" bug 2026-05-21.
  if (el instanceof HTMLElement || el instanceof SVGElement) {
    // 1. Compute crop region around a context-sized ancestor.
    const context = findContextAncestor(el);
    const cr = context.getBoundingClientRect();
    const cropRect = new DOMRect(
      Math.max(0, cr.x),
      Math.max(0, cr.y),
      Math.min(window.innerWidth, cr.right) - Math.max(0, cr.x),
      Math.min(window.innerHeight, cr.bottom) - Math.max(0, cr.y),
    );

    // 2. Highlight the picked element so the reviewer can see exactly
    // what was selected within the surrounding context.
    const orig = {
      outline: el.style.outline,
      outlineOffset: el.style.outlineOffset,
    };
    el.style.outline = "3px solid #ff6b00";
    el.style.outlineOffset = "2px";

    try {
      // 3. Decide which path to try first.
      //    - alwaysPixelPerfect setting → skip layer 1, go straight
      //      to display-media (if a stream is already active or the
      //      user explicitly opted in).
      //    - otherwise → layer 1 → assess → layer 2 if imperfect.
      const skipLayer1 = settings.alwaysPixelPerfect;

      let layer1Result: string | null = null;
      let quality: QualityAssessment | null = null;

      if (!skipLayer1) {
        const r = await renderViewportCrop(cropRect, Math.min(dpr, 1.5));
        layer1Result = r.dataUrl;
        quality = assessCaptureQuality(cropRect, r.failedImages);
      }

      const imperfect =
        !layer1Result ||
        (quality != null &&
          (quality.unembeddableImages > 0 ||
            quality.hasVideo ||
            quality.hasCanvas));

      if (imperfect || skipLayer1) {
        // 4. Layer 2 — try `getDisplayMedia` for a pixel-perfect grab.
        const grab = await tryGrabViaDisplayMedia(
          cropRect,
          Math.min(dpr, 2),
        );
        if (grab) {
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
        } else if (layer1Result) {
          // 5. Layer 3 — graceful degrade. Ship layer-1 result with
          // an honest qualityNote so the dashboard can surface it.
          const reason = quality
            ? describeImperfection(quality)
            : "non-CORS content";
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
            qualityNote: `${reason} couldn't be embedded — grant tab capture for pixel-perfect screenshots`,
          };
        } else {
          // Both paths failed — be honest.
          screenshotUnavailable = supportsDisplayMedia()
            ? "rasterise failed — grant tab capture for pixel-perfect screenshots"
            : "rasterise failed and tab capture unsupported in this browser";
        }
      } else if (layer1Result) {
        // Layer 1 was clean — ship it, no escalation needed.
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
        };
      } else {
        screenshotUnavailable = "rasterise produced an empty image";
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
    // branch ran, surfaced as `__insitu_capture__.bundle` in dev.
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
