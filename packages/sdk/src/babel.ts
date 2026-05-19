/**
 * Babel fallback: stamp every intrinsic JSX element with
 * `data-insitu-source="relpath:line:col"`. The resolver prefers React
 * fiber `_debugSource` (Next dev provides it for free); this is the
 * portable fallback for Vite/CRA/Babel setups or where fiber source
 * is absent. DEV ONLY — never wire this into a production build.
 *
 * Modeled on the well-known annotate-react technique; written here so
 * the project owns the IP (no fork, permissive only).
 */
import { relative, sep } from "node:path";

interface BabelTypes {
  jsxAttribute(name: unknown, value: unknown): unknown;
  jsxIdentifier(name: string): unknown;
  stringLiteral(value: string): unknown;
}
interface PluginState {
  opts?: { root?: string };
  file?: { opts?: { filename?: string } };
  filename?: string;
}

export default function insituSourcePlugin(babel: {
  types: BabelTypes;
}): { name: string; visitor: Record<string, unknown> } {
  const t = babel.types;
  return {
    name: "insitu-source",
    visitor: {
      JSXOpeningElement(
        path: {
          node: {
            name: { type: string; name?: string };
            attributes: Array<{
              type: string;
              name?: { name?: string };
            }>;
            loc?: { start: { line: number; column: number } };
          };
        },
        state: PluginState,
      ) {
        const node = path.node;
        if (node.name.type !== "JSXIdentifier" || !node.name.name) return;
        // intrinsic host elements only (lowercase) — component
        // elements don't forward unknown attributes to the DOM.
        const c0 = node.name.name[0]!;
        if (c0 < "a" || c0 > "z") return;
        if (
          node.attributes.some(
            (a) => a.type === "JSXAttribute" && a.name?.name === "data-insitu-source",
          )
        )
          return;
        const loc = node.loc;
        if (!loc) return;
        const filename = state.file?.opts?.filename ?? state.filename;
        if (!filename) return;
        const root = state.opts?.root ?? process.cwd();
        const rel = relative(root, filename).split(sep).join("/");
        const value = `${rel}:${loc.start.line}:${loc.start.column + 1}`;
        node.attributes.push(
          t.jsxAttribute(
            t.jsxIdentifier("data-insitu-source"),
            t.stringLiteral(value),
          ) as never,
        );
      },
    },
  };
}
