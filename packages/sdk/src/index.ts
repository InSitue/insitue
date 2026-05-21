/**
 * `@insitue/sdk` — the InSitue capture widget for browser apps.
 *
 * One component, two sinks. `<InSitueCapture />` is the canonical
 * mount; `<InSitue />` is a backward-compat dev alias (companion
 * sink). The chat-style overlay that existed pre-0.3.0 has been
 * removed in favour of the unified widget.
 */
export {
  InSitue,
  type InSitueProps,
  InSitueCapture,
  type InSitueCaptureProps,
} from "./InSitue.js";
export {
  mountCaptureOnly,
  type CaptureOnlyOptions,
  type CaptureSink,
} from "./capture-only.js";

/** Build-time-inlined version of `@insitue/sdk` (from package.json).
 *  Exposed so the host app can self-verify which SDK build is loaded
 *  — useful in dev when iterating across publishes. Also surfaced in
 *  the capture widget footer so a screenshot proves the build. */
export const SDK_VERSION: string = __SDK_VERSION__;
