import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { InSitu } from "@insitu/sdk";
import { App } from "./App.js";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
    {/* Dev example — InSitu mounts (bails only on an explicit prod build). */}
    <InSitu />
  </StrictMode>,
);
