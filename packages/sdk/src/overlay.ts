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

function diffLines(diff: string) {
  return diff.split("\n").map((ln) => {
    let color = muted;
    if (ln.startsWith("@@")) color = "#5fb3e0";
    else if (ln.startsWith("+++") || ln.startsWith("---")) color = muted;
    else if (ln.startsWith("+")) color = "#5fd18a";
    else if (ln.startsWith("-")) color = "#ff7a7a";
    else color = "#bfbfc6";
    return h("div", { style: `color:${color};white-space:pre` }, ln || " ");
  });
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
  const [agentReady, setAgentReady] = useState<boolean | null>(null);
  const [agentNote, setAgentNote] = useState("");
  const [chatInput, setChatInput] = useState("");
  const [reply, setReply] = useState("");
  const [turnBusy, setTurnBusy] = useState(false);
  const [changes, setChanges] = useState<
    Array<{ file: string; diff: string; bytes: number }>
  >([]);

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
      onAgentStatus: (s) => {
        setAgentReady(s.ready);
        setAgentNote(
          s.blockers.length
            ? `blocked: ${s.blockers.join("; ")}`
            : s.warnings.join(" · ") || `agent ready (${s.transport})`,
        );
      },
      onAgentEvent: (e) => {
        if (e.t === "agent-text") setReply((r) => r + e.delta);
        else if (e.t === "agent-turn-complete") setTurnBusy(false);
        else if (e.t === "agent-error") {
          setReply((r) => r + `\n\n[agent-error] ${e.message}`);
          setTurnBusy(false);
        }
      },
      onChangeset: (_t, files) => setChanges(files),
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
      setReply("");
      setChanges([]);
      setNote("resolving…");
      setOpen(true);
      client.submitCapture(b);
    } finally {
      setBusy(false);
    }
  };

  const sendChat = () => {
    if (!client || !bundle || !chatInput.trim() || turnBusy) return;
    const turnId = `turn_${Date.now().toString(36)}`;
    setReply("");
    setChanges([]);
    setTurnBusy(true);
    client.sendTurn(turnId, bundle.id, chatInput.trim());
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
                          "white-space:pre;overflow:auto;background:#0b0b0d;border:1px solid #232330;border-radius:4px;padding:10px;margin:0;color:#bfbfc6;max-height:180px",
                      },
                      `${resolved.file}:${resolved.line}\n\n${resolved.snippet}`,
                    )
                  : null,
                h(
                  "div",
                  {
                    style: `margin-top:12px;border-top:1px solid #232330;padding-top:10px`,
                  },
                  [
                    h(
                      "div",
                      { style: `color:#ff6b00;margin-bottom:6px` },
                      "ASK IN SITU",
                    ),
                    agentReady === false
                      ? h(
                          "div",
                          { style: `color:#ff6b6b;margin-bottom:6px` },
                          agentNote,
                        )
                      : agentNote
                        ? h(
                            "div",
                            { style: `color:${muted};margin-bottom:6px` },
                            agentNote,
                          )
                        : null,
                    h("textarea", {
                      value: chatInput,
                      placeholder:
                        "e.g. what does this component do? / how would I make the padding bigger?",
                      rows: 3,
                      onInput: (ev: Event) =>
                        setChatInput(
                          (ev.target as HTMLTextAreaElement).value,
                        ),
                      onKeyDown: (ev: KeyboardEvent) => {
                        if (
                          (ev.metaKey || ev.ctrlKey) &&
                          ev.key === "Enter"
                        )
                          sendChat();
                      },
                      style:
                        "width:100%;box-sizing:border-box;font:inherit;color:#ececef;background:#0b0b0d;border:1px solid #232330;border-radius:4px;padding:8px;resize:vertical",
                    }),
                    h(
                      "div",
                      {
                        style:
                          "display:flex;gap:8px;align-items:center;margin-top:6px",
                      },
                      [
                        h(
                          "button",
                          {
                            style: btn,
                            disabled:
                              turnBusy ||
                              !chatInput.trim() ||
                              agentReady === false,
                            onClick: sendChat,
                          },
                          turnBusy ? "…thinking" : "Send (⌘↵)",
                        ),
                        turnBusy
                          ? h(
                              "button",
                              {
                                style: btn,
                                onClick: () => {
                                  client?.cancelTurn("cur");
                                  setTurnBusy(false);
                                },
                              },
                              "stop",
                            )
                          : null,
                      ],
                    ),
                    reply
                      ? h(
                          "pre",
                          {
                            style:
                              "white-space:pre-wrap;word-break:break-word;background:#0b0b0d;border:1px solid #232330;border-radius:4px;padding:10px;margin:8px 0 0;color:#ececef;max-height:240px;overflow:auto",
                          },
                          reply,
                        )
                      : null,
                    changes.length
                      ? h("div", { style: "margin-top:10px" }, [
                          h(
                            "div",
                            {
                              style: `color:#ff6b00;margin-bottom:4px;display:flex;justify-content:space-between`,
                            },
                            [
                              h(
                                "span",
                                {},
                                `PROPOSED CHANGES · ${changes.length} file${changes.length > 1 ? "s" : ""}`,
                              ),
                              h(
                                "span",
                                { style: `color:${muted}` },
                                "dry-run · apply lands in P4",
                              ),
                            ],
                          ),
                          ...changes.map((c) =>
                            h("div", { style: "margin:6px 0" }, [
                              h(
                                "div",
                                {
                                  style: `color:#ececef;margin-bottom:2px`,
                                },
                                `${c.file}  (${c.bytes}B)`,
                              ),
                              h(
                                "div",
                                {
                                  style:
                                    "overflow:auto;background:#0b0b0d;border:1px solid #232330;border-radius:4px;padding:8px;max-height:240px;font-size:11px;line-height:1.45",
                                },
                                diffLines(c.diff),
                              ),
                            ]),
                          ),
                        ])
                      : null,
                  ],
                ),
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
