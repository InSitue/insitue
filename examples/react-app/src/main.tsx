import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { InSitue, InSitueCapture } from "@insitue/sdk";
import { App } from "./App.js";

// Dev → the full local agentic loop via the companion. Production
// build → the capture-only path: same bundle, no companion, handed
// to a custom sink (here: stashed on `window` for inspection).
// `import.meta.env.PROD` is Vite's build-mode flag.
const prod = import.meta.env.PROD;

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
    {prod ? (
      <InSitueCapture
        onCapture={(draft, bundle) => {
          (window as unknown as Record<string, unknown>).__insitue_capture__ =
            { draft, bundle };
        }}
      />
    ) : (
      <InSitue />
    )}
  </StrictMode>,
);
