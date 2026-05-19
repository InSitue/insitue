/**
 * Capture-only mount — the PROD seam (M4: validated, deliberately not
 * shipped as a product). NO companion, NO WebSocket, NO fs/agent, and
 * NO prod-build refusal: it builds the exact same `CaptureBundle` the
 * local loop does and hands it to an `IssueTrackerSink`. This proves
 * "local agentic edit → prod capture-only" is a sink swap, not a
 * rewrite — the bundle/picker/runtime code is reused verbatim.
 */
import { h, render } from "preact";
import { useState } from "preact/hooks";
import {
  IssueTrackerSink,
  type CaptureBundle,
  type IssueDraft,
} from "@insitue/capture-core";
import { installRuntimeCollectors } from "./runtime.js";
import { beginPick } from "./picker.js";
import { buildBundle } from "./capture.js";

export interface CaptureOnlyOptions {
  /** Where the draft goes. Default: console + a JSON download +
   *  `window.__insitu_capture__` (handy for prod validation). */
  onCapture?: (draft: IssueDraft, bundle: CaptureBundle) => void;
}

const mono = "12px ui-monospace, SFMono-Regular, Menlo, monospace";
const muted = "#8a8a93";

function defaultDeliver(draft: IssueDraft): void {
  (globalThis as Record<string, unknown>).__insitu_capture__ = {
    title: draft.title,
    body: draft.body,
    bundle: draft.bundle,
  };
  // eslint-disable-next-line no-console
  console.info("[insitu] capture-only draft:", draft.title);
  try {
    const blob = new Blob([JSON.stringify(draft, null, 2)], {
      type: "application/json",
    });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `insitu-capture-${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  } catch {
    /* download is best-effort; the window hook is the contract */
  }
}

function CaptureOnlyApp(props: { onCapture?: CaptureOnlyOptions["onCapture"] }) {
  const [busy, setBusy] = useState(false);
  const [last, setLast] = useState("");

  const sink = new IssueTrackerSink((draft) => {
    if (props.onCapture) props.onCapture(draft, draft.bundle);
    else defaultDeliver(draft);
    setLast(draft.title);
  });

  const pick = async () => {
    setBusy(true);
    try {
      const sel = await beginPick("element");
      if (!sel) return;
      const bundle = await buildBundle(sel);
      await sink.submit(bundle);
    } finally {
      setBusy(false);
    }
  };

  return h(
    "div",
    {
      style: `position:fixed;bottom:16px;right:16px;z-index:2147483000;display:flex;gap:10px;align-items:center;padding:8px 12px;font:${mono};color:#ececef;background:rgba(15,15,18,0.94);border:1px solid #2e2e3c;border-radius:6px`,
    },
    [
      h("strong", { style: "letter-spacing:0.08em" }, "InSitue"),
      h("span", { style: `color:${muted}` }, "capture-only"),
      h(
        "button",
        {
          disabled: busy,
          onClick: () => void pick(),
          style:
            "font:inherit;color:#ff6b00;background:transparent;border:1px solid #2e2e3c;border-radius:4px;padding:3px 8px;cursor:pointer",
        },
        busy ? "…" : "Capture",
      ),
      last
        ? h(
            "span",
            {
              style: `color:${muted};max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap`,
            },
            last,
          )
        : null,
    ],
  );
}

export function mountCaptureOnly(opts: CaptureOnlyOptions = {}): () => void {
  installRuntimeCollectors();
  const host = document.createElement("div");
  host.id = "insitu-capture-root";
  host.setAttribute("data-insitu", "");
  document.body.appendChild(host);
  const shadow = host.attachShadow({ mode: "open" });
  const mount = document.createElement("div");
  shadow.appendChild(mount);
  render(
    h(CaptureOnlyApp, opts.onCapture ? { onCapture: opts.onCapture } : {}),
    mount,
  );
  return () => {
    render(null, mount);
    host.remove();
  };
}
