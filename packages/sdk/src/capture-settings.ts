/**
 * Tiny session-scoped capture settings store. Persisted to
 * `localStorage` under a host-bucketed key so the same flag follows
 * the user across reloads on the same site but doesn't leak between
 * apps (the user may want pixel-perfect mode on app A but not B).
 *
 * Why its own module: `capture.ts` is the path that reads the flag
 * on every capture; `overlay.ts` is the path that writes it from
 * the gear-settings toggle. Sharing through a third file keeps the
 * dependency direction clean (overlay → settings; capture →
 * settings) without overlay needing to import capture.
 */

export interface CaptureSettings {
  /** When true: skip the html-to-image layer-1 path entirely and
   *  always use `getDisplayMedia` for pixel-perfect captures.
   *  Default false — most pages render perfectly via layer 1, so we
   *  only pay the permission prompt when needed. */
  alwaysPixelPerfect: boolean;
}

const DEFAULT_SETTINGS: CaptureSettings = {
  alwaysPixelPerfect: false,
};

function storageKey(): string {
  if (typeof location === "undefined") return "insitu:capture-settings";
  return `insitu:capture-settings:${location.host}`;
}

let cached: CaptureSettings | null = null;

export function getCaptureSettings(): CaptureSettings {
  if (cached) return cached;
  if (typeof localStorage === "undefined") {
    cached = { ...DEFAULT_SETTINGS };
    return cached;
  }
  try {
    const raw = localStorage.getItem(storageKey());
    if (!raw) {
      cached = { ...DEFAULT_SETTINGS };
      return cached;
    }
    const parsed = JSON.parse(raw) as Partial<CaptureSettings>;
    cached = { ...DEFAULT_SETTINGS, ...parsed };
    return cached;
  } catch {
    cached = { ...DEFAULT_SETTINGS };
    return cached;
  }
}

export function setCaptureSettings(patch: Partial<CaptureSettings>): void {
  const next = { ...getCaptureSettings(), ...patch };
  cached = next;
  if (typeof localStorage !== "undefined") {
    try {
      localStorage.setItem(storageKey(), JSON.stringify(next));
    } catch {
      // Quota / disabled storage — settings just don't persist.
    }
  }
  for (const l of listeners) l(next);
}

type Listener = (s: CaptureSettings) => void;
const listeners = new Set<Listener>();
export function onCaptureSettingsChange(l: Listener): () => void {
  listeners.add(l);
  l(getCaptureSettings());
  return () => listeners.delete(l);
}
