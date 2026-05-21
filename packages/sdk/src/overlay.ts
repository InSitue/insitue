/**
 * The overlay: Preact in a Shadow DOM (style-isolated from the host).
 *
 * Conversational (M6): a real message thread per selection — the agent
 * can ask, you reply in-thread, and continuity is preserved (the
 * companion replays the transcript). A persistent working indicator
 * (animated · last tool activity · elapsed) shows what it's doing
 * during the long stretches before/between tokens. Completed edits
 * still file into the Session timeline (revisit / continue / undo).
 */
import { h, render } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import type {
  CaptureBundle,
  ResolvedSource,
  SelectionInput,
} from "@insitue/capture-core";
import { CompanionClient, type ConnState } from "./client.js";
import { installRuntimeCollectors, runtimeErrorCount } from "./runtime.js";
import { beginPick } from "./picker.js";
import { buildBundle } from "./capture.js";

export interface InSitueOptions {
  port?: number;
}

type Change = { file: string; diff: string; bytes: number };
type TurnStatus = "applied" | "undone" | "committed";
type ChatMsg = { role: "user" | "agent"; text: string };
interface HistoryEntry {
  turnId: string;
  prompt: string;
  sel: SelectionInput | null;
  files: string[];
  checkpointRef: string;
  diff: Change[];
  status: TurnStatus;
  note: string;
  postError: boolean;
}

const DOT: Record<ConnState, string> = {
  idle: "#888",
  connecting: "#e0a30c",
  connected: "#2fd16b",
  error: "#ff6b6b",
};
const muted = "#8a8a93";
const accent = "#ff6b00";
const mono = "12px ui-monospace, SFMono-Regular, Menlo, monospace";
const btn =
  "font:inherit;color:#ff6b00;background:transparent;border:1px solid #2e2e3c;border-radius:4px;padding:3px 8px;cursor:pointer";
const card = "background:#0b0b0d;border:1px solid #232330;border-radius:4px";

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

/** Render an agent message body with fenced ``` code blocks
 *  styled as monospace cards. No syntax highlighting in v1 —
 *  keeps the bundle small; visual separation alone is the win.
 *  Plain text segments preserve whitespace via `pre-wrap`. */
function renderMessageBody(text: string) {
  // Split on lines that are just ``` (with optional language tag).
  // Odd-indexed segments after split are the code-block bodies.
  const parts: { code: boolean; lang: string; text: string }[] = [];
  const lines = text.split("\n");
  let buf: string[] = [];
  let inCode = false;
  let lang = "";
  const flush = () => {
    if (buf.length === 0) return;
    parts.push({ code: inCode, lang, text: buf.join("\n") });
    buf = [];
  };
  for (const line of lines) {
    const fence = /^```(\w*)\s*$/.exec(line);
    if (fence) {
      flush();
      inCode = !inCode;
      lang = inCode ? (fence[1] ?? "") : "";
      continue;
    }
    buf.push(line);
  }
  flush();
  return parts.map((p) =>
    p.code
      ? h(
          "div",
          {
            style: `${card};padding:8px;margin:4px 0;font:${mono};color:#ececef;overflow-x:auto;white-space:pre`,
          },
          p.text,
        )
      : h(
          "div",
          { style: "white-space:pre-wrap;word-break:break-word" },
          p.text,
        ),
  );
}

function diffBlock(changes: Change[]) {
  return changes.map((c) =>
    h("div", { style: "margin:6px 0" }, [
      h(
        "div",
        { style: "color:#ececef;margin-bottom:2px" },
        `${c.file}  (${c.bytes}B)`,
      ),
      h(
        "div",
        {
          style: `overflow:auto;${card};padding:8px;max-height:200px;font-size:11px;line-height:1.45`,
        },
        diffLines(c.diff),
      ),
    ]),
  );
}

