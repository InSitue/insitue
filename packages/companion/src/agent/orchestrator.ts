// Shim: the engine lives in @insitu/agent-core (C0 extraction). This
// re-export keeps companion's import paths + built dist layout stable
// so server.ts and the 31 regression tests are byte-unchanged.
export * from "@insitu/agent-core/orchestrator";
