/**
 * Region picker. Element mode: hover-highlight + click. Rect mode:
 * drag a freeform region. ESC cancels. Ignores InSitue's own nodes.
 * The highlight layer lives at the top of <body> (not the overlay's
 * shadow root) so coordinates map 1:1 to the host page.
 */
import type { SelectionInput, SelectionMode } from "@insitue/capture-core";

const ACCENT = "#ff6b00";

function isOurs(el: Element | null): boolean {
  return !!el?.closest?.("#insitu-root, [data-insitu-layer]");
}

export function beginPick(
  mode: SelectionMode = "element",
): Promise<SelectionInput | null> {
  return new Promise((resolve) => {
    const layer = document.createElement("div");
    layer.setAttribute("data-insitu-layer", "");
    Object.assign(layer.style, {
      position: "fixed",
      inset: "0",
      zIndex: "2147483600",
      cursor: "crosshair",
      pointerEvents: mode === "rect" ? "auto" : "none",
      background: mode === "rect" ? "rgba(0,0,0,0.04)" : "transparent",
    } as CSSStyleDeclaration);

    const box = document.createElement("div");
    Object.assign(box.style, {
      position: "fixed",
      pointerEvents: "none",
      border: `2px solid ${ACCENT}`,
      background: "rgba(255,107,0,0.10)",
      borderRadius: "2px",
      transition: "all 40ms linear",
      display: "none",
      zIndex: "2147483601",
    } as CSSStyleDeclaration);
    layer.appendChild(box);
    document.body.appendChild(layer);

    const cleanup = () => {
      document.removeEventListener("mousemove", onMove, true);
      document.removeEventListener("click", onClick, true);
      document.removeEventListener("keydown", onKey, true);
      layer.removeEventListener("mousedown", onDown);
      layer.remove();
    };
    const finish = (sel: SelectionInput | null) => {
      cleanup();
      resolve(sel);
    };

    const drawTo = (r: DOMRect) => {
      box.style.display = "block";
      box.style.left = `${r.left}px`;
      box.style.top = `${r.top}px`;
      box.style.width = `${r.width}px`;
      box.style.height = `${r.height}px`;
    };

    // ── element mode ──
    const onMove = (e: MouseEvent) => {
      const el = document.elementFromPoint(e.clientX, e.clientY);
      if (!el || isOurs(el)) {
        box.style.display = "none";
        return;
      }
      drawTo(el.getBoundingClientRect());
    };
    const onClick = (e: MouseEvent) => {
      const el = document.elementFromPoint(e.clientX, e.clientY);
      if (!el || isOurs(el)) return;
      e.preventDefault();
      e.stopPropagation();
      finish({ mode: "element", pointerPath: [el] });
    };

    // ── rect mode ──
    let startX = 0;
    let startY = 0;
    const onDown = (e: MouseEvent) => {
      startX = e.clientX;
      startY = e.clientY;
      const onRectMove = (m: MouseEvent) => {
        const x = Math.min(startX, m.clientX);
        const y = Math.min(startY, m.clientY);
        drawTo(
          new DOMRect(x, y, Math.abs(m.clientX - startX), Math.abs(m.clientY - startY)),
        );
      };
      const onUp = (u: MouseEvent) => {
        layer.removeEventListener("mousemove", onRectMove);
        layer.removeEventListener("mouseup", onUp);
        const x = Math.min(startX, u.clientX);
        const y = Math.min(startY, u.clientY);
        finish({
          mode: "rect",
          rect: {
            x,
            y,
            width: Math.abs(u.clientX - startX),
            height: Math.abs(u.clientY - startY),
          },
        });
      };
      layer.addEventListener("mousemove", onRectMove);
      layer.addEventListener("mouseup", onUp);
    };

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        finish(null);
      }
    };

    if (mode === "rect") {
      layer.addEventListener("mousedown", onDown);
    } else {
      document.addEventListener("mousemove", onMove, true);
      document.addEventListener("click", onClick, true);
    }
    document.addEventListener("keydown", onKey, true);
  });
}