function App(props: { port: number }) {
  const [state, setState] = useState<ConnState>("idle");
  const [detail, setDetail] = useState("");
  const [client, setClient] = useState<CompanionClient | null>(null);
  const [bundle, setBundle] = useState<CaptureBundle | null>(null);
  const [resolved, setResolved] = useState<ResolvedSource | null>(null);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);
  const [showCtx, setShowCtx] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [autoApply, setAutoApply] = useState(false);
  const [agentReady, setAgentReady] = useState<boolean | null>(null);
  const [agentNote, setAgentNote] = useState("");
  const [chatInput, setChatInput] = useState("");
  const [messages, setMessages] = useState<ChatMsg[]>([]);
  const [turnBusy, setTurnBusy] = useState(false);
  const [thinking, setThinking] = useState("");
  const [activity, setActivity] = useState("");
  const [elapsed, setElapsed] = useState(0);
  const [pulse, setPulse] = useState(0);
  const [changes, setChanges] = useState<Change[]>([]);
  const [changeTurnId, setChangeTurnId] = useState("");
  const [picked, setPicked] = useState<Record<string, boolean>>({});
  const [rejectReason, setRejectReason] = useState("");
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [revisitId, setRevisitId] = useState("");
  const [commitMsg, setCommitMsg] = useState("");
  const [sessionNote, setSessionNote] = useState("");
  const [lastSel, setLastSel] = useState<SelectionInput | null>(null);
  const [activeTurn, setActiveTurn] = useState<{
    turnId: string;
    prompt: string;
    sel: SelectionInput | null;
  } | null>(null);

  const autoApplyRef = useRef(false);
  const changesRef = useRef<Change[]>([]);
  const activeTurnRef = useRef<typeof activeTurn>(null);
  const threadRef = useRef<HTMLDivElement | null>(null);
  // For the ⌘K shortcut — needs to find the textarea even when
  // the panel is collapsed. Set on the panel root below.
  const panelRef = useRef<HTMLDivElement | null>(null);
  autoApplyRef.current = autoApply;
  changesRef.current = changes;
  activeTurnRef.current = activeTurn;

  // Append a streaming delta to the trailing agent message (or start
  // one). Keeps the thread coherent across many small deltas.
  const appendAgent = (delta: string) =>
    setMessages((ms) => {
      const last = ms[ms.length - 1];
      if (last && last.role === "agent") {
        return [...ms.slice(0, -1), { role: "agent", text: last.text + delta }];
      }
      return [...ms, { role: "agent", text: delta }];
    });

  // #147 M4 — session continuity across reloads.
  // Scope by origin (a dev's localhost:3000 = one project; two
  // projects on different ports get separate keys). Persist the
  // durable bits (messages, history, autoApply, last selection
  // hint, the open/collapsed state) — skip transient runtime
  // (turnBusy, agentReady, in-flight diffs).
  const storageKey = `insitue:session:${typeof window !== "undefined" ? window.location.origin : "default"}`;
  const hydratedRef = useRef(false);

  useEffect(() => {
    if (hydratedRef.current) return;
    hydratedRef.current = true;
    try {
      const raw = window.localStorage.getItem(storageKey);
      if (!raw) return;
      const saved = JSON.parse(raw) as {
        messages?: ChatMsg[];
        history?: HistoryEntry[];
        autoApply?: boolean;
        open?: boolean;
      };
      if (Array.isArray(saved.messages)) setMessages(saved.messages);
      if (Array.isArray(saved.history)) setHistory(saved.history);
      if (typeof saved.autoApply === "boolean") setAutoApply(saved.autoApply);
      if (typeof saved.open === "boolean") setOpen(saved.open);
    } catch {
      /* corrupt entry — drop it, fresh session */
    }
  }, [storageKey]);

  useEffect(() => {
    if (!hydratedRef.current) return;
    try {
      window.localStorage.setItem(
        storageKey,
        JSON.stringify({ messages, history, autoApply, open }),
      );
    } catch {
      /* quota / private-browsing — non-fatal */
    }
  }, [messages, history, autoApply, open, storageKey]);

  useEffect(() => {
    installRuntimeCollectors();
    const c = new CompanionClient(props.port, {
      onState: (s, d) => {
        setState(s);
        if (d !== undefined) setDetail(d);
      },
      onResolved: (_id, r) => setResolved(r),
      onAgentStatus: (s) => {
        setAgentReady(s.ready);
        setAgentNote(
          s.blockers.length
            ? `blocked: ${s.blockers.join("; ")}`
            : s.warnings.join(" · ") || `agent ready (${s.transport})`,
        );
      },
      onAgentEvent: (e) => {
        if (e.t === "agent-text") {
          setThinking("");
          setActivity("");
          appendAgent(e.delta);
        } else if (e.t === "agent-thinking") {
          setThinking(e.note.slice(-160));
        } else if (e.t === "agent-activity") {
          setActivity(e.label);
        } else if (e.t === "agent-turn-complete") {
          setThinking("");
          setActivity("");
          setTurnBusy(false);
        } else if (e.t === "agent-error") {
          setThinking("");
          setActivity("");
          appendAgent(`\n\n[agent-error] ${e.message}`);
          setTurnBusy(false);
        }
      },
      onChangeset: (turnId, files) => {
        setChangeTurnId(turnId);
        setChanges(files);
        setPicked(Object.fromEntries(files.map((f) => [f.file, true])));
        setRejectReason("");
        if (autoApplyRef.current) {
          appendAgent(`\n[insitu] auto-apply on — writing without review`);
          c.sendDecision(turnId, "approve");
        }
      },
      onApplied: (turnId, files, ref) => {
        const at = activeTurnRef.current;
        const entry: HistoryEntry = {
          turnId,
          prompt: at && at.turnId === turnId ? at.prompt : "(applied change)",
          sel: at && at.turnId === turnId ? at.sel : null,
          files,
          checkpointRef: ref,
          diff: changesRef.current,
          status: "applied",
          note: "HMR reloading…",
          postError: false,
        };
        setHistory((hs) => [entry, ...hs]);
        setMessages((ms) => [
          ...ms,
          {
            role: "agent",
            text: `✓ applied ${files.length} file${files.length > 1 ? "s" : ""} → filed to Session (${ref})`,
          },
        ]);
        setChanges([]);
        setChangeTurnId("");
        setActiveTurn(null);
        setSessionNote("");
        const base = runtimeErrorCount();
        let ticks = 0;
        const iv = setInterval(() => {
          ticks++;
          const threw = runtimeErrorCount() > base;
          if (threw || ticks >= 10) {
            setHistory((hs) =>
              hs.map((en) =>
                en.turnId === turnId
                  ? {
                      ...en,
                      note: threw
                        ? "⚠ host threw after HMR"
                        : "HMR settled clean",
                      postError: threw,
                    }
                  : en,
              ),
            );
            clearInterval(iv);
          }
        }, 500);
      },
      onUndone: (turnId) =>
        setHistory((hs) =>
          hs.map((en) =>
            en.turnId === turnId
              ? { ...en, status: "undone", note: "undone — HMR reverting" }
              : en,
          ),
        ),
      onSessionUndone: () =>
        setHistory((hs) =>
          hs.map((en) =>
            en.status === "applied" ? { ...en, status: "undone" } : en,
          ),
        ),
      onSessionCommitted: (commit) => {
        setHistory((hs) =>
          hs.map((en) =>
            en.status === "applied" ? { ...en, status: "committed" } : en,
          ),
        );
        setSessionNote(`committed as ${commit} (local only — not pushed)`);
      },
    });
    setClient(c);
    void c.connect();
    return () => c.dispose();
  }, [props.port]);

  // elapsed (1s) + pulse (~300ms) while a turn runs → live "working".
  useEffect(() => {
    if (!turnBusy) {
      setElapsed(0);
      setPulse(0);
      return;
    }
    const t0 = Date.now();
    const a = setInterval(
      () => setElapsed(Math.floor((Date.now() - t0) / 1000)),
      1000,
    );
    const b = setInterval(() => setPulse((p) => p + 1), 300);
    return () => {
      clearInterval(a);
      clearInterval(b);
    };
  }, [turnBusy]);

  // autoscroll the thread as it grows / streams
  useEffect(() => {
    const el = threadRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, changes, turnBusy, activity]);

  // ⌘K / Ctrl-K opens the panel and focuses the chat input;
  // Esc closes when the input is empty. Mirrors Cursor / Linear
  // / Claude Desktop muscle memory.
  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      const meta = ev.metaKey || ev.ctrlKey;
      if (meta && ev.key === "k") {
        ev.preventDefault();
        setOpen(true);
        setTimeout(() => {
          const ta = panelRef.current?.querySelector(
            "textarea",
          ) as HTMLTextAreaElement | null;
          ta?.focus();
        }, 0);
      } else if (ev.key === "Escape" && open && !chatInput.trim()) {
        setOpen(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, chatInput]);

  const captureSel = async (sel: SelectionInput) => {
    setLastSel(sel);
    const b = await buildBundle(sel);
    setBundle(b);
    setResolved(null);
    setMessages([]); // new selection ⇒ fresh conversation thread
    setChanges([]);
    setRevisitId("");
    setOpen(true);
    setShowCtx(false);
    client?.submitCapture(b);
    return b;
  };

  const pick = async (mode: "element" | "rect") => {
    if (!client || state !== "connected") return;
    setBusy(true);
    try {
      const sel = await beginPick(mode);
      if (sel) await captureSel(sel);
    } finally {
      setBusy(false);
    }
  };

  const sendChat = () => {
    if (!client || !chatInput.trim() || turnBusy) return;
    const text = chatInput.trim();
    // Slash commands — local, no agent round-trip. Matches the
    // Claude / Cursor convention (`/clear`, `/undo`, `/commit`).
    if (text.startsWith("/")) {
      const [cmd, ...rest] = text.split(/\s+/);
      if (cmd === "/clear") {
        setMessages([]);
        setChatInput("");
        return;
      }
      if (cmd === "/undo") {
        // Undo the most recent applied turn from history if any.
        const top = history.find((h) => h.status === "applied");
        if (top) client.sendUndo(top.turnId);
        setChatInput("");
        return;
      }
      if (cmd === "/commit") {
        const msg = rest.join(" ") || "Apply InSitue session changes";
        client.sendCommitSession(msg);
        setChatInput("");
        return;
      }
      // Unknown command — keep as plain text so the agent sees it.
    }
    if (!bundle) return;
    const turnId = bundle.id; // events key by bundle id
    setActiveTurn({ turnId, prompt: text, sel: lastSel });
    setMessages((ms) => [...ms, { role: "user", text }]);
    setChatInput("");
    setChanges([]);
    setRevisitId("");
    setActivity("starting");
    setTurnBusy(true);
    client.sendTurn(turnId, bundle.id, text);
  };

  const continueFrom = async (e: HistoryEntry) => {
    if (!client || !e.sel || busy || turnBusy) return;
    setBusy(true);
    try {
      await captureSel(e.sel);
      setChatInput("");
    } finally {
      setBusy(false);
    }
  };

  const recaptureFix = async (e: HistoryEntry) => {
    if (!client || !e.sel || busy || turnBusy) return;
    setBusy(true);
    try {
      const b = await captureSel(e.sel);
      if (b.runtime.errors.length > 0) {
        const turnId = b.id;
        const text = "fix the runtime error from the previous change";
        setActiveTurn({ turnId, prompt: text, sel: e.sel });
        setMessages([{ role: "user", text }]);
        setActivity("starting");
        setTurnBusy(true);
        client.sendTurn(
          turnId,
          b.id,
          "Your previous edit was applied but the running app now reports the runtime errors shown in the context above. Diagnose the cause and propose a corrected edit.",
        );
      } else {
        setMessages([
          { role: "agent", text: "[insitu] re-captured — no runtime errors" },
        ]);
      }
    } finally {
      setBusy(false);
    }
  };

  const approve = () => {
    const chosen = changes
      .map((c) => c.file)
      .filter((f) => picked[f] !== false);
    client?.sendDecision(
      changeTurnId,
      "approve",
      chosen.length === changes.length ? undefined : chosen,
    );
  };
  const reject = () => {
    client?.sendDecision(
      changeTurnId,
      "reject",
      undefined,
      rejectReason.trim() || undefined,
    );
    setChanges([]);
    setMessages((ms) => [
      ...ms,
      { role: "agent", text: "[insitu] changes rejected" },
    ]);
  };

  const t = bundle?.target;
  const targetSummary = t
    ? `${t.componentStack[0]?.name ?? t.selector.split(">").pop()?.trim() ?? "selection"} · ${t.confidence}`
    : "no selection";
  const appliedCount = history.filter((e) => e.status === "applied").length;
  const revisit = history.find((e) => e.turnId === revisitId) || null;
  const spin = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

  const pill = {
    position: "fixed",
    bottom: "16px",
    right: "16px",
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

  const ctx =
    bundle && showCtx
      ? h("div", { style: "margin:8px 0;color:#bfbfc6" }, [
          row("confidence", t?.confidence ?? "—"),
          row("selector", t?.selector ?? "—"),
          row(
            "components",
            t?.componentStack.map((c) => c.name).join(" < ") || "—",
          ),
          row("tailwind", bundle.tailwindClasses.join(" ") || "—"),
          row("styles", `${Object.keys(bundle.computedStyles).length} props`),
          row(
            "runtime",
            `${bundle.runtime.console.length} log · ${bundle.runtime.network.length} net · ${bundle.runtime.errors.length} err`,
          ),
          row(
            "screenshot",
            bundle.screenshot
              ? "captured"
              : bundle.screenshotUnavailable
                ? `unavailable — ${bundle.screenshotUnavailable}`
                : "—",
          ),
          bundle.screenshot
            ? h("img", {
                src: bundle.screenshot.dataUrl,
                style: `max-width:100%;margin:8px 0;${card}`,
              })
            : null,
          resolved
            ? h(
                "pre",
                {
                  style: `white-space:pre;overflow:auto;${card};padding:10px;margin:6px 0 0;color:#bfbfc6;max-height:160px`,
                },
                `${resolved.file}:${resolved.line}\n\n${resolved.snippet}`,
              )
            : null,
        ])
      : null;

  const workingRow =
    turnBusy &&
    h(
      "div",
      {
        style: `display:flex;gap:8px;align-items:center;margin:6px 0 0;color:${accent}`,
      },
      [
        h("span", {}, spin[pulse % spin.length]),
        h(
          "span",
          {
            style: `color:${muted};overflow:hidden;text-overflow:ellipsis;white-space:nowrap`,
          },
          `${activity || "working"} · ${elapsed}s`,
        ),
        h(
          "button",
          {
            style: `${btn};margin-left:auto`,
            onClick: () => {
              client?.cancelTurn("cur");
              setTurnBusy(false);
            },
          },
          "stop",
        ),
      ],
    );

  const thread = h(
    "div",
    {
      ref: threadRef,
      style: `max-height:300px;overflow:auto;margin:6px 0;display:flex;flex-direction:column;gap:6px`,
    },
    [
      ...messages.map((m, i) =>
        h(
          "div",
          {
            style:
              m.role === "user"
                ? `align-self:flex-end;max-width:88%;${card};border-color:#2e2e3c;padding:6px 8px;color:#ececef;white-space:pre-wrap;word-break:break-word;cursor:pointer`
                : `align-self:flex-start;max-width:96%;padding:6px 8px;color:#ececef`,
            // Click any prior user message to re-populate the
            // input — matches Claude.ai / Cursor edit-and-retry.
            // The original turn stays in the thread; sending
            // creates a new turn.
            onClick:
              m.role === "user"
                ? () => {
                    setChatInput(m.text);
                    setTimeout(() => {
                      const ta = panelRef.current?.querySelector(
                        "textarea",
                      ) as HTMLTextAreaElement | null;
                      ta?.focus();
                    }, 0);
                  }
                : undefined,
            title: m.role === "user" ? "click to edit + retry" : undefined,
          },
          m.role === "agent" ? renderMessageBody(m.text) : m.text,
        ),
      ),
      thinking && turnBusy
        ? h(
            "div",
            {
              style: `align-self:flex-start;color:${muted};font-style:italic;white-space:pre-wrap;word-break:break-word`,
            },
            `💭 ${thinking}`,
          )
        : null,
    ],
  );

  const proposed = changes.length
    ? h("div", { style: "margin-top:8px" }, [
        h(
          "div",
          {
            style: `color:${accent};margin-bottom:4px;display:flex;justify-content:space-between;align-items:center`,
          },
          [
            h(
              "span",
              {},
              `PROPOSED · ${changes.length} file${changes.length > 1 ? "s" : ""}`,
            ),
            h(
              "span",
              { style: "display:flex;gap:6px;align-items:center" },
              [
                h(
                  "button",
                  { style: btn, onClick: approve },
                  "Approve & write",
                ),
                h(
                  "button",
                  { style: `${btn};color:${muted}`, onClick: reject },
                  "Reject",
                ),
              ],
            ),
          ],
        ),
        h("input", {
          value: rejectReason,
          placeholder: "reject reason (optional) — fed to the agent",
          onInput: (ev: Event) =>
            setRejectReason((ev.target as HTMLInputElement).value),
          style: `width:100%;box-sizing:border-box;font:inherit;color:#ececef;${card};padding:5px 7px;margin:4px 0 6px`,
        }),
        ...changes.map((c) =>
          h("div", { style: "margin:6px 0" }, [
            h(
              "label",
              {
                style:
                  "color:#ececef;margin-bottom:2px;display:flex;gap:6px;align-items:center;cursor:pointer",
              },
              [
                h("input", {
                  type: "checkbox",
                  checked: picked[c.file] !== false,
                  onChange: (ev: Event) =>
                    setPicked((p) => ({
                      ...p,
                      [c.file]: (ev.target as HTMLInputElement).checked,
                    })),
                }),
                h("span", {}, `${c.file}  (${c.bytes}B)`),
              ],
            ),
            h(
              "div",
              {
                style: `overflow:auto;${card};padding:8px;max-height:200px;font-size:11px;line-height:1.45`,
              },
              diffLines(c.diff),
            ),
          ]),
        ),
      ])
    : null;

  const conversation = revisit
    ? h(
        "div",
        { style: `margin-top:8px;border-top:1px solid #232330;padding-top:8px` },
        [
          h(
            "div",
            {
              style: `color:${accent};margin-bottom:6px;display:flex;justify-content:space-between;align-items:center`,
            },
            [
              h("span", {}, `REVISIT · ${revisit.prompt}`.slice(0, 52)),
              h(
                "button",
                { style: btn, onClick: () => setRevisitId("") },
                "close",
              ),
            ],
          ),
          h(
            "div",
            { style: `color:${muted};margin-bottom:6px` },
            `${revisit.status} · ${revisit.files.join(", ")} · ${revisit.checkpointRef}`,
          ),
          ...diffBlock(revisit.diff),
        ],
      )
    : bundle
      ? h(
          "div",
          {
            style: `margin-top:8px;border-top:1px solid #232330;padding-top:8px`,
          },
          [
            h(
              "div",
              {
                style: `color:${accent};margin-bottom:6px;display:flex;justify-content:space-between`,
              },
              [
                h("span", {}, "ASK"),
                autoApply
                  ? h("span", { style: `color:${accent}` }, "auto-apply ON")
                  : null,
              ],
            ),
            agentReady === false
              ? h(
                  "div",
                  { style: "color:#ff6b6b;margin-bottom:6px" },
                  agentNote,
                )
              : agentNote && !messages.length
                ? h(
                    "div",
                    { style: `color:${muted};margin-bottom:6px` },
                    agentNote,
                  )
                : null,
            messages.length ? thread : null,
            workingRow,
            proposed,
            h("textarea", {
              value: chatInput,
              placeholder: messages.length
                ? "reply… (the agent remembers this thread) · /undo /clear /commit"
                : "what does this do? · make the padding bigger · fix this bug · ⌘K to focus",
              rows: 2,
              onInput: (ev: Event) =>
                setChatInput((ev.target as HTMLTextAreaElement).value),
              onKeyDown: (ev: KeyboardEvent) => {
                if ((ev.metaKey || ev.ctrlKey) && ev.key === "Enter")
                  sendChat();
              },
              style: `width:100%;box-sizing:border-box;font:inherit;color:#ececef;${card};padding:8px;margin-top:8px;resize:vertical`,
            }),
            h(
              "div",
              { style: "margin-top:6px" },
              h(
                "button",
                {
                  style: btn,
                  disabled:
                    turnBusy || !chatInput.trim() || agentReady === false,
                  onClick: sendChat,
                },
                turnBusy ? `…working ${elapsed}s` : "Send (⌘↵)",
              ),
            ),
          ],
        )
      : null;

  const timeline = history.length
    ? h(
        "div",
        { style: `margin-top:8px;border-top:1px solid #232330;padding-top:8px` },
        [
          h(
            "div",
            {
              style: `color:${accent};margin-bottom:6px;display:flex;justify-content:space-between;align-items:center`,
            },
            [
              h("span", {}, `SESSION · ${appliedCount} live`),
              appliedCount > 0
                ? h(
                    "button",
                    {
                      style: `${btn};color:${muted}`,
                      onClick: () => client?.sendUndoSession(),
                    },
                    "Undo all",
                  )
                : null,
            ],
          ),
          ...history.map((e) => {
            const glyph =
              e.status === "applied"
                ? "✓"
                : e.status === "committed"
                  ? "◆"
                  : "⤺";
            const dim = e.status !== "applied";
            return h(
              "div",
              {
                style: `${card};padding:6px 8px;margin:4px 0;${dim ? "opacity:0.6;" : ""}`,
              },
              [
                h(
                  "div",
                  {
                    style:
                      "display:flex;justify-content:space-between;gap:8px;align-items:center",
                  },
                  [
                    h(
                      "span",
                      {
                        style:
                          "color:#ececef;overflow:hidden;text-overflow:ellipsis;white-space:nowrap",
                      },
                      `${glyph} ${e.prompt}`,
                    ),
                    h("span", { style: "display:flex;gap:6px;flex:none" }, [
                      h(
                        "button",
                        { style: btn, onClick: () => setRevisitId(e.turnId) },
                        "Revisit",
                      ),
                      e.sel
                        ? h(
                            "button",
                            { style: btn, onClick: () => void continueFrom(e) },
                            "Continue",
                          )
                        : null,
                      e.status === "applied"
                        ? h(
                            "button",
                            {
                              style: btn,
                              onClick: () => client?.sendUndo(e.turnId),
                            },
                            "Undo",
                          )
                        : null,
                    ]),
                  ],
                ),
                h(
                  "div",
                  { style: `color:${muted};margin-top:3px` },
                  `${e.files.join(", ")} · ${e.checkpointRef}`,
                ),
                e.note
                  ? h(
                      "div",
                      {
                        style: `margin-top:3px;color:${e.postError ? "#ff7a7a" : "#5fd18a"};display:flex;justify-content:space-between;align-items:center`,
                      },
                      [
                        h("span", {}, e.note),
                        e.postError && e.sel
                          ? h(
                              "button",
                              {
                                style: `${btn};color:#0f0f12;background:${accent};border-color:${accent}`,
                                onClick: () => void recaptureFix(e),
                              },
                              "⚠ Re-capture & fix",
                            )
                          : null,
                      ],
                    )
                  : null,
              ],
            );
          }),
          appliedCount > 0
            ? h(
                "div",
                {
                  style:
                    "display:flex;gap:6px;align-items:center;margin-top:6px",
                },
                [
                  h("input", {
                    value: commitMsg,
                    placeholder: "commit message (optional)",
                    onInput: (ev: Event) =>
                      setCommitMsg((ev.target as HTMLInputElement).value),
                    style: `flex:1;box-sizing:border-box;font:inherit;color:#ececef;${card};padding:5px 7px`,
                  }),
                  h(
                    "button",
                    {
                      style: btn,
                      onClick: () =>
                        client?.sendCommitSession(
                          commitMsg.trim() || undefined,
                        ),
                    },
                    "Commit (local)",
                  ),
                ],
              )
            : null,
          sessionNote
            ? h("div", { style: "color:#5fd18a;margin-top:6px" }, sessionNote)
            : null,
        ],
      )
    : null;

  const settings = showSettings
    ? h("div", { style: `${card};padding:10px;margin:8px 0` }, [
        h(
          "label",
          {
            style:
              "display:flex;gap:8px;align-items:center;cursor:pointer;color:#ececef",
          },
          [
            h("input", {
              type: "checkbox",
              checked: autoApply,
              onChange: (ev: Event) =>
                setAutoApply((ev.target as HTMLInputElement).checked),
            }),
            h("span", {}, "Auto-apply (skip review)"),
          ],
        ),
        h(
          "div",
          { style: `color:${muted};margin-top:4px` },
          "Writes proposed changes immediately. Still checkpointed & undoable; no manual gate. Resets on reload.",
        ),
      ])
    : null;

  const panel = open
    ? h(
        "div",
        {
          ref: panelRef,
          style: {
            position: "fixed",
            bottom: "64px",
            right: "16px",
            width: "440px",
            maxHeight: "82vh",
            overflow: "auto",
            zIndex: 2147483000,
            font: mono,
            color: "#ececef",
            background: "rgba(15,15,18,0.97)",
            border: "1px solid #2e2e3c",
            borderRadius: "8px",
            padding: "12px 14px",
            boxShadow: "0 10px 36px rgba(0,0,0,0.55)",
          },
        },
        [
          h(
            "div",
            {
              style:
                "display:flex;justify-content:space-between;align-items:center;gap:8px",
            },
            [
              h(
                "span",
                {
                  style: `color:${accent};overflow:hidden;text-overflow:ellipsis;white-space:nowrap`,
                },
                targetSummary,
              ),
              h("span", { style: "display:flex;gap:6px;flex:none" }, [
                bundle
                  ? h(
                      "button",
                      { style: btn, onClick: () => setShowCtx((v) => !v) },
                      showCtx ? "details ▾" : "details ▸",
                    )
                  : null,
                h(
                  "button",
                  { style: btn, onClick: () => setShowSettings((v) => !v) },
                  "⚙",
                ),
                h(
                  "button",
                  { style: btn, onClick: () => setOpen(false) },
                  "close",
                ),
              ]),
            ],
          ),
          settings,
          ctx,
          conversation,
          timeline,
          !bundle && !history.length
            ? h(
                "div",
                { style: `color:${muted};margin-top:10px` },
                "Pick an element to start.",
              )
            : null,
        ],
      )
    : null;

  return h("div", {}, [
    panel,
    h("div", { style: pill }, [
      h("span", {
        style: `width:8px;height:8px;border-radius:50%;background:${DOT[state]};display:inline-block`,
      }),
      h("strong", { style: "letter-spacing:0.08em" }, "InSitue"),
      h(
        "span",
        {
          style: `color:${muted};max-width:160px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap`,
        },
        turnBusy ? `${spin[pulse % spin.length]} ${activity || "working"}` : detail || state,
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
      bundle || history.length
        ? h(
            "button",
            { onClick: () => setOpen((v) => !v), style: btn },
            open ? "hide" : "panel",
          )
        : null,
    ]),
  ]);
}

export function mountInSitue(opts: InSitueOptions = {}): () => void {
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
