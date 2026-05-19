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
  const { bundle, resolved, userMessage } = input;
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

  lines.push(
    "",
    "## Developer's request",
    redact(userMessage),
    "",
    "Read-only for now: explain or propose, do NOT modify files.",
  );

  return lines.join("\n");
}
