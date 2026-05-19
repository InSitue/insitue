/**
 * `<InSitu />` — the single dev-only import a host app adds (e.g. in
 * `app/layout.tsx`). Renders nothing into the host React tree; on
 * mount it lazily loads the Preact Shadow-DOM overlay. Double-guarded:
 * the host should also gate the import behind a dev check so the
 * overlay chunk never ships in a prod bundle.
 */
import { useEffect } from "react";

export interface InSituProps {
  /** Companion loopback port (default 5747). */
  port?: number;
}

export function InSitu({ port }: InSituProps): null {
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
      if (active) dispose = m.mountInSitu(port === undefined ? {} : { port });
    });
    return () => {
      active = false;
      dispose?.();
    };
  }, [port]);
  return null;
}
