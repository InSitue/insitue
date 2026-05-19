/**
 * Minimal `process.env` shim — the SDK is browser code but reads
 * `process.env.NODE_ENV`, which bundlers (Next/Vite/webpack) replace
 * statically. Avoids pulling Node globals into a browser package.
 */
declare const process: { env: Record<string, string | undefined> };
