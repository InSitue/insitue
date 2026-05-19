/**
 * SDK-side runtime collectors: small capped ring buffers for console,
 * failed/relevant network, and uncaught errors. Installed once on load
 * so a capture has recent context. Platform-neutral (no companion) so
 * a future extension/Electron vehicle reuses it unchanged.
 */
import type {
  ConsoleEntry,
  NetworkEntry,
  RuntimeError,
} from "@insitu/capture-core";

const CAP = 50;
const consoleBuf: ConsoleEntry[] = [];
const networkBuf: NetworkEntry[] = [];
const errorBuf: RuntimeError[] = [];
let installed = false;

function push<T>(buf: T[], item: T): void {
  buf.push(item);
  if (buf.length > CAP) buf.shift();
}

const SECRETISH = /(token|secret|key|password|authorization|bearer)/i;
function safeArg(a: unknown): string {
  try {
    const s = typeof a === "string" ? a : JSON.stringify(a);
    return SECRETISH.test(s) ? "[redacted]" : s.slice(0, 500);
  } catch {
    return String(a).slice(0, 500);
  }
}

export function installRuntimeCollectors(): void {
  if (installed || typeof window === "undefined") return;
  installed = true;

  for (const level of ["log", "info", "warn", "error", "debug"] as const) {
    const orig = console[level].bind(console);
    console[level] = (...args: unknown[]) => {
      push(consoleBuf, { level, args: args.map(safeArg), ts: Date.now() });
      orig(...args);
    };
  }

  const origFetch = window.fetch?.bind(window);
  if (origFetch) {
    window.fetch = async (...args: Parameters<typeof fetch>) => {
      const url = typeof args[0] === "string" ? args[0] : String(args[0]);
      const method = (args[1]?.method ?? "GET").toUpperCase();
      try {
        const res = await origFetch(...args);
        if (!res.ok) {
          push(networkBuf, {
            url,
            method,
            status: res.status,
            ok: false,
            ts: Date.now(),
          });
        }
        return res;
      } catch (e) {
        push(networkBuf, { url, method, ok: false, ts: Date.now() });
        throw e;
      }
    };
  }

  window.addEventListener("error", (e) => {
    push(errorBuf, {
      message: e.message,
      stack: e.error?.stack,
      ts: Date.now(),
    });
  });
  window.addEventListener("unhandledrejection", (e) => {
    push(errorBuf, {
      message: `unhandledrejection: ${String(e.reason)}`,
      ts: Date.now(),
    });
  });
}

/** Live count of captured uncaught errors — lets the overlay notice
 *  the host throwing right AFTER an apply (HMR settled into a break)
 *  without rebuilding a whole bundle. A real signal, not a guess. */
export function runtimeErrorCount(): number {
  return errorBuf.length;
}

export function runtimeSnapshot(): {
  console: ConsoleEntry[];
  network: NetworkEntry[];
  errors: RuntimeError[];
} {
  return {
    console: consoleBuf.slice(),
    network: networkBuf.slice(),
    errors: errorBuf.slice(),
  };
}
