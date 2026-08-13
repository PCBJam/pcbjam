import * as React from "react";
import { setPinRadiusPx } from "@/wasm/collab/pin-geometry";
import { PRESENCE_COLORS } from "@pcbjam/shared";
import { Palette, X } from "lucide-react";
import { observeOwnerJob } from "@/wasm/owner-job";

/**
 * DEV-TIME presence style tuner (VITE_PRESENCE_TUNER=1): live-patches the wasm
 * overlay style via kicadCollabSetStyle so we can try shapes, widths, alphas,
 * label placement, palettes etc. and pick the shipped defaults. Settings
 * persist in localStorage across reloads; "Copy JSON" exports the current
 * values to wire into collab_presence_style.h. "Demo peers/pins" injects
 * synthetic remote state (kicadCollabSetRemote/SetPins) so a SOLO tab can
 * preview everything — note a real awareness/comment change overwrites the
 * synthetic snapshot (re-toggle to restore).
 */

export interface TunerModule {
  kicadCollabSetStyle(json: string): Promise<void>;
  kicadCollabSetRemote(json: string): Promise<void>;
  kicadCollabSetPins(json: string): Promise<void>;
  kicadCollabGetViewport(): Promise<string>;
  kicadCollabTestListItems(n: number): Promise<string>;
  /** Varied demo groups (small/large footprint, busiest nets) — newer builds. */
  kicadCollabTestDemoSet?(): Promise<string>;
}

export function hasTunerBridge(mod: unknown): mod is TunerModule {
  const m = mod as Partial<TunerModule> | undefined;
  return (
    typeof m?.kicadCollabSetStyle === "function" &&
    typeof m?.kicadCollabTestListItems === "function"
  );
}

/** Mirror of collab_presence_style.h STYLE — defaults MUST match the C++
 *  (= the shipped look picked with this tuner, 2026-07-07). */
const DEFAULT_STYLE = {
  selShape: 5,
  selStrokeWidth: 6,
  selStrokeAlpha: 0.7,
  selFillAlpha: 0.46,
  selPaddingPx: 4,
  selCornerPx: 8,
  labelShow: true,
  labelSizePx: 7.5,
  labelChip: true,
  labelVPos: 1,
  labelHPos: 1,
  labelInside: false,
  labelOffsetPx: 0,
  chipBgAlpha: 0.7,
  cursorShape: 0,
  cursorSizePx: 8,
  cursorWidthPx: 3,
  cursorAlpha: 1,
  cursorLabel: true,
  cursorLabelSizePx: 10,
  cursorLabelChip: true,
  fixedColor: "",
  palette: [] as string[],
  pinShape: 1,
  pinRadiusPx: 9,
  pinRingPx: 4,
  pinRingAlpha: 0.9,
  pinFillAlpha: 0.9,
  pinResolvedAlpha: 0.3,
  pinUnreadRingColor: "#ffb020",
};

type Style = typeof DEFAULT_STYLE;

/** eeschema ships softer defaults (hairline outline, subtler fill/cursor) —
 *  MUST match collab_presence_style.h eeschemaDefaultStyle(). */
const EESCHEMA_OVERRIDES: Partial<Style> = {
  selStrokeWidth: 1,
  selFillAlpha: 0.14,
  cursorAlpha: 0.5,
};

function defaultsFor(tool: string): Style {
  return tool === "eeschema" ? { ...DEFAULT_STYLE, ...EESCHEMA_OVERRIDES } : { ...DEFAULT_STYLE };
}

const storeKey = (tool: string) => `pcbjam:presence-style:${tool}`;

function loadStored(tool: string): Style {
  try {
    const raw = localStorage.getItem(storeKey(tool));
    return raw ? { ...defaultsFor(tool), ...JSON.parse(raw) } : defaultsFor(tool);
  } catch {
    return defaultsFor(tool);
  }
}

const SEL_SHAPES = [
  "rectangle",
  "corner brackets",
  "underline",
  "rounded rect",
  "filled only",
  "exact outline (pcb)",
];
const CURSOR_SHAPES = ["cross", "pointer", "circle + dot"];
const PIN_SHAPES = ["circle dot", "bubble (sharp corner)"];
const VPOS = ["top", "bottom"];
const HPOS = ["start", "end", "center"];

