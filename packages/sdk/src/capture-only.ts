/**
 * The InSitue capture widget — ONE component, two sinks.
 *
 * Both dev tooling and production bug reporting ask the user to do
 * exactly the same three things: pick an element, describe the
 * issue, send. The only difference is where "send" goes:
 *
 *   - **cloud** sink — HTTPS POST to InSitue Cloud (a publishable
 *     project key gates the route). Becomes an inbox ticket, gets
 *     run through the autopilot, opens a draft PR. Suits end users
 *     reporting bugs.
 *   - **companion** sink — loopback WebSocket to the local
 *     `@insitue/companion` process. Broadcasts to subscribed
 *     CLI/MCP listeners. The user's running `claude` (via the
 *     `/insitue:connect` slash command in `@insitue/claude-plugin`)
 *     picks up the bundle + description and acts in the terminal.
 *     Suits a developer iterating on their own code.
 *
 * Auto-detected by default:
 *   - `projectKey` set → `cloud`
 *   - otherwise → `companion`
 *
 * Explicit `sink` opt overrides. The picker, the bundle shape, the
 * screenshot pipeline are all shared — never branched.
 *
 * Theming follows the sink: cloud = the SaaS card the user's
 * end-users see (warm, light); companion = "Dev mode" (dark,
 * terminal-aesthetic) so the developer always knows which widget
 * they're staring at.
 */
import { h, render, type ComponentChildren } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import {
  IssueTrackerSink,
  type CaptureBundle,
  type IssueDraft,
} from "@insitue/capture-core";
import { installRuntimeCollectors } from "./runtime.js";
import { beginPick } from "./picker.js";
import {
  buildBundle,
  onDisplayMediaChange,
  retryDisplayMedia,
  stopDisplayMedia,
} from "./capture.js";
import {
  hasPersistedCaptureSettings,
  setCaptureSettings,
} from "./capture-settings.js";
import { CompanionClient } from "./client.js";

/** Where captures go. Auto-detected from `projectKey` if omitted. */
export type CaptureSink =
  | { kind: "cloud"; projectKey: string; endpoint?: string }
  | { kind: "companion"; port?: number };

export interface CaptureOnlyOptions {
  /**
   * Publishable project key (e.g. `pk_…`). When set, captures POST
   * to the InSitue cloud automatically — implies `sink: { kind:
   * "cloud", projectKey }`. The key is publishable (Origin-pinned +
   * quota-gated server-side) so it's safe to ship in production.
   */
  projectKey?: string;
  /** Ingest endpoint (cloud sink). Defaults to the InSitue cloud. */
  endpoint?: string;
  /**
   * Take over delivery yourself. Wins over `projectKey` AND `sink`.
   * Default (neither set + no companion reachable): console + JSON
   * download + `window.__insitue_capture__` (useful for prod
   * validation).
   */
  onCapture?: (draft: IssueDraft, bundle: CaptureBundle) => void;
  /**
   * Override the sink explicitly. Use when auto-detection isn't
   * right — e.g. you set a `projectKey` but want to ship to a local
   * companion for testing. Most callers leave this undefined.
   */
  sink?: CaptureSink;
  /**
   * Force the pixel-perfect (`getDisplayMedia`) path for every
   * capture from mount. Costs a one-time tab-share permission per
   * session in exchange for screenshots that are guaranteed to
   * match what the user actually saw — bypasses every html-to-image
   * quirk. Use in dev/dogfood where capture quality matters more
   * than the permission UX.
   */
  defaultPixelPerfect?: boolean;
}

const DEFAULT_INGEST = "https://www.insitue.com/api/v1/capture";
const DEFAULT_COMPANION_PORT = 5747;

/** Resolve `opts` → the concrete sink we'll use. */
function resolveSink(opts: CaptureOnlyOptions): CaptureSink {
  if (opts.sink) return opts.sink;
  if (opts.projectKey) {
    return opts.endpoint
      ? {
          kind: "cloud",
          projectKey: opts.projectKey,
          endpoint: opts.endpoint,
        }
      : { kind: "cloud", projectKey: opts.projectKey };
  }
  return { kind: "companion" };
}

/** Cloud sink — HTTPS POST. Best-effort; the cloud dedupes retries
 *  server-side, and the bundle is in `window.__insitue_capture__` as a
 *  fallback hook regardless of network state. */
