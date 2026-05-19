/**
 * `process` is provided by `@types/node` (in tsconfig `types`).
 * Browser code only reads `process.env.NODE_ENV`, which bundlers
 * (Vite/Next/webpack) replace statically; `typeof process` guards the
 * Vite case where it's undefined at runtime. No declarations needed.
 */
export {};
