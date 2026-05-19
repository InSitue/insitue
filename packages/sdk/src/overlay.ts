/**
 * The overlay: Preact in a Shadow DOM (style-isolated from the host).
 * M1 — connect, pick a region/element, build a CaptureBundle, submit
 * it, and render the bundle + the companion's resolved source span.
 */
import { h, render } from "preact";
import { useEffect, useState } from "preact/hooks";
import type { CaptureBundle, ResolvedSource } from "@insitu/capture-core";
import { CompanionClient, type ConnState } from "./client.js";
import { installRuntimeCollectors } from "./runtime.js";
import { beginPick } from "./picker.js";
import { buildBundle } from "./capture.js";

export interface InSituOptions {
  port?: number;
}

const DOT: Record<ConnState, string> = {
  idle: "#888",
  connecting: "#e0a30c",
  connected: "#2fd16b",
  error: "#ff6b6b",
};
const muted = "#8a8a93";
const mono = "12px ui-monospace, SFMono-Regular, Menlo, monospace";

function row(label: string, value: string) {
  return h("div", { style: "display:flex;gap:8px;margin:2px 0" }, [
    h("span", { style: `color:${muted};min-width:96px` }, label),
    h("span", { style: "color:#ececef;word-break:break-word" }, value),
  ]);
}

function App(props: { port: number }) {
  const [state, setState] = useState<ConnState>("idle");
  const [detail, setDetail] = useState("");
  const [client, setClient] = useState<CompanionClient | null>(null);
  const [bundle, setBundle] = useState<CaptureBundle | null>(null);
  const [resolved, setResolved] = useState<ResolvedSource | null>(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    installRuntimeCollectors();
    const c = new CompanionClient(props.port, {
      onState: (s, d) => {
        setState(s);
        if (d !== undefined) setDetail(d);
      },
      onResolved: (_id, r, n) => {
        setResolved(r);
        setNote(n);
      },
    });
    setClient(c);
    void c.connect();
    return () => c.dispose();
  }, [props.port]);

  const pick = async (mode: "element" | "rect") => {
    if (!client || state !== "connected") return;
    setBusy(true);
    try {
      const sel = await beginPick(mode);
      if (!sel) return;
      const b = await buildBundle(sel);
      setBundle(b);
      setResolved(null);
      setNote("resolving…");
      setOpen(true);
      client.submitCapture(b);
    } finally {
      setBusy(false);
    }
  };

  const pill = {
    position: "fixed",
    bottom: "16px",
    left: "16px",
    zIndex: 2147483000,
    display: "flex",
    alignItems: "center",
    gap: "10px",
    padding: "8px 12px",
    font: mono,
    color: "#ececef",
    background: "rgba(15,15,18,0.94)",
    border: "1px solid #2e2e3c",
    borderRadius: "6px",
    boxShadow: "0 6px 24px rgba(0,0,0,0.45)",
  };
  const btn =
    "font:inherit;color:#ff6b00;background:transparent;border:1px solid #2e2e3c;border-radius:4px;padding:3px 8px;cursor:pointer";

  const t = bundle?.target;
  const panel = open
    ? h(
        "div",
        {
          style: {
            position: "fixed",
            bottom: "64px",
            left: "16px",
            width: "440px",
            maxHeight: "70vh",
            overflow: "auto",
            zIndex: 2147483000,
            font: mono,
            color: "#ececef",
            background: "rgba(15,15,18,0.97)",
            border: "1px solid #2e2e3c",
            borderRadius: "8px",
            padding: "14px 16px",
            boxShadow: "0 10px 36px rgba(0,0,0,0.55)",
          },
        },
        [
          h(
            "div",
            { style: "display:flex;justify-content:space-between;margin-bottom:8px" },
            [
              h("strong", { style: "color:#ff6b00;letter-spacing:0.08em" }, "CAPTURE"),
              h(
                "button",
                { style: btn, onClick: () => setOpen(false) },
                "close",
              ),
            ],
          ),
          bundle
            ? h("div", {}, [
                row("confidence", t?.confidence ?? "—"),
                row("selector", t?.selector ?? "—"),
                row(
                  "components",
                  t?.componentStack.map((c) => c.name).join(" < ") || "—",
                ),
                row("tailwind", bundle.tailwindClasses.join(" ") || "—"),
                row(
                  "styles",
                  `${Object.keys(bundle.computedStyles).length} props`,
                ),
                row(
                  "runtime",
                  `${bundle.runtime.console.length} log · ${bundle.runtime.network.length} net · ${bundle.runtime.errors.length} err`,
                ),
                row("screenshot", bundle.screenshot ? "captured" : "—"),
                bundle.screenshot
                  ? h("img", {
                      src: bundle.screenshot.dataUrl,
                      style:
                        "max-width:100%;margin:8px 0;border:1px solid #2e2e3c;border-radius:4px",
                    })
                  : null,
                h(
                  "div",
                  { style: `color:${muted};margin:8px 0 4px` },
                  note,
                ),
                resolved
                  ? h(
                      "pre",
                      {
                        style:
                          "white-space:pre;overflow:auto;background:#0b0b0d;border:1px solid #232330;border-radius:4px;padding:10px;margin:0;color:#bfbfc6",
                      },
                      `${resolved.file}:${resolved.line}\n\n${resolved.snippet}`,
                    )
                  : null,
              ])
            : h("div", { style: `color:${muted}` }, "no capture yet"),
        ],
      )
    : null;

  return h("div", {}, [
    panel,
    h("div", { style: pill }, [
      h("span", {
        style: `width:8px;height:8px;border-radius:50%;background:${DOT[state]};display:inline-block`,
      }),
      h("strong", { style: "letter-spacing:0.08em" }, "InSitu"),
      h(
        "span",
        {
          style: `color:${muted};max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap`,
        },
        detail || state,
      ),
      h(
        "button",
        {
          disabled: state !== "connected" || busy,
          onClick: () => pick("element"),
          style: btn,
        },
        busy ? "…" : "Select",
      ),
      h(
        "button",
        {
          disabled: state !== "connected" || busy,
          onClick: () => pick("rect"),
          style: btn,
        },
        "Rect",
      ),
      bundle
        ? h(
            "button",
            { onClick: () => setOpen((v) => !v), style: btn },
            open ? "hide" : "panel",
          )
        : null,
    ]),
  ]);
}

export function mountInSitu(opts: InSituOptions = {}): () => void {
  const host = document.createElement("div");
  host.id = "insitu-root";
  host.setAttribute("data-insitu", "");
  document.body.appendChild(host);
  const shadow = host.attachShadow({ mode: "open" });
  const mountPoint = document.createElement("div");
  shadow.appendChild(mountPoint);
  render(h(App, { port: opts.port ?? 5747 }), mountPoint);
  return () => {
    render(null, mountPoint);
    host.remove();
  };
}