async function postCloud(
  sink: Extract<CaptureSink, { kind: "cloud" }>,
  draft: IssueDraft,
): Promise<void> {
  const endpoint = sink.endpoint ?? DEFAULT_INGEST;
  try {
    await fetch(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-insitue-key": sink.projectKey,
      },
      body: JSON.stringify({
        bundle: draft.bundle,
        note: draft.bundle.userNote ?? null,
        projectKey: sink.projectKey,
      }),
      credentials: "omit",
      keepalive: true,
    });
  } catch {
    /* swallow network errors */
  }
}

// ── SaaS theme (cloud sink) — what end-users reporting bugs see.
const CLOUD = {
  ink: "#16161a",
  sub: "#6b6c77",
  faint: "#9a9aa4",
  line: "#e9e9ee",
  surface: "#ffffff",
  surface2: "#f6f6f9",
  accent: "linear-gradient(180deg,#6b63ff,#5751e6)",
  accentSolid: "#5751e6",
  accentRing: "rgba(91,91,240,.30)",
  good: "#117a52",
  goodBg: "#ecfdf5",
  goodLine: "#b6e6cf",
  warnBg: "#fff7ed",
  warnLine: "#fbd9b1",
  warnInk: "#8a4b00",
  sans:
    '-apple-system,BlinkMacSystemFont,"Segoe UI",Inter,Roboto,"Helvetica Neue",Arial,sans-serif',
  mono: 'ui-monospace,"SF Mono",SFMono-Regular,Menlo,monospace',
  shadow: "0 12px 40px rgba(20,20,35,.16),0 2px 8px rgba(20,20,35,.08)",
  buttonInk: "#ffffff",
};

// ── Dev theme (companion sink) — visually distinct from the SaaS
//    skin so the developer always knows "this is the dev widget,
//    bound to my terminal claude". Dark surface, mono pairs, the
//    signature orange accent that runs throughout the InSitue
//    aesthetic. Not gimmicky terminal-green — that screams "toy"
//    and we ship serious software.
const DEV = {
  ink: "#ececef",
  sub: "#a0a0aa",
  faint: "#6b6b75",
  line: "#26262d",
  surface: "#13131a",
  surface2: "#1a1a22",
  accent: "linear-gradient(180deg,#ff8240,#ff6b00)",
  accentSolid: "#ff6b00",
  accentRing: "rgba(255,107,0,.28)",
  good: "#5fd190",
  goodBg: "#0f1f15",
  goodLine: "#1f4030",
  warnBg: "#251a0f",
  warnLine: "#5a3a1a",
  warnInk: "#f5b56b",
  sans:
    '-apple-system,BlinkMacSystemFont,"Segoe UI",Inter,Roboto,"Helvetica Neue",Arial,sans-serif',
  mono: 'ui-monospace,"SF Mono",SFMono-Regular,Menlo,monospace',
  shadow: "0 14px 44px rgba(0,0,0,.55),0 2px 10px rgba(0,0,0,.35)",
  buttonInk: "#0f0f12",
};

