/**
 * `<InSitue />` — the single dev-only import a host app adds (e.g. in
 * `app/layout.tsx`). Renders nothing into the host React tree; on
 * mount it lazily loads the Preact Shadow-DOM overlay. Double-guarded:
 * the host should also gate the import behind a dev check so the
 * overlay chunk never ships in a prod bundle.
 */
import { useEffect } from "react";
import type { CaptureBundle, IssueDraft } from "@insitue/capture-core";

export interface InSitueProps {
  /** Companion loopback port (default 5747). */
  port?: number;
}

export function InSitue({ port }: InSitueProps): null {
  useEffect(() => {
    // Bail only when explicitly a production build. `process` is
    // undefined in some bundlers (Vite) — treat unknown as dev so the
    // tool works everywhere; hosts still gate the import in prod.
    const nodeEnv =
      typeof process !== "undefined" ? process.env?.NODE_ENV : undefined;
    if (nodeEnv === "production") return;
    let active = true;
    let dispose: (() => void) | undefined;
    void import("./overlay.js").then((m) => {
      if (active) dispose = m.mountInSitue(port === undefined ? {} : { port });
    });
    return () => {
      active = false;
      dispose?.();
    };
  }, [port]);
  return null;
}

export interface InSitueCaptureProps {
  /**
   * Publishable project key (e.g. `pk_…`). When set, captures POST
   * to the InSitue cloud automatically. Origin-pinned + quota-gated
   * server-side, so safe to ship in your production bundle.
   */
  projectKey?: string;
  /** Override the ingest endpoint (default = InSitue cloud). */
  endpoint?: string;
  /**
   * Take over delivery yourself. Wins over `projectKey`. Default
   * (neither set): console + JSON download + `window.__insitu_capture__`.
   */
  onCapture?: (draft: IssueDraft, bundle: CaptureBundle) => void;
  /**
   * Default the user's "Always pixel-perfect screenshots" setting
   * to `true` on mount — every capture uses the `getDisplayMedia`
   * OS-compositor path, paying a one-time tab-share permission per
   * session in exchange for screenshots that are pixel-accurate
   * across any content (next/image, video, canvas, cross-origin).
   *
   * Recommended for dev / dogfood, where capture quality matters
   * more than the permission UX. Not the default — production
   * end-users shouldn't see a permission dialog they didn't ask for.
   */
  defaultPixelPerfect?: boolean;
}

/**
 * `<InSitueCapture />` — the prod capture-only path. UNLIKE
 * `<InSitue />` it does NOT bail in a production build: capture-only
 * is exactly what prod runs (no companion to refuse). It never touches
 * fs/agent/WS; the same bundle just flows to the configured sink.
 *
 * The simplest path: set `projectKey` and the SDK POSTs captures to
 * the InSitue cloud automatically.
 */
export function InSitueCapture({
  projectKey,
  endpoint,
  onCapture,
  defaultPixelPerfect,
}: InSitueCaptureProps): null {
  useEffect(() => {
    let active = true;
    let dispose: (() => void) | undefined;
    void import("./capture-only.js").then((m) => {
      if (active) {
        dispose = m.mountCaptureOnly({
          projectKey,
          endpoint,
          onCapture,
          defaultPixelPerfect,
        });
      }
    });
    return () => {
      active = false;
      dispose?.();
    };
  }, [projectKey, endpoint, onCapture, defaultPixelPerfect]);
  return null;
}
