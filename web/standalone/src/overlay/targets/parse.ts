/**
 * Target ids — the only way content refers to UI. Never pixels.
 *
 *   tool:<action.name>        toolbar button by KiCad action (M2, engine hook)
 *   tooltip:<text>            toolbar button by the first tooltip line
 *                             (friendly name, hotkey stripped) — language-
 *                             dependent fallback until `tool:` resolves
 *   menu:<Title>              menu bar title
 *   menu:<Title>/<Item>       an item of that menu's open popup
 *   panel:<id>                our own DOM: [data-overlay-target="<id>"]
 *   area:<x>,<y>,<w>,<h>      a canvas rect in world IU
 *   point:<x>,<y>             a canvas point in world IU
 */

export type ParsedTarget =
  | { ns: "tool"; action: string }
  | { ns: "tooltip"; text: string }
  | { ns: "menu"; title: string; item?: string }
  | { ns: "panel"; id: string }
  | { ns: "area"; x: number; y: number; w: number; h: number }
  | { ns: "point"; x: number; y: number };

function numbers(s: string, n: number): number[] | null {
  const parts = s.split(",").map((p) => p.trim());
  if (parts.length !== n || parts.some((p) => p === "")) return null;
  const out = parts.map(Number);
  return out.every(Number.isFinite) ? out : null;
}

export function parseTarget(target: string): ParsedTarget | null {
  const colon = target.indexOf(":");
  if (colon <= 0) return null;
  const ns = target.slice(0, colon);
  const rest = target.slice(colon + 1);
  if (!rest) return null;
  switch (ns) {
    case "tool":
      return { ns, action: rest };
    case "tooltip":
      return { ns, text: rest };
    case "menu": {
      const slash = rest.indexOf("/");
      if (slash < 0) return { ns, title: rest };
      const title = rest.slice(0, slash);
      const item = rest.slice(slash + 1);
      return title && item ? { ns, title, item } : null;
    }
    case "panel":
      return { ns, id: rest };
    case "area": {
      const v = numbers(rest, 4);
      if (!v) return null;
      const [x, y, w, h] = v as [number, number, number, number];
      return w < 0 || h < 0 ? null : { ns, x, y, w, h };
    }
    case "point": {
      const v = numbers(rest, 2);
      if (!v) return null;
      const [x, y] = v as [number, number];
      return { ns, x, y };
    }
    default:
      return null;
  }
}

/**
 * A wx label/tooltip reduced to what a user reads as its name: first line,
 * no `\t(hotkey)` / `\tCtrl+X` accelerator, no `&` mnemonics, no trailing
 * ellipsis, no check/submenu glyphs.
 */
export function normalizeUiLabel(raw: string): string {
  let s = raw.split("\n")[0] ?? "";
  s = s.split("\t")[0] ?? "";
  s = s.replace(/&&/g, "\u0000").replace(/&/g, "").replace(/\u0000/g, "&");
  s = s.replace(/^[\s✓]+/, "").replace(/\s*▸\s*$/, "");
  s = s.replace(/(\.\.\.|…)\s*$/, "");
  return s.trim().toLowerCase();
}
