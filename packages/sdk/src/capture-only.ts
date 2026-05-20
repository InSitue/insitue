/**
 * Capture-only mount — the PRODUCTION reporter widget. NO companion,
 * NO WebSocket, NO fs/agent: it builds the exact same `CaptureBundle`
 * the local loop does and hands it to an `IssueTrackerSink`. This is
 * the surface a customer's end users (often PM/QA) actually see, so
 * it's a clean, friendly, style-isolated SaaS widget — distinct from
 * the OSS terminal overlay (which is unchanged).
 */
import { h, render, type ComponentChildren } from "preact";
import { useEffect, useState } from "preact/hooks";
import {
  IssueTrackerSink,
  type CaptureBundle,
  type IssueDraft,
} from "@insitue/capture-core";
import { installRuntimeCollectors } from "./runtime.js";
import { beginPick } from "./picker.js";
import { buildBundle } from "./capture.js";

export interface CaptureOnlyOptions {
  /**
   * Publishable project key (e.g. `pk_…`). When set, captures POST
   * to the InSitue cloud automatically — no `onCapture` plumbing
   * required. The key is publishable (Origin-pinned + quota-gated
   * server-side) so it's safe to ship in your production bundle.
   */
  projectKey?: string;
  /**
   * Ingest endpoint. Defaults to the InSitue cloud. Override only if
   * you self-host the ingest service or proxy it from your own
   * origin.
   */
  endpoint?: string;
  /**
   * Take over delivery yourself. Wins over `projectKey` if both are
   * set. Default (neither set): console + JSON download +
   * `window.__insitu_capture__` (useful for prod validation).
   */
  onCapture?: (draft: IssueDraft, bundle: CaptureBundle) => void;
}

const DEFAULT_INGEST = "https://www.insitue.com/api/v1/capture";

/** POSTs the bundle to the InSitue ingest endpoint. Best-effort —
 *  network errors are swallowed so the panel still closes cleanly;
 *  the bundle is in `window.__insitu_capture__` as a fallback hook,
 *  and the cloud dedupes retries server-side. */
async function postCapture(
  endpoint: string,
  projectKey: string,
  draft: IssueDraft,
): Promise<void> {
  try {
    await fetch(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-insitue-key": projectKey,
      },
      body: JSON.stringify({
        bundle: draft.bundle,
        note: draft.bundle.userNote ?? null,
        projectKey, // belt + braces — header is the contract, body is the fallback
      }),
      credentials: "omit",
      keepalive: true,
    });
  } catch {
    /* swallow network errors */
  }
}

// Self-contained palette (Shadow DOM — no host CSS). Mirrors the
// SaaS design system v2.
const C = {
  ink: "#16161a",
  sub: "#6b6c77",
  faint: "#9a9aa4",
  line: "#e9e9ee",
  surface: "#ffffff",
  surface2: "#f6f6f9",
  accent: "linear-gradient(180deg,#6b63ff,#5751e6)",
  accentRing: "rgba(91,91,240,.30)",
  green: "#117a52",
  sans:
    '-apple-system,BlinkMacSystemFont,"Segoe UI",Inter,Roboto,"Helvetica Neue",Arial,sans-serif',
  mono: 'ui-monospace,"SF Mono",SFMono-Regular,Menlo,monospace',
  shadow: "0 12px 40px rgba(20,20,35,.16),0 2px 8px rgba(20,20,35,.08)",
};

