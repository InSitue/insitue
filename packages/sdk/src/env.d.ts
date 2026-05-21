/**
 * `process` is provided by `@types/node` (in tsconfig `types`).
 * Browser code only reads `process.env.NODE_ENV`, which bundlers
 * (Vite/Next/webpack) replace statically; `typeof process` guards the
 * Vite case where it's undefined at runtime. No declarations needed.
 */
declare global {
  /** Inlined by tsup `define` at build time from `package.json#version`. */
  const __SDK_VERSION__: string;
}

export {};
