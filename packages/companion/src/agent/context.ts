/**
 * Turns a CaptureBundle + the companion's resolved source into a tight,
 * grounded prompt. Best-effort secret redaction runs before anything
 * leaves for the agent.
 */
import type { AgentSessionInput } from "./provider.js";

const SECRET_PATTERNS: RegExp[] = [
  /\b(sk|pk|rk)-[A-Za-z0-9_-]{16,}\b/g,
  /\bghp_[A-Za-z0-9]{20,}\b/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, // JWT
  /\b(authorization|bearer|api[_-]?key|secret|password|token)\b\s*[:=]\s*\S+/gi,
  /([?&](?:token|key|secret|password|auth)=)[^&\s]+/gi,
];

export function redact(s: string): string {
  let out = s;
  for (const re of SECRET_PATTERNS) out = out.replace(re, "[redacted]");
  return out;
}

export function buildPrompt(input: AgentSessionInput): string {
  const { bundle, resolved, userMessage, history } = input;
  const t = bundle.target;
  const lines: string[] = [];

  lines.push(
    "You are InSitu's coding assistant. The developer selected a region",
    "of their running local app and is asking about it in situ. Use the",
    "grounded context below. Be concise and concrete.",
    "",
    "## Selected element",
    `- selector: ${t?.selector ?? "(none)"}`,
    `- source confidence: ${t?.confidence ?? "selector-only"}`,
  );
  if (t?.componentStack.length) {
    lines.push(
      `- component stack: ${t.componentStack.map((c) => c.name).join(" < ")}`,
    );
  }
  if (bundle.tailwindClasses.length) {
    lines.push(`- tailwind: ${bundle.tailwindClasses.join(" ")}`);
  }
  const styleKeys = Object.keys(bundle.computedStyles);
  if (styleKeys.length) {
    lines.push(
      `- key styles: ${styleKeys
        .slice(0, 10)
        .map((k) => `${k}:${bundle.computedStyles[k]}`)
        .join("; ")}`,
    );
  }
  lines.push(
    `- viewport: ${bundle.viewport.w}x${bundle.viewport.h} (${bundle.viewport.breakpoint ?? "?"})`,
  );
  if (bundle.runtime.errors.length) {
    lines.push(
      `- recent runtime errors: ${bundle.runtime.errors
        .slice(-3)
        .map((e) => redact(e.message))
        .join(" | ")}`,
    );
  }

  if (resolved) {
    lines.push(
      "",
      "## Source (resolved by InSitu — authoritative)",
      `${resolved.file}:${resolved.line}`,
      "```",
      resolved.snippet,
      "```",
    );
    if (resolved.componentFile && resolved.componentFile !== resolved.file) {
      lines.push(`(owning component: ${resolved.componentFile})`);
    }
  } else {
    lines.push(
      "",
      "## Source",
      "Not resolved to a file (selector-only). Use the selector + DOM",
      "context; ask for a file if you need certainty. Do NOT guess a path.",
    );
  }

  if (history && history.length) {
    lines.push(
      "",
      "## Conversation so far (same selection — keep this context)",
    );
    for (const m of history) {
      lines.push(
        `${m.role === "user" ? "Developer" : "You"}: ${redact(m.text)}`,
      );
    }
  }

  lines.push(
    "",
    "## Developer's request",
    redact(userMessage),
    "",
    "## How to respond",
    "You have read-only tools (Read/Grep/Glob) and CANNOT write files.",
    "InSitu applies changes only after the developer reviews a diff.",
    "",
    "- If this is a question: just answer concisely. Emit NO edit block.",
    "- If a code change is wanted: give a one/two-sentence explanation,",
    "  then emit the COMPLETE new contents of each file to change using",
    "  EXACTLY this protocol (raw bytes — do NOT wrap in ``` fences):",
    "",
    "=== INSITU EDIT: <repo-relative path> ===",
    "=== WHY: <one line> ===",
    "=== CONTENT ===",
    "<the entire new file contents>",
    "=== END INSITU EDIT ===",
    "",
    "Rules: full file contents, not a diff or snippet; one block per",
    "file; prefer the resolved file above; only files you are sure of;",
    "Read the file first if unsure of its current contents.",
  );

  return lines.join("\n");
}