function defaultDeliver(draft: IssueDraft): void {
  (globalThis as Record<string, unknown>).__insitu_capture__ = {
    title: draft.title,
    body: draft.body,
    bundle: draft.bundle,
  };
  // eslint-disable-next-line no-console
  console.info("[insitue] capture:", draft.title);
  try {
    const blob = new Blob([JSON.stringify(draft, null, 2)], {
      type: "application/json",
    });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `insitue-capture-${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  } catch {
    /* download is best-effort; the window hook is the contract */
  }
}

type Phase = "idle" | "picking" | "compose" | "sending" | "sent";

interface AppProps {
  projectKey?: string;
  endpoint?: string;
  onCapture?: CaptureOnlyOptions["onCapture"];
}

function CaptureOnlyApp(props: AppProps) {
  const [phase, setPhase] = useState<Phase>("idle");
  const [bundle, setBundle] = useState<CaptureBundle | null>(null);
  const [note, setNote] = useState("");

  const sink = new IssueTrackerSink(async (draft) => {
    // Always set the window hook — useful for prod validation
    // regardless of delivery mode.
    (globalThis as Record<string, unknown>).__insitu_capture__ = {
      title: draft.title,
      body: draft.body,
      bundle: draft.bundle,
    };
    if (props.onCapture) {
      props.onCapture(draft, draft.bundle);
    } else if (props.projectKey) {
      await postCapture(
        props.endpoint ?? DEFAULT_INGEST,
        props.projectKey,
        draft,
      );
    } else {
      defaultDeliver(draft);
    }
  });

  useEffect(() => {
    if (phase !== "sent") return;
    const t = setTimeout(() => {
      setPhase("idle");
      setBundle(null);
      setNote("");
    }, 2400);
    return () => clearTimeout(t);
  }, [phase]);

  const startPick = async () => {
    setPhase("picking");
    try {
      const sel = await beginPick("element");
      if (!sel) {
        setPhase("idle");
        return;
      }
      setBundle(await buildBundle(sel));
      setPhase("compose");
    } catch {
      setPhase("idle");
    }
  };

  const send = async () => {
    if (!bundle) return;
    setPhase("sending");
    const withNote: CaptureBundle = note.trim()
      ? { ...bundle, userNote: note.trim() }
      : bundle;
    try {
      await sink.submit(withNote);
    } finally {
      setPhase("sent");
    }
  };

  const reset = () => {
    setPhase("idle");
    setBundle(null);
    setNote("");
  };

  const dot = h("span", {
    style: `width:9px;height:9px;border-radius:3px;background:${C.accent};box-shadow:0 1px 4px ${C.accentRing}`,
  });

  // ── launcher ──
  if (phase === "idle" || phase === "picking") {
    const picking = phase === "picking";
    return h(
      "button",
      {
        onClick: picking ? undefined : () => void startPick(),
        style: `all:unset;position:fixed;bottom:20px;right:20px;z-index:2147483000;display:flex;align-items:center;gap:9px;cursor:${picking ? "default" : "pointer"};padding:11px 16px;font:600 13.5px/1 ${C.sans};color:${C.ink};background:${C.surface};border:1px solid ${C.line};border-radius:999px;box-shadow:${C.shadow};letter-spacing:-.01em`,
      },
      picking
        ? [
            h("span", {
              style: `width:9px;height:9px;border-radius:50%;background:#5751e6;animation:ipulse 1.1s ${"ease-in-out"} infinite`,
            }),
            h("span", { style: `color:${C.sub}` }, "Click the broken element"),
            h("span", { style: `color:${C.faint}` }, "· Esc to cancel"),
            h(
              "style",
              {},
              "@keyframes ipulse{0%,100%{opacity:.35}50%{opacity:1}}",
            ),
          ]
        : [dot, "Report a problem"],
    );
  }

  // ── panel (compose / sending / sent) ──
  const t = bundle?.target;
  const targetLabel =
    t?.componentStack?.[0]?.name ??
    t?.selector?.split(">").pop()?.trim() ??
    "selection";

  const card = (children: ComponentChildren) =>
    h(
      "div",
      {
        style: `position:fixed;bottom:20px;right:20px;z-index:2147483000;width:344px;font:14px/1.55 ${C.sans};color:${C.ink};background:${C.surface};border:1px solid ${C.line};border-radius:16px;box-shadow:${C.shadow};overflow:hidden`,
      },
      children,
    );

  if (phase === "sent") {
    return card([
      h(
        "div",
        { style: "padding:30px 22px;text-align:center" },
        [
          h(
            "div",
            {
              style: `width:46px;height:46px;border-radius:50%;margin:0 auto 12px;display:flex;align-items:center;justify-content:center;color:#fff;font-size:22px;background:${C.accent};box-shadow:0 6px 18px ${C.accentRing}`,
            },
            "✓",
          ),
          h(
            "div",
            { style: "font-weight:680;font-size:15px;letter-spacing:-.01em" },
            "Report sent",
          ),
          h(
            "div",
            { style: `color:${C.sub};margin-top:5px;font-size:13px` },
            "The team has everything to reproduce and fix this — no follow-up needed.",
          ),
        ],
      ),
    ]);
  }

  const sending = phase === "sending";
  return card([
    h(
      "div",
      {
        style: `display:flex;align-items:center;justify-content:space-between;padding:14px 16px;border-bottom:1px solid ${C.line}`,
      },
      [
        h(
          "div",
          { style: "display:flex;align-items:center;gap:8px;font-weight:680;letter-spacing:-.01em" },
          [dot, "Report a problem"],
        ),
        h(
          "button",
          {
            onClick: reset,
            style: `all:unset;cursor:pointer;color:${C.faint};font-size:16px;line-height:1;padding:2px 4px`,
          },
          "✕",
        ),
      ],
    ),
    h("div", { style: "padding:16px" }, [
      h(
        "div",
        {
          style: `display:flex;align-items:center;gap:8px;padding:9px 11px;background:${C.surface2};border:1px solid ${C.line};border-radius:10px;font:12px/1.3 ${C.mono};color:${C.sub};margin-bottom:12px`,
        },
        [
          h("span", { style: `color:#5751e6` }, "◎"),
          h(
            "span",
            {
              style:
                "overflow:hidden;text-overflow:ellipsis;white-space:nowrap",
            },
            `${targetLabel}${t?.source ? ` · ${t.source.file.split("/").pop()}` : ""}`,
          ),
        ],
      ),
      bundle?.screenshot
        ? h("img", {
            src: bundle.screenshot.dataUrl,
            style: `width:100%;max-height:120px;object-fit:cover;border:1px solid ${C.line};border-radius:10px;margin-bottom:12px`,
          })
        : bundle?.screenshotUnavailable
          ? h(
              "div",
              {
                style: `font-size:12px;color:${C.faint};background:${C.surface2};border:1px solid ${C.line};border-radius:10px;padding:10px;margin-bottom:12px`,
              },
              "Screenshot unavailable — sending the rest.",
            )
          : null,
      h("textarea", {
        value: note,
        rows: 3,
        placeholder: "What's wrong? (optional but helps)",
        disabled: sending,
        onInput: (e: Event) =>
          setNote((e.target as HTMLTextAreaElement).value),
        style: `width:100%;box-sizing:border-box;font:14px/1.5 ${C.sans};color:${C.ink};background:${C.surface};border:1px solid #d8d8de;border-radius:10px;padding:10px 12px;resize:none;outline:none`,
      }),
      h("div", { style: "display:flex;gap:8px;margin-top:12px" }, [
        h(
          "button",
          {
            onClick: sending ? undefined : () => void send(),
            disabled: sending,
            style: `flex:1;all:unset;text-align:center;cursor:${sending ? "default" : "pointer"};padding:11px;font:680 13.5px/1 ${C.sans};color:#fff;background:${C.accent};border-radius:10px;box-shadow:0 2px 10px ${C.accentRing};opacity:${sending ? ".7" : "1"}`,
          },
          sending ? "Sending…" : "Send report",
        ),
        h(
          "button",
          {
            onClick: () => void startPick(),
            style: `all:unset;cursor:pointer;padding:11px 14px;font:600 13.5px/1 ${C.sans};color:${C.sub};background:${C.surface2};border:1px solid ${C.line};border-radius:10px`,
          },
          "Re-pick",
        ),
      ]),
    ]),
    h(
      "div",
      {
        style: `display:flex;justify-content:space-between;padding:9px 16px;border-top:1px solid ${C.line};color:${C.faint};font-size:11px`,
      },
      [h("span", {}, "🔒 Secrets scrubbed automatically"), h("span", {}, "InSitue")],
    ),
  ]);
}

export function mountCaptureOnly(opts: CaptureOnlyOptions = {}): () => void {
  installRuntimeCollectors();
  const host = document.createElement("div");
  host.id = "insitu-capture-root"; // internal sentinel (kept)
  host.setAttribute("data-insitu", "");
  document.body.appendChild(host);
  const shadow = host.attachShadow({ mode: "open" });
  const mount = document.createElement("div");
  shadow.appendChild(mount);
  render(
    h(CaptureOnlyApp, {
      projectKey: opts.projectKey,
      endpoint: opts.endpoint,
      onCapture: opts.onCapture,
    }),
    mount,
  );
  return () => {
    render(null, mount);
    host.remove();
  };
}
