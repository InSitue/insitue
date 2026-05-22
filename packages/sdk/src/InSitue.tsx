/**
 * `<InSitueCapture />` — the ONE InSitue widget. Same UI, two
 * sinks. Auto-detected:
 *
 *   - With `projectKey` set: ships captures to InSitue Cloud (the
 *     production reporter your end users see).
 *   - Without `projectKey`: ships captures to the local
 *     `@insitue/companion` over loopback WS. A `claude` session
 *     running `/insitue:connect` picks them up. (The "Dev mode"
 *     widget.)
 *
 * The picker, bundle shape, screenshot pipeline, and runtime
 * collectors are byte-identical between the two — the only fork
 * is the submit step.
 *
 * `<InSitue />` is exported as a thin alias for the dev-mode case
 * so existing imports keep working with a one-line behaviour
 * change: it mounts the same capture widget in companion-sink
 * mode. There is no longer a separate chat-style overlay.
 */
import { useEffect } from "react";
import type { CaptureBundle, IssueDraft } from "@insitue/capture-core";
import type { CaptureSink } from "./capture-only.js";

export interface InSitueCaptureProps {
  /**
   * Publishable project key (e.g. `pk_…`). When set, captures POST
   * to the InSitue cloud automatically. Origin-pinned + quota-gated
   * server-side, so safe to ship in your production bundle. Auto-
   * selects `sink: { kind: "cloud" }` unless `sink` is set
   * explicitly.
   */
  projectKey?: string;
  /** Override the ingest endpoint (cloud sink). */
  endpoint?: string;
  /**
   * Take over delivery yourself. Wins over `projectKey` AND
   * `sink`. Default (none set + no companion reachable): console +
   * JSON download + `window.__insitue_capture__`.
   */
  onCapture?: (draft: IssueDraft, bundle: CaptureBundle) => void;
  /**
   * Explicit sink override. Most callers leave this undefined and
   * rely on auto-detection (projectKey → cloud, otherwise →
   * companion).
   */
  sink?: CaptureSink;
  /**
   * Default the user's "Always pixel-perfect screenshots" setting
   * to `true` on mount — every capture uses `getDisplayMedia`,
   * paying a one-time tab-share permission per session in exchange
   * for screenshots that are pixel-accurate across any content
   * (next/image, video, canvas, cross-origin).
   *
   * Recommended for dev / dogfood; not for production end-users.
   */
  defaultPixelPerfect?: boolean;
}

/**
 * The canonical InSitue widget. Use this for both prod (with
 * `projectKey`) and dev (without). One mount, one component, the
 * UI and theme adapt to the sink.
 */
export function InSitueCapture({
  projectKey,
  endpoint,
  onCapture,
  sink,
  defaultPixelPerfect,
}: InSitueCaptureProps): null {
  useEffect(() => {
    let active = true;
    let dispose: (() => void) | undefined;
    void import("./capture-only.js").then((m) => {
      if (active) {
        dispose = m.mountCaptureOnly({
          ...(projectKey ? { projectKey } : {}),
          ...(endpoint ? { endpoint } : {}),
          ...(onCapture ? { onCapture } : {}),
          ...(sink ? { sink } : {}),
          ...(defaultPixelPerfect !== undefined ? { defaultPixelPerfect } : {}),
        });
      }
    });
    return () => {
      active = false;
      dispose?.();
    };
  }, [projectKey, endpoint, onCapture, sink, defaultPixelPerfect]);
  return null;
}

export interface InSitueProps {
  /**
   * Companion loopback port (default 5747). Only meaningful when
   * not also passing `projectKey` — when `projectKey` is set, the
   * widget ships to the cloud sink and this is ignored.
   */
  port?: number;
}

/**
 * `<InSitue />` — backward-compat dev alias.
 *
 * Equivalent to `<InSitueCapture sink={{ kind: "companion", port }} />`.
 * Kept so existing `<InSitue />` mounts (callers that imported the
 * pre-0.3.0 chat overlay) keep compiling. The behaviour is the
 * unified widget, NOT the removed chat overlay — the in-overlay
 * thread, diff display, and SESSION history are gone in 0.3.0.
 *
 * For new code, prefer `<InSitueCapture />`.
 */
export function InSitue({ port }: InSitueProps): null {
  useEffect(() => {
    const nodeEnv =
      typeof process !== "undefined" ? process.env?.NODE_ENV : undefined;
    if (nodeEnv === "production") return;
    let active = true;
    let dispose: (() => void) | undefined;
    void import("./capture-only.js").then((m) => {
      if (active) {
        dispose = m.mountCaptureOnly({
          sink: port === undefined
            ? { kind: "companion" }
            : { kind: "companion", port },
        });
      }
    });
    return () => {
      active = false;
      dispose?.();
    };
  }, [port]);
  return null;
}