/** Preset palettes for quick trials ("palette" color mode). */
const PALETTE_PRESETS: Record<string, readonly string[]> = {
  default: PRESENCE_COLORS,
  pastel: ["#f9a8d4", "#fca5a5", "#fdba74", "#fde047", "#86efac", "#5eead4", "#93c5fd", "#c4b5fd"],
  vivid: ["#e11d48", "#ea580c", "#ca8a04", "#16a34a", "#0d9488", "#0284c7", "#4f46e5", "#9333ea"],
  "okabe-ito": ["#E69F00", "#56B4E9", "#009E73", "#F0E442", "#0072B2", "#D55E00", "#CC79A7"],
};

export function PresenceTuner({ mod, tool }: { mod: TunerModule; tool: string }) {
  const [open, setOpen] = React.useState(true);
  const [style, setStyle] = React.useState<Style>(() => loadStored(tool));
  const [demo, setDemo] = React.useState(false);
  const [copied, setCopied] = React.useState(false);

  // Push on mount (restores a stored style after reload) + on every change.
  React.useEffect(() => {
    observeOwnerJob("set presence tuner style", () =>
      mod.kicadCollabSetStyle(JSON.stringify(style)),
    );
    // The DOM half of the comment pins (hit target / highlight / popover
    // offset in CommentLayer) mirrors the GAL radius — keep it in step with
    // the live re-style, or the highlight drifts off the drawn bubble.
    setPinRadiusPx(style.pinRadiusPx);
    try {
      localStorage.setItem(storeKey(tool), JSON.stringify(style));
    } catch {
      /* private mode */
    }
  }, [mod, tool, style]);

  const set = <K extends keyof Style>(k: K, v: Style[K]) =>
    setStyle((s) => ({ ...s, [k]: v }));

  const injectDemo = React.useCallback(
    async (on: boolean) => {
      setDemo(on);
      if (!on) {
        try {
          await mod.kicadCollabSetRemote(JSON.stringify({ peers: [] }));
          await mod.kicadCollabSetPins(JSON.stringify({ pins: [] }));
        } catch (error) {
          console.error(`[wasm-owner] clear presence tuner demo failed: ${String(error)}`);
        }
        return;
      }
      try {
        const vp = JSON.parse(await mod.kicadCollabGetViewport());
        const spanX = vp.w / vp.scale;
        const spanY = vp.h / vp.scale;
        // Varied selections (small + large footprint, two busiest nets) from
        // the demo-set helper; older wasm falls back to "first N items".
        let bobSel: string[] = [];
        let carolSel: string[] = [];
        try {
          const groupsJson = mod.kicadCollabTestDemoSet
            ? await mod.kicadCollabTestDemoSet()
            : '{"groups":[]}';
          const groups = (
            JSON.parse(groupsJson) as {
              groups: Array<{ label: string; ids: string[] }>;
            }
          ).groups;
          // bob: small fp + net A · carol: large fp + net B (whatever exists).
          for (const [i, g] of groups.entries()) {
            (i % 2 === 0 ? bobSel : carolSel).push(...g.ids);
          }
        } catch {
          /* fall through to the flat list */
        }
        if (!bobSel.length && !carolSel.length) {
          const items = JSON.parse(await mod.kicadCollabTestListItems(3)) as string[];
          bobSel = items.slice(0, 1);
          carolSel = items.slice(1, 3);
        }
        const peers = [
          {
            id: "demo-bob",
            name: "bob",
            color: PRESENCE_COLORS[8],
            cursor: { x: vp.cx - spanX * 0.18, y: vp.cy - spanY * 0.12 },
            selection: bobSel,
          },
          {
            id: "demo-carol",
            name: "carol",
            color: PRESENCE_COLORS[4],
            cursor: { x: vp.cx + spanX * 0.15, y: vp.cy + spanY * 0.16 },
            selection: carolSel,
          },
        ];
        const pins = [
          {
            id: "demo-pin-1",
            name: "bob",
            x: vp.cx - spanX * 0.05,
            y: vp.cy + spanY * 0.2,
            color: PRESENCE_COLORS[8],
            resolved: false,
          },
          {
            id: "demo-pin-2",
            name: "dave",
            x: vp.cx + spanX * 0.22,
            y: vp.cy - spanY * 0.18,
            color: PRESENCE_COLORS[0],
            resolved: false,
          },
        ];
        await mod.kicadCollabSetRemote(JSON.stringify({ peers }));
        await mod.kicadCollabSetPins(JSON.stringify({ pins }));
      } catch (error) {
        console.error(`[wasm-owner] set presence tuner demo failed: ${String(error)}`);
      }
    },
    [mod],
  );

  const copyJson = async () => {
    try {
      await navigator.clipboard.writeText(JSON.stringify(style, null, 2));
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard unavailable */
    }
  };

  if (!open) {
    return (
      <button
        title="Presence style tuner"
        onClick={() => setOpen(true)}
        className="absolute left-3 top-12 z-40 flex h-8 w-8 items-center justify-center rounded-full bg-fuchsia-700 text-white shadow-lg"
      >
        <Palette size={15} />
      </button>
    );
  }

  return (
    <div className="absolute left-3 top-12 z-40 flex max-h-[80vh] w-72 flex-col overflow-hidden rounded-lg bg-black/90 text-white shadow-xl ring-1 ring-inset ring-fuchsia-400/40">
      <div className="flex items-center justify-between bg-fuchsia-900/60 px-3 py-2">
        <span className="flex items-center gap-1.5 text-xs font-semibold">
          <Palette size={13} /> Presence tuner <span className="text-white/50">(dev)</span>
        </span>
        <button onClick={() => setOpen(false)} className="text-white/70 hover:text-white">
          <X size={14} />
        </button>
      </div>

      <div className="flex gap-2 border-b border-white/10 px-3 py-2">
        <button
          onClick={() => injectDemo(!demo)}
          className={`rounded px-2 py-1 text-[11px] ring-1 ring-inset ring-white/25 ${
            demo ? "bg-fuchsia-600" : "hover:bg-white/10"
          }`}
        >
          {demo ? "Demo on" : "Demo peers"}
        </button>
        <button
          onClick={copyJson}
          className="rounded px-2 py-1 text-[11px] ring-1 ring-inset ring-white/25 hover:bg-white/10"
        >
          {copied ? "Copied ✓" : "Copy JSON"}
        </button>
        <button
          onClick={() => {
            setStyle(defaultsFor(tool));
            localStorage.removeItem(storeKey(tool));
          }}
          className="rounded px-2 py-1 text-[11px] ring-1 ring-inset ring-white/25 hover:bg-white/10"
        >
          Reset
        </button>
      </div>

      <div className="overflow-y-auto px-3 pb-3 text-[11px]">
        <Section title="Selection box">
          <Select label="shape" value={style.selShape} options={SEL_SHAPES} onChange={(v) => set("selShape", v)} />
          <Range label="border px" v={style.selStrokeWidth} min={0.5} max={8} step={0.5} onChange={(v) => set("selStrokeWidth", v)} />
          <Range label="border α" v={style.selStrokeAlpha} min={0.1} max={1} step={0.05} onChange={(v) => set("selStrokeAlpha", v)} />
          <Range label="infill α" v={style.selFillAlpha} min={0} max={0.6} step={0.02} onChange={(v) => set("selFillAlpha", v)} />
          <Range label="padding px" v={style.selPaddingPx} min={0} max={20} step={1} onChange={(v) => set("selPaddingPx", v)} />
          <Range label="corner px" v={style.selCornerPx} min={2} max={24} step={1} onChange={(v) => set("selCornerPx", v)} />
        </Section>

        <Section title="Name tag">
          <Check label="show" v={style.labelShow} onChange={(v) => set("labelShow", v)} />
          <Range label="size px" v={style.labelSizePx} min={5} max={20} step={0.5} onChange={(v) => set("labelSizePx", v)} />
          <Check label="chip background" v={style.labelChip} onChange={(v) => set("labelChip", v)} />
          <Range label="chip α" v={style.chipBgAlpha} min={0.2} max={1} step={0.05} onChange={(v) => set("chipBgAlpha", v)} />
          <Select label="v-pos" value={style.labelVPos} options={VPOS} onChange={(v) => set("labelVPos", v)} />
          <Select label="h-pos" value={style.labelHPos} options={HPOS} onChange={(v) => set("labelHPos", v)} />
          <Check label="inside box" v={style.labelInside} onChange={(v) => set("labelInside", v)} />
          <Range label="offset px" v={style.labelOffsetPx} min={0} max={24} step={1} onChange={(v) => set("labelOffsetPx", v)} />
        </Section>

        <Section title="Cursor">
          <Select label="shape" value={style.cursorShape} options={CURSOR_SHAPES} onChange={(v) => set("cursorShape", v)} />
          <Range label="size px" v={style.cursorSizePx} min={3} max={20} step={0.5} onChange={(v) => set("cursorSizePx", v)} />
          <Range label="line px" v={style.cursorWidthPx} min={0.5} max={6} step={0.25} onChange={(v) => set("cursorWidthPx", v)} />
          <Range label="alpha" v={style.cursorAlpha} min={0.2} max={1} step={0.05} onChange={(v) => set("cursorAlpha", v)} />
          <Check label="name label" v={style.cursorLabel} onChange={(v) => set("cursorLabel", v)} />
          <Range label="label px" v={style.cursorLabelSizePx} min={5} max={20} step={0.5} onChange={(v) => set("cursorLabelSizePx", v)} />
          <Check label="label chip" v={style.cursorLabelChip} onChange={(v) => set("cursorLabelChip", v)} />
        </Section>

        <ColorsSection style={style} set={set} />

        <Section title="Comment pins">
          <Select label="shape" value={style.pinShape} options={PIN_SHAPES} onChange={(v) => set("pinShape", v)} />
          <Range label="radius px" v={style.pinRadiusPx} min={3} max={16} step={0.5} onChange={(v) => set("pinRadiusPx", v)} />
          <Range label="ring px" v={style.pinRingPx} min={0} max={5} step={0.25} onChange={(v) => set("pinRingPx", v)} />
          <Range label="ring α" v={style.pinRingAlpha} min={0} max={1} step={0.05} onChange={(v) => set("pinRingAlpha", v)} />
          {/* Bubble radius mirrors into the DOM hit target via pin-geometry.ts
              — tuner drift is dev-only, ship values must land in BOTH
              collab_presence_style.h and pin-geometry.ts. */}
          <Range label="fill α" v={style.pinFillAlpha} min={0.2} max={1} step={0.05} onChange={(v) => set("pinFillAlpha", v)} />
        </Section>
      </div>
    </div>
  );
}

