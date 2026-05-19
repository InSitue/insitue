import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { InSitue, InSitueCapture } from "@insitue/sdk";
import { App } from "./App.js";

// Dev → the full local agentic loop (companion). Production build →
// the M4 capture-only seam: the SAME bundle, no companion, delivered
// to a sink. `import.meta.env.PROD` is Vite's build-mode flag.
const prod = import.meta.env.PROD;

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
    {prod ? (
      <InSitueCapture
        onCapture={(draft, bundle) => {
          (window as unknown as Record<string, unknown>).__insitu_capture__ =
            { draft, bundle };
        }}
      />
    ) : (
      <InSitue />
    )}
  </StrictMode>,
);