function defaultDeliver(draft: IssueDraft): void {
  (globalThis as Record<string, unknown>).__insitue_capture__ = {
    title: draft.title,
    body: draft.body,
    bundle: draft.bundle,
  };
  // The default deliver path is "no companion + no projectKey + no
  // onCapture override", so a single console line is the only signal
  // the dev/dogfooder gets that a capture happened. Intentional.
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

/** companion-sink connection state, surfaced in the panel. */
type CompanionState =
  | "idle"
  | "connecting"
  | "connected"
  | "error"
  | "offline";

interface AppProps {
  sink: CaptureSink;
  onCapture?: CaptureOnlyOptions["onCapture"];
}

/** Setup callout shown when the user clicks the muted dev launcher.
 *  Two flavours: companion-not-reachable vs companion-reachable-but-
 *  no-CLI-attached. Both end at the same place: "run /insitue:connect
 *  in claude". */
function offlineHelpCard(
  reason: "companion" | "subscriber",
  onClose: () => void,
) {
  const ink = "#ececef";
  const sub = "#a0a0aa";
  const faint = "#6b6b75";
  const line = "#26262d";
  const surface = "#13131a";
  const accent = "#5751e6";
  const mono =
    'ui-monospace,"SF Mono",SFMono-Regular,Menlo,monospace';
  const sans =
    '-apple-system,BlinkMacSystemFont,"Segoe UI",Inter,Roboto,"Helvetica Neue",Arial,sans-serif';
  const title =
    reason === "companion"
      ? "Open claude to activate InSitue"
      : "Attach claude to start picking";
  const lead =
    reason === "companion"
      ? "The local companion isn't reachable yet. Open a terminal in this project and start claude."
      : "The companion is running, but no claude session is listening. Run the slash command below to attach.";
  const step1 =
    reason === "companion"
      ? "In your project directory, run:"
      : "In your existing claude session, run:";
  const cmd1 = reason === "companion" ? "claude" : "/insitue:connect";
  const step2 =
    reason === "companion" ? "Then inside claude, run:" : null;
  const cmd2 = reason === "companion" ? "/insitue:connect" : null;
  const code = (s: string) =>
    h(
      "code",
      {
        style: `display:inline-block;font:600 12.5px/1.4 ${mono};color:${ink};background:#0c0c11;border:1px solid ${line};padding:6px 10px;border-radius:6px`,
      },
      s,
    );
  return h(
    "div",
    {
      style: `width:300px;font:13px/1.5 ${sans};color:${ink};background:${surface};border:1px solid ${line};border-radius:14px;box-shadow:0 14px 44px rgba(0,0,0,.55),0 2px 10px rgba(0,0,0,.35);overflow:hidden`,
    },
    [
      h(
        "div",
        {
          style: `display:flex;align-items:center;justify-content:space-between;gap:8px;padding:14px 16px 10px`,
        },
        [
          h(
            "div",
            { style: "display:flex;align-items:center;gap:9px" },
            [
              h("span", {
                style: `width:9px;height:9px;border-radius:3px;background:${accent};box-shadow:0 1px 4px rgba(91,91,240,.4)`,
              }),
              h(
                "span",
                {
                  style: `font-weight:680;font-size:13.5px;letter-spacing:-.01em;color:${ink}`,
                },
                title,
              ),
            ],
          ),
          h(
            "button",
            {
              onClick: onClose,
              style: `all:unset;cursor:pointer;color:${faint};font-size:18px;line-height:1;padding:2px 6px;border-radius:6px`,
              title: "Dismiss",
            },
            "×",
          ),
        ],
      ),
      h(
        "div",
        { style: `padding:0 16px 14px;color:${sub}` },
        [
          h("p", { style: "margin:0 0 12px" }, lead),
          h(
            "div",
            { style: "display:flex;flex-direction:column;gap:8px" },
            [
              h(
                "div",
                {
                  style: `font-size:11.5px;color:${faint};letter-spacing:.04em;text-transform:uppercase;font-weight:600`,
                },
                step1,
              ),
              code(cmd1),
              step2
                ? h(
                    "div",
                    {
                      style: `margin-top:6px;font-size:11.5px;color:${faint};letter-spacing:.04em;text-transform:uppercase;font-weight:600`,
                    },
                    step2,
                  )
                : null,
              cmd2 ? code(cmd2) : null,
            ],
          ),
          h(
            "p",
            {
              style: `margin:14px 0 0;font-size:12px;color:${faint}`,
            },
            "Don't have the plugin? Run /plugin marketplace add InSitue/insitue in claude, then /plugin install insitue.",
          ),
        ],
      ),
    ],
  );
}

function CaptureApp(props: AppProps) {
  const isDev = props.sink.kind === "companion";
  const C = isDev ? DEV : CLOUD;

  const [phase, setPhase] = useState<Phase>("idle");
  const [bundle, setBundle] = useState<CaptureBundle | null>(null);
  const [note, setNote] = useState("");
  const [tabCaptureActive, setTabCaptureActive] = useState(false);
  const [tabCaptureDenied, setTabCaptureDenied] = useState(false);
  const [companionState, setCompanionState] = useState<CompanionState>(
    isDev ? "connecting" : "idle",
  );
  const [companionDetail, setCompanionDetail] = useState<string>("");
  // Number of CLI/MCP subscribers attached to the companion right
  // now. Drives the "active" purple state of the dev launcher —
  // the companion being up isn't enough; we want claude (or another
  // CLI subscriber) to actually be listening before signalling
  // "I'm live". `subscribers-attached` is pushed by the companion
  // whenever the set changes.
  const [subscriberCount, setSubscriberCount] = useState(0);
  const [showOfflineHelp, setShowOfflineHelp] = useState(false);
  const noteRef = useRef<HTMLTextAreaElement | null>(null);

  // ── Companion connection (dev sink only).
  const companionRef = useRef<CompanionClient | null>(null);
  useEffect(() => {
    if (!isDev) return;
    const port =
      props.sink.kind === "companion"
        ? (props.sink.port ?? DEFAULT_COMPANION_PORT)
        : DEFAULT_COMPANION_PORT;
    let cancelled = false;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

    const connect = () => {
      if (cancelled) return;
      const c = new CompanionClient(port, {
        onState: (s, detail) => {
          setCompanionState(s);
          if (detail) setCompanionDetail(detail);
          if (s !== "connected") setSubscriberCount(0);
          // Auto-reconnect on disconnect: simple linear backoff,
          // capped — the companion legitimately restarts (manual
          // stop, MCP shutdown), so we want to recover whenever
          // it comes back online.
          if (s === "error" || s === "idle") {
            if (!cancelled) {
              reconnectTimer = setTimeout(connect, 2_500);
            }
          }
        },
        onSubscribersAttached: (count) => setSubscriberCount(count),
      });
      companionRef.current = c;
      void c.connect();
    };
    connect();

    return () => {
      cancelled = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      companionRef.current?.dispose();
      companionRef.current = null;
    };
  }, [isDev, props.sink]);

  useEffect(() => {
    return onDisplayMediaChange((active, reason) => {
      setTabCaptureActive(active);
      if (reason === "denied") setTabCaptureDenied(true);
      if (reason === "granted") setTabCaptureDenied(false);
    });
  }, []);

  // Re-pick after enabling tab capture — rebuilds the bundle so the
  // pixel-perfect path runs without needing the user to re-select.
  const retryWithPixelPerfect = async () => {
    if (!bundle?.target?.selector) {
      await retryDisplayMedia();
      return;
    }
    const granted = await retryDisplayMedia();
    if (granted) {
      setPhase("picking");
      const sel = await beginPick("element").catch(() => null);
      if (sel) {
        setBundle(await buildBundle(sel));
        setPhase("compose");
      } else {
        setPhase("compose");
      }
    }
  };

  const sink = new IssueTrackerSink(async (draft) => {
    (globalThis as Record<string, unknown>).__insitue_capture__ = {
      title: draft.title,
      body: draft.body,
      bundle: draft.bundle,
    };
    if (props.onCapture) {
      props.onCapture(draft, draft.bundle);
      return;
    }
    if (props.sink.kind === "cloud") {
      await postCloud(props.sink, draft);
      return;
    }
    // companion sink — the WS client submits the bundle; the
    // companion broadcasts to subscribed CLI/MCP listeners (e.g.
    // claude with /insitue:connect open).
    const client = companionRef.current;
    if (!client || companionState !== "connected") {
      // Companion isn't online — fall back to the default deliver
      // so the user has SOMETHING. The dev affordance below also
      // tells them the companion is offline.
      defaultDeliver(draft);
      return;
    }
    client.submitCapture(draft.bundle);
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

  // Auto-focus the textarea the moment we enter compose — the user
  // can describe immediately without reaching for the mouse.
  useEffect(() => {
    if (phase === "compose") {
      const id = setTimeout(() => noteRef.current?.focus(), 30);
      return () => clearTimeout(id);
    }
    return undefined;
  }, [phase]);

  // Esc closes the compose panel. Deliberately NOT a global "start
  // pick" shortcut — Cmd+K and similar combos are heavily used by
  // host apps (Linear, GitHub, Notion, Raycast). Hijacking them
  // makes the widget feel intrusive in the apps where it's most
  // valuable. Click the pill to start; Esc to back out.
  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === "Escape" && phase === "compose") {
        ev.preventDefault();
        reset();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // `reset` is a stable closure over local state setters; including
    // it would cause the listener to rebind on every render with no
    // behavioural change. The `phase` dep is what actually matters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
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

  // Dev-mode keyboard: Enter sends (no Cmd modifier — there's no
  // multi-line conversation here, single-line "describe and go" feels
  // right). Shift+Enter inserts a newline if the user wants one.
  // Cloud sink keeps multi-line natural (Cmd+Enter to send).
  const onNoteKeyDown = (ev: KeyboardEvent) => {
    if (isDev) {
      if (ev.key === "Enter" && !ev.shiftKey && note.trim() && bundle) {
        ev.preventDefault();
        void send();
      }
    } else if ((ev.metaKey || ev.ctrlKey) && ev.key === "Enter") {
      ev.preventDefault();
      if (note.trim() && bundle) void send();
    }
  };

  const dot = h("span", {
    style: `width:9px;height:9px;border-radius:3px;background:${C.accent};box-shadow:0 1px 4px ${C.accentRing}`,
  });

  // ── Confidence chip on the picked target — the same string both
  //    sinks ship downstream, so what the user sees is what the
  //    agent sees.
  const confidenceLabel = (b: CaptureBundle | null): string | null => {
    if (!b?.target) return null;
    const c = b.target.confidence;
    if (c === "exact") return "exact";
    if (c === "approximate") return "approximate";
    if (c === "selector-only") return "selector only";
    return c;
  };

  // ── launcher ──
  if (phase === "idle" || phase === "picking") {
    const picking = phase === "picking";
    // "active" = a CLI/MCP subscriber (claude with
    // /insitue:connect open) is currently attached to the
    // companion. The companion being merely *running* isn't enough
    // — the autospawn means it's up the moment `claude` is open,
    // even before the user invokes /insitue:connect. Without the
    // subscriber-count gate the purple state would light up the
    // instant claude boots, which lies about whether picks will
    // actually be acted on.
    const active = isDev && companionState === "connected" && subscriberCount > 0;
    const muted = isDev && !active;

    // Dev launcher: same circular pill shape as cloud, minus the
    // label. Three visual states the developer can read at a
    // glance:
    //
    //   - Muted (companion offline OR no CLI attached) → dark
    //     surface container with a grey inner dot. "Nothing's
    //     listening yet." Clicking opens the setup callout.
    //   - Active (claude attached via /insitue:connect) → the
    //     whole button fills with the cloud-accent purple. The
    //     inner dot inverts to white. Brand-coloured "I'm live."
    //   - Picking → distinct "armed" treatment: the dot becomes a
    //     crosshair, the container pulses with a breathing
    //     outer ring. Visually unmistakable from idle-active so
    //     the user always knows the cursor will hit a target on
    //     next click.
    if (isDev) {
      const containerBg = picking
        ? CLOUD.accentSolid
        : muted
          ? C.surface
          : CLOUD.accentSolid;
      const containerBorder = muted
        ? `1px solid ${C.line}`
        : "1px solid transparent";
      const containerShadow = picking
        ? `0 0 0 6px rgba(91,91,240,.22),0 12px 30px rgba(60,55,200,.45)`
        : muted
          ? C.shadow
          : `0 0 0 4px rgba(91,91,240,.16),0 12px 30px rgba(60,55,200,.42)`;
      const innerBg = muted ? "#9a9aa4" : "#ffffff";
      const innerShadow = muted ? "none" : "0 1px 3px rgba(0,0,0,.20)";
      const onClickLauncher = picking
        ? undefined
        : muted
          ? () => setShowOfflineHelp((v) => !v)
          : () => void startPick();
      const tooltip = picking
        ? "Click an element · Esc to cancel"
        : muted
          ? "InSitue is muted — click for setup"
          : "Pick an element to talk to claude about";
      return h(
        "div",
        {
          style:
            "position:fixed;bottom:20px;right:20px;z-index:2147483000;display:flex;flex-direction:column;align-items:flex-end;gap:12px",
        },
        [
          showOfflineHelp && muted
            ? offlineHelpCard(
                companionState === "connected"
                  ? "subscriber"
                  : "companion",
                () => setShowOfflineHelp(false),
              )
            : null,
          h(
            "button",
            {
              onClick: onClickLauncher,
              style: `all:unset;display:flex;align-items:center;justify-content:center;width:38px;height:38px;cursor:${picking ? "crosshair" : "pointer"};background:${containerBg};border:${containerBorder};border-radius:50%;box-shadow:${containerShadow};transition:background .18s ease,box-shadow .18s ease;${picking ? "animation:iarmedring 1.4s ease-in-out infinite" : ""}`,
              title: tooltip,
            },
            [
              picking
                ? h(
                    "svg",
                    {
                      width: 16,
                      height: 16,
                      viewBox: "0 0 16 16",
                      style: "display:block",
                    },
                    [
                      h("circle", {
                        cx: 8,
                        cy: 8,
                        r: 6,
                        fill: "none",
                        stroke: "#ffffff",
                        "stroke-width": 1.5,
                      }),
                      h("line", {
                        x1: 8,
                        y1: 0,
                        x2: 8,
                        y2: 4,
                        stroke: "#ffffff",
                        "stroke-width": 1.5,
                      }),
                      h("line", {
                        x1: 8,
                        y1: 12,
                        x2: 8,
                        y2: 16,
                        stroke: "#ffffff",
                        "stroke-width": 1.5,
                      }),
                      h("line", {
                        x1: 0,
                        y1: 8,
                        x2: 4,
                        y2: 8,
                        stroke: "#ffffff",
                        "stroke-width": 1.5,
                      }),
                      h("line", {
                        x1: 12,
                        y1: 8,
                        x2: 16,
                        y2: 8,
                        stroke: "#ffffff",
                        "stroke-width": 1.5,
                      }),
                    ],
                  )
                : h("span", {
                    style: `width:11px;height:11px;border-radius:3px;background:${innerBg};box-shadow:${innerShadow}`,
                  }),
              picking
                ? h(
                    "style",
                    {},
                    "@keyframes iarmedring{0%,100%{box-shadow:0 0 0 6px rgba(91,91,240,.22),0 12px 30px rgba(60,55,200,.45)}50%{box-shadow:0 0 0 10px rgba(91,91,240,.10),0 16px 36px rgba(60,55,200,.55)}}",
                  )
                : null,
            ],
          ),
        ],
      );
    }

    // Cloud launcher: pill with dot + "Report a problem" / picking hint.
    return h(
      "button",
      {
        onClick: picking ? undefined : () => void startPick(),
        style: `all:unset;position:fixed;bottom:20px;right:20px;z-index:2147483000;display:flex;align-items:center;gap:9px;cursor:${picking ? "default" : "pointer"};padding:11px 16px;font:600 13.5px/1 ${C.sans};color:${C.ink};background:${C.surface};border:1px solid ${C.line};border-radius:999px;box-shadow:${C.shadow};letter-spacing:-.01em`,
        title: "Report a problem",
      },
      picking
        ? [
            h("span", {
              style: `width:9px;height:9px;border-radius:50%;background:${C.accentSolid};animation:ipulse 1.1s ease-in-out infinite`,
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
  const conf = confidenceLabel(bundle);
  const isPoorSource = bundle?.target?.confidence === "selector-only";

  const card = (children: ComponentChildren) =>
    h(
      "div",
      {
        style: `position:fixed;bottom:20px;right:20px;z-index:2147483000;width:360px;font:14px/1.55 ${C.sans};color:${C.ink};background:${C.surface};border:1px solid ${C.line};border-radius:16px;box-shadow:${C.shadow};overflow:hidden`,
      },
      children,
    );

  if (phase === "sent") {
    const sentTitle = isDev ? "Sent to claude" : "Report sent";
    const sentBody = isDev
      ? "Switch to your terminal — claude has the pick + your description and is ready to act."
      : "The team has everything to reproduce and fix this — no follow-up needed.";
    return card([
      h(
        "div",
        { style: "padding:30px 22px;text-align:center" },
        [
          h(
            "div",
            {
              style: `width:46px;height:46px;border-radius:50%;margin:0 auto 12px;display:flex;align-items:center;justify-content:center;color:${C.buttonInk};font-size:22px;background:${C.accent};box-shadow:0 6px 18px ${C.accentRing}`,
            },
            "✓",
          ),
          h(
            "div",
            { style: "font-weight:680;font-size:15px;letter-spacing:-.01em" },
            sentTitle,
          ),
          h(
            "div",
            { style: `color:${C.sub};margin-top:5px;font-size:13px` },
            sentBody,
          ),
        ],
      ),
    ]);
  }

  const sending = phase === "sending";
  const title = isDev ? "Tell claude what to change" : "Report a problem";
  const placeholderText = isDev
    ? "Describe what should change about this element…"
    : "What's wrong? (optional but helps)";
  const sendButtonLabel = sending
    ? isDev
      ? "Sending…"
      : "Sending…"
    : isDev
      ? "Send to claude ⏎"
      : "Send report";

  return card([
    // Header
    h(
      "div",
      {
        style: `display:flex;align-items:center;justify-content:space-between;padding:14px 16px;border-bottom:1px solid ${C.line}`,
      },
      [
        h(
          "div",
          { style: "display:flex;align-items:center;gap:8px;font-weight:680;letter-spacing:-.01em" },
          [dot, title],
        ),
        h(
          "button",
          {
            onClick: reset,
            style: `all:unset;cursor:pointer;color:${C.faint};font-size:16px;line-height:1;padding:2px 4px`,
            title: "Close",
          },
          "✕",
        ),
      ],
    ),
    h("div", { style: "padding:16px" }, [
      // Target chip with confidence badge
      h(
        "div",
        {
          style: `display:flex;align-items:center;gap:8px;padding:9px 11px;background:${C.surface2};border:1px solid ${C.line};border-radius:10px;font:12px/1.3 ${C.mono};color:${C.sub};margin-bottom:12px`,
        },
        [
          h("span", { style: `color:${C.accentSolid}` }, "◎"),
          h(
            "span",
            {
              style:
                "overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;min-width:0",
            },
            `${targetLabel}${t?.source ? ` · ${t.source.file.split("/").pop()}:${t.source.line ?? "?"}` : ""}`,
          ),
          conf
            ? h(
                "span",
                {
                  style: `flex:none;padding:1px 7px;border-radius:999px;font-size:10.5px;letter-spacing:.02em;${
                    isPoorSource
                      ? `background:${C.warnBg};color:${C.warnInk};border:1px solid ${C.warnLine}`
                      : `background:${C.goodBg};color:${C.good};border:1px solid ${C.goodLine}`
                  }`,
                },
                conf,
              )
            : null,
        ],
      ),
      // Bulletproof selection: if the pick is selector-only, refuse
      // to send and offer a re-pick. Telling claude "we couldn't
      // find the file" is worse than asking the user to try a
      // parent.
      isPoorSource
        ? h(
            "div",
            {
              style: `padding:9px 11px;background:${C.warnBg};border:1px solid ${C.warnLine};color:${C.warnInk};border-radius:10px;font-size:12px;margin-bottom:12px;line-height:1.4`,
            },
            [
              h(
                "div",
                { style: "font-weight:600;margin-bottom:3px" },
                "Couldn't resolve the source file for this element.",
              ),
              h(
                "div",
                {},
                "Try picking a parent — most often the issue is an unnamed wrapper. The selector alone isn't enough to find the file.",
              ),
            ],
          )
        : null,
      bundle?.screenshot
        ? h("img", {
            src: bundle.screenshot.dataUrl,
            // Honest preview: scale to the panel width and let the
            // captured bitmap's aspect ratio drive the height. A
            // generous max-height + `object-fit:contain` is the
            // safety net for unusually tall captures (full-page
            // backgrounds, sidebar columns) — letterboxes against
            // the dark surface rather than cropping out what the
            // user actually picked.
            style: `width:100%;height:auto;max-height:320px;object-fit:contain;background:#000;border:1px solid ${C.line};border-radius:10px;margin-bottom:12px;display:block`,
          })
        : bundle?.screenshotUnavailable
          ? h(
              "div",
              {
                style: `font-size:12px;color:${C.faint};background:${C.surface2};border:1px solid ${C.line};border-radius:10px;padding:10px;margin-bottom:12px;word-break:break-word`,
              },
              `Screenshot unavailable — ${bundle.screenshotUnavailable}`,
            )
          : null,
      // Tab-capture upgrade prompt — dev sink only. End users on the
      // cloud sink are reporting a bug, not optimising screenshot
      // fidelity; asking them to grant getDisplayMedia mid-report is
      // a trust ask that costs more reports than it improves. The
      // imperfection still rides along in `bundle.screenshot.qualityNote`
      // for reviewers to see in the ticket UI.
      isDev && bundle?.screenshot?.qualityNote && !tabCaptureActive
        ? h(
            "div",
            {
              style: `display:flex;align-items:center;gap:8px;padding:9px 11px;background:${C.warnBg};border:1px solid ${C.warnLine};color:${C.warnInk};border-radius:10px;font-size:12px;margin-bottom:12px`,
            },
            [
              h(
                "span",
                { style: "flex:1" },
                "Some content didn't capture cleanly. Enable tab capture for a pixel-perfect screenshot.",
              ),
              h(
                "button",
                {
                  onClick: () => void retryWithPixelPerfect(),
                  style: `all:unset;cursor:pointer;color:${C.accentSolid};font-weight:600;padding:2px 8px;border:1px solid ${C.line};border-radius:6px;background:${C.surface}`,
                },
                "Enable",
              ),
            ],
          )
        : null,
      tabCaptureActive
        ? h(
            "div",
            {
              style: `display:flex;align-items:center;gap:8px;padding:7px 11px;background:${C.goodBg};border:1px solid ${C.goodLine};color:${C.good};border-radius:10px;font-size:11.5px;margin-bottom:12px`,
            },
            [
              h("span", {
                style: `width:8px;height:8px;border-radius:50%;background:${C.good};box-shadow:0 0 6px ${C.good}`,
              }),
              h(
                "span",
                { style: "flex:1" },
                "Tab capture active — screenshots are pixel-perfect.",
              ),
              h(
                "button",
                {
                  onClick: () => stopDisplayMedia("user"),
                  style: `all:unset;cursor:pointer;color:${C.good};font-weight:600;padding:2px 6px`,
                },
                "Stop",
              ),
            ],
          )
        : null,
      h("textarea", {
        ref: (el: HTMLTextAreaElement | null) => {
          noteRef.current = el;
        },
        value: note,
        rows: 3,
        placeholder: placeholderText,
        disabled: sending,
        onInput: (e: Event) =>
          setNote((e.target as HTMLTextAreaElement).value),
        onKeyDown: onNoteKeyDown,
        style: `width:100%;box-sizing:border-box;font:14px/1.5 ${isDev ? C.mono : C.sans};color:${C.ink};background:${C.surface};border:1px solid ${C.line};border-radius:10px;padding:10px 12px;resize:none;outline:none`,
      }),
      h("div", { style: "display:flex;gap:8px;margin-top:12px" }, [
        h(
          "button",
          {
            onClick:
              sending || isPoorSource || (isDev && !note.trim())
                ? undefined
                : () => void send(),
            disabled: sending || isPoorSource || (isDev && !note.trim()),
            title: isDev && !note.trim() ? "Add a description first" : undefined,
            style: `flex:1;all:unset;text-align:center;cursor:${sending || isPoorSource || (isDev && !note.trim()) ? "default" : "pointer"};padding:11px;font:680 13.5px/1 ${C.sans};color:${C.buttonInk};background:${C.accent};border-radius:10px;box-shadow:0 2px 10px ${C.accentRing};opacity:${sending || isPoorSource || (isDev && !note.trim()) ? ".5" : "1"}`,
          },
          sendButtonLabel,
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
      // Dev-mode: companion state row (last). When connected, a
      // subtle "→ claude" indicator. When offline, an actionable
      // hint with the exact command to fix it.
      isDev
        ? h(
            "div",
            {
              style: `margin-top:12px;padding-top:10px;border-top:1px solid ${C.line};display:flex;align-items:center;gap:8px;font:11.5px/1.3 ${C.mono}`,
            },
            companionState === "connected"
              ? [
                  h("span", {
                    style: `width:7px;height:7px;border-radius:50%;background:${C.good};box-shadow:0 0 5px ${C.good};flex:none`,
                  }),
                  h(
                    "span",
                    { style: `color:${C.sub};flex:1` },
                    `→ ${companionDetail || "claude"}`,
                  ),
                ]
              : [
                  h("span", {
                    style: `width:7px;height:7px;border-radius:50%;background:${C.faint};flex:none`,
                  }),
                  h(
                    "span",
                    { style: `color:${C.faint};flex:1` },
                    companionState === "connecting"
                      ? "Connecting to companion…"
                      : "Companion offline — run `claude` and `/insitue:connect`",
                  ),
                ],
          )
        : null,
    ]),
    h(
      "div",
      {
        style: `display:flex;justify-content:flex-end;padding:9px 16px;border-top:1px solid ${C.line};color:${C.faint};font-size:11px`,
      },
      [
        h(
          "span",
          { title: `@insitue/sdk@${__SDK_VERSION__}` },
          `InSitue · v${__SDK_VERSION__}`,
        ),
      ],
    ),
  ]);
}

export function mountCaptureOnly(opts: CaptureOnlyOptions = {}): () => void {
  installRuntimeCollectors();
  const sink = resolveSink(opts);
  // Pixel-perfect default: explicit option wins. Otherwise, the
  // companion sink (= dev mode) opts in on first mount so hero
  // banners / motion components / text-over-image captures don't
  // suffer html-to-image's z-order trade-offs. We only set this on
  // first mount (no persisted settings yet) — if the dev later
  // turns it off via the widget's gear, that choice sticks.
  if (opts.defaultPixelPerfect === true) {
    setCaptureSettings({ alwaysPixelPerfect: true });
  } else if (
    opts.defaultPixelPerfect !== false &&
    sink.kind === "companion" &&
    !hasPersistedCaptureSettings()
  ) {
    setCaptureSettings({ alwaysPixelPerfect: true });
  }
  const host = document.createElement("div");
  host.id = "insitue-capture-root";
  host.setAttribute("data-insitue", "");
  document.body.appendChild(host);
  const shadow = host.attachShadow({ mode: "open" });
  const mount = document.createElement("div");
  shadow.appendChild(mount);
  render(
    h(CaptureApp, {
      sink,
      ...(opts.onCapture ? { onCapture: opts.onCapture } : {}),
    }),
    mount,
  );
  return () => {
    render(null, mount);
    host.remove();
  };
}
