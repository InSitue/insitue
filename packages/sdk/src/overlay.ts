/**
 * The overlay. Rendered with Preact into a Shadow DOM root so it is
 * fully style-isolated from the host app's Tailwind/React and shares
 * no runtime with host React. JSX-free (Preact `h`) to keep the M0
 * build single-pragma and tiny.
 */
import { h, render } from "preact";
import { useEffect, useState } from "preact/hooks";
import { CompanionClient, type ConnState } from "./client.js";

export interface InSituOptions {
  /** Companion loopback port (default 5747). */
  port?: number;
}

const DOT: Record<ConnState, string> = {
  idle: "#888",
  connecting: "#e0a30c",
  connected: "#2fd16b",
  error: "#ff6b6b",
};

function App(props: { port: number }) {
  const [state, setState] = useState<ConnState>("idle");
  const [detail, setDetail] = useState<string>("");
  const [rtt, setRtt] = useState<number | null>(null);
  const [client, setClient] = useState<CompanionClient | null>(null);

  useEffect(() => {
    const c = new CompanionClient(props.port, {
      onState: (s, d) => {
        setState(s);
        if (d !== undefined) setDetail(d);
      },
    });
    setClient(c);
    void c.connect();
    return () => c.dispose();
  }, [props.port]);

  const box = {
    position: "fixed",
    bottom: "16px",
    left: "16px",
    zIndex: 2147483000,
    display: "flex",
    alignItems: "center",
    gap: "10px",
    padding: "8px 12px",
    font: "12px ui-monospace, SFMono-Regular, Menlo, monospace",
    color: "#ececef",
    background: "rgba(15,15,18,0.94)",
    border: "1px solid #2e2e3c",
    borderRadius: "6px",
    boxShadow: "0 6px 24px rgba(0,0,0,0.45)",
  };

  return h("div", { style: box }, [
    h("span", {
      style: `width:8px;height:8px;border-radius:50%;background:${DOT[state]};display:inline-block`,
    }),
    h("strong", { style: "letter-spacing:0.08em" }, "InSitu"),
    h(
      "span",
      { style: "color:#8a8a93;max-width:280px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" },
      detail || state,
    ),
    h(
      "button",
      {
        disabled: state !== "connected",
        onClick: async () => {
          if (!client) return;
          try {
            setRtt(Math.round(await client.ping()));
          } catch {
            setRtt(null);
            setDetail("ping failed");
          }
        },
        style:
          "font:inherit;color:#ff6b00;background:transparent;border:1px solid #2e2e3c;border-radius:4px;padding:3px 8px;cursor:pointer",
      },
      rtt == null ? "Ping" : `Ping (${rtt}ms)`,
    ),
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