/**
 * Color overrides, made explicit: one MODE at a time —
 *   per-user  · the colors peers publish (shipped behavior; overrides off)
 *   fixed     · everyone in ONE picked color
 *   palette   · recolor everyone from a trial palette (by name hash)
 * Recolors the CANVAS overlay only (boxes/cursors/pins); roster avatars and
 * comment popovers keep the sender colors. Palette editing is buffered and
 * applied on demand so typing partial hex values doesn't fight the input.
 */
function ColorsSection({
  style,
  set,
}: {
  style: Style;
  set: <K extends keyof Style>(k: K, v: Style[K]) => void;
}) {
  const mode = style.fixedColor ? "fixed" : style.palette.length ? "palette" : "per-user";
  const [fixedPick, setFixedPick] = React.useState(style.fixedColor || "#3b82f6");
  const [paletteText, setPaletteText] = React.useState(
    (style.palette.length ? style.palette : [...PRESENCE_COLORS]).join(", "),
  );

  const parsePalette = (text: string) =>
    text
      .split(/[,\s]+/)
      .map((s) => s.trim())
      .filter((s) => /^#[0-9a-fA-F]{6}$/.test(s));

  const setMode = (m: "per-user" | "fixed" | "palette") => {
    if (m === "per-user") {
      set("fixedColor", "");
      set("palette", []);
    } else if (m === "fixed") {
      set("palette", []);
      set("fixedColor", fixedPick);
    } else {
      set("fixedColor", "");
      set("palette", parsePalette(paletteText));
    }
  };

  const applyPalette = (colors: readonly string[]) => {
    setPaletteText(colors.join(", "));
    set("fixedColor", "");
    set("palette", [...colors]);
  };

  return (
    <Section title="Colors">
      <p className="mb-1 text-[10px] leading-snug text-white/45">
        Recolors the canvas overlay (boxes, cursors, pins). Roster avatars keep
        the sender colors.
      </p>
      <div className="mb-1 flex gap-2">
        {(["per-user", "fixed", "palette"] as const).map((m) => (
          <label key={m} className="flex items-center gap-1">
            <input type="radio" checked={mode === m} onChange={() => setMode(m)} />
            <span className={mode === m ? "text-white" : "text-white/60"}>{m}</span>
          </label>
        ))}
      </div>

      {mode === "fixed" && (
        <div className="mb-1 flex items-center gap-2">
          <span className="w-24 text-white/60">color</span>
          <input
            type="color"
            value={fixedPick}
            onChange={(e) => {
              setFixedPick(e.target.value);
              set("fixedColor", e.target.value);
            }}
            className="h-5 w-8"
          />
          <span className="text-white/40">{style.fixedColor}</span>
        </div>
      )}

      {mode === "palette" && (
        <div className="mb-1 space-y-1">
          <div className="flex flex-wrap gap-1">
            {Object.entries(PALETTE_PRESETS).map(([name, colors]) => (
              <button
                key={name}
                onClick={() => applyPalette(colors)}
                className="rounded px-1.5 py-0.5 text-[10px] ring-1 ring-inset ring-white/25 hover:bg-white/10"
              >
                {name}
              </button>
            ))}
          </div>
          <textarea
            value={paletteText}
            onChange={(e) => setPaletteText(e.target.value)}
            placeholder="#ef4444, #22c55e, …"
            className="h-12 w-full resize-none rounded bg-white/10 p-1 font-mono text-[10px] text-white outline-none"
          />
          <div className="flex items-center gap-2">
            <button
              onClick={() => set("palette", parsePalette(paletteText))}
              className="rounded bg-fuchsia-700 px-2 py-0.5 text-[10px] hover:bg-fuchsia-600"
            >
              Apply
            </button>
            <span className="text-[10px] text-white/40">
              {parsePalette(paletteText).length} colors
            </span>
          </div>
          <div className="flex gap-1">
            {(style.palette.length ? style.palette : parsePalette(paletteText)).map((c, i) => (
              <span key={i} className="h-3 w-3 rounded-sm" style={{ background: c }} />
            ))}
          </div>
        </div>
      )}
    </Section>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <details open className="mt-2">
      <summary className="cursor-pointer text-xs font-semibold text-fuchsia-300">{title}</summary>
      <div className="mt-1 space-y-1">{children}</div>
    </details>
  );
}

function Range({
  label,
  v,
  min,
  max,
  step,
  onChange,
}: {
  label: string;
  v: number;
  min: number;
  max: number;
  step: number;
  onChange: (v: number) => void;
}) {
  return (
    <label className="flex items-center gap-2">
      <span className="w-24 shrink-0 text-white/60">{label}</span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={v}
        onChange={(e) => onChange(Number(e.target.value))}
        className="min-w-0 flex-1"
      />
      <span className="w-9 text-right text-white/80">{v}</span>
    </label>
  );
}

function Check({ label, v, onChange }: { label: string; v: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="flex items-center gap-2">
      <span className="w-24 shrink-0 text-white/60">{label}</span>
      <input type="checkbox" checked={v} onChange={(e) => onChange(e.target.checked)} />
    </label>
  );
}

function Select({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: number;
  options: string[];
  onChange: (v: number) => void;
}) {
  return (
    <label className="flex items-center gap-2">
      <span className="w-24 shrink-0 text-white/60">{label}</span>
      <select
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="flex-1 rounded bg-white/10 px-1 py-0.5 text-white"
      >
        {options.map((o, i) => (
          <option key={o} value={i} className="bg-neutral-900">
            {o}
          </option>
        ))}
      </select>
    </label>
  );
}
