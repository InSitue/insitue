export {
  InSitue,
  type InSitueProps,
  InSitueCapture,
  type InSitueCaptureProps,
} from "./InSitue.js";
export { mountInSitue, type InSitueOptions } from "./overlay.js";
export {
  mountCaptureOnly,
  type CaptureOnlyOptions,
} from "./capture-only.js";

/** Build-time-inlined version of `@insitue/sdk` (from package.json).
 *  Exposed so the host app can self-verify which SDK build is loaded
 *  — useful in dev when iterating across publishes. Also surfaced in
 *  the capture widget footer so a screenshot proves the build. */
export const SDK_VERSION: string = __SDK_VERSION__;
