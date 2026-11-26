/**
 * The live layer: what a running circuit shows on the schematic, and what the
 * user can press there. It sits above the drawing area and is ours (DOM), not
 * KiCad's: a zone over a push button, a slider under a potentiometer, a glow
 * on an LED, a number under a meter.
 *
 * Which widgets, where, bound to what: wasm/live-overlay.ts (a part names its
 * widgets, the editor says where its symbol is). This file draws them:
 *
 *   - they follow pan and zoom (the editor's viewport is read every frame
 *     while the layer is up) and a symbol that is moved, rotated or mirrored
 *     (the symbols' places are read ten times a second);
 *   - only the open sheet has widgets; another sheet opened while it runs
 *     gets its own;
 *   - what the user sets goes to the engine; the values come back with every
 *     look at the circuit (live-session.ts, onFrame) and are written straight
 *     to the widgets' elements, without a render;
 *   - the layer takes the clicks on its zones and sliders only. Everything
 *     else falls through to the canvas, and so do the wheel and the middle
 *     and right mouse buttons over a zone: pan, zoom and KiCad's menu work
 *     everywhere;
 *   - the editor hears every key that is pressed on the page, unless a text
 *     field has the keyboard. A zone never takes the keyboard; the slider
 *     keeps the keys that are pressed on it to itself (End would be KiCad's
 *     "double-click at the cursor") and gives the keyboard back after a drag;
 *   - a tag (a slider, a meter's number) hangs under its symbol and can be
 *     dragged off what it covers; a double-click puts it back. Where it was
 *     put is kept in the browser (wasm/live-tag-places.ts), not in the
 *     schematic. Zoomed out, the tags are drawn smaller, and zoomed in
 *     close they grow with the sheet;
 *   - a symbol the run leaves out (nothing has a model for it) gets a dashed
 *     frame and, when there is room, the words "not simulated";
 *   - KiCad draws its dialogs on the canvas, under this layer: while one is
 *     open the widgets are not drawn (a zone that is held lets go), and while
 *     a modal one is open the editor is not asked anything.
 */
import * as React from "react";
import { Button, Slider } from "@pcbjam/ui";
import { cssRatio, glCanvasRect, type CssRect } from "@/wasm/canvas-coords";
import { worldToScreen, type ViewportState } from "@/wasm/collab/comments";
import type { LiveFrame } from "@/wasm/live-engine";
import {
  countValue,
  fixedValue,
  createInputSender,
  formatValue,
  leftOutFor,
  readPlaces,
  screenBox,
  widgetsFor,
  type LeftOutMark,
  type LiveWidget,
  type ScreenBox,
  type ZoneLine,
  type SheetPlaces,
  type SimPlacesModule,
  mixColors,
  sliderText,
  soundRings,
} from "@/wasm/live-overlay";
import type { LiveSession } from "@/wasm/live-session";
import { toneHz } from "@/wasm/live-sound";
import { loadTagShifts, saveTagShifts, shiftBox, tagScale, withTagShift, type TagShift, type TagShifts } from "@/wasm/live-tag-places";
import { parseViewport } from "@/wasm/viewport-store";
import { anyDialogOpen, anyModalDialogOpen, onEditorEvent } from "@/overlay/editor-events";

/** How often the symbols' places are read, in ms. */
const PLACES_MS = 100;
/** A meter's number changes this often at most, in ms: digits that flicker cannot be read. */
const METER_MS = 150;
/** Widgets with a size of their own (slider, meter) hide when a millimetre is fewer CSS px than this. */
const FAR_PX_PER_MM = 1.5;

/** The values of one look at the circuit, by the simulator's name of the value. */
interface Values {
  latest(vector: string): number | undefined;
  avg(vector: string): number | undefined;
}
type Updaters = Map<string, (values: Values) => void>;

interface LayerContext {
  updaters: Updaters;
  /**
   * What the user set in this run, by the simulator's name of the input. It is
   * kept here and not in the widget: a widget goes away when its sheet is
   * left or its symbol is off the screen, and comes back as it was.
   */
  set: Readonly<Record<string, number>>;
  setInput: (vector: string, value: number) => void;
  /** A press of the middle or right button on a zone: the canvas gets it, and the drag that follows. */
  toCanvas: (e: React.PointerEvent) => void;
  /** "pointer-events-auto", or "pointer-events-none" while such a drag goes on. */
  hit: string;
  /** Puts a tag somewhere else (a shift from its own place, in mm of the sheet), or back (`null`). */
  moveTag: (key: string, shift: TagShift | null) => void;
  /** Remembers where the tags are now. */
  saveTags: () => void;
  /** The layer's own element: a tag is not dragged out of it. */
  layerEl: React.RefObject<HTMLDivElement | null>;
}
const Context = React.createContext<LayerContext | null>(null);
const useLayer = (): LayerContext => React.useContext(Context)!;

/** Runs `update` with every look at the circuit, for as long as the widget is there. */
function useValues(key: string, update: (values: Values) => void): void {
  const { updaters } = useLayer();
  const latest = React.useRef(update);
  latest.current = update;
  React.useEffect(() => {
    const fn = (values: Values) => latest.current(values);
    updaters.set(key, fn);
    return () => {
      if (updaters.get(key) === fn) updaters.delete(key);
    };
  }, [updaters, key]);
}

// --- the canvas under the layer ---------------------------------------------

const editorCanvas = (): HTMLElement | null => document.getElementById("canvas");

type MouseInit = Pick<MouseEvent, "clientX" | "clientY" | "ctrlKey" | "shiftKey" | "altKey" | "metaKey">;
const keysOf = (e: MouseInit): MouseEventInit => ({
  bubbles: true,
  cancelable: true,
  clientX: e.clientX,
  clientY: e.clientY,
  ctrlKey: e.ctrlKey,
  shiftKey: e.shiftKey,
  altKey: e.altKey,
  metaKey: e.metaKey,
});

/** The editor learns where the mouse is also over a zone: it zooms around that point. */
function moveToCanvas(e: React.PointerEvent): void {
  if (e.pointerType !== "mouse") return;
  editorCanvas()?.dispatchEvent(new MouseEvent("mousemove", { ...keysOf(e), button: 0, buttons: e.buttons }));
}

function wheelToCanvas(e: React.WheelEvent): void {
  editorCanvas()?.dispatchEvent(
    new WheelEvent("wheel", { ...keysOf(e), deltaX: e.deltaX, deltaY: e.deltaY, deltaMode: e.deltaMode }),
  );
}

/** A click on a zone leaves the keyboard where it was (the editor's hotkeys keep working). */
const keepFocus = (e: React.MouseEvent): void => e.preventDefault();

/** No browser menu over a widget: the right button is the editor's. */
const noMenu = (e: React.MouseEvent): void => e.preventDefault();

/** A key pressed on a widget that has the keyboard is the widget's: the editor does not hear it. */
function ownKey(e: React.KeyboardEvent): void {
  e.stopPropagation();
  if (e.key === "Escape" && e.type === "keydown") (document.activeElement as HTMLElement | null)?.blur();
}

/** After a drag with the mouse the keyboard is the editor's again. */
function giveKeyboardBack(e: React.PointerEvent<HTMLElement>): void {
  const active = document.activeElement;
  if (active instanceof HTMLElement && e.currentTarget.contains(active)) active.blur();
}

// --- the widgets ------------------------------------------------------------

/** How a tag (a slider, a meter's number) is drawn right now. The other widgets do not look at it. */
interface TagView {
  /** How many times its full size it is drawn at: smaller on a sheet that is zoomed out, larger on one that is close. */
  scale: number;
  /** CSS px in a millimetre of the sheet. */
  pxPerMm: number;
  /** Where the user dragged it to, when they did. */
  shift?: TagShift;
}

interface WidgetProps {
  widget: LiveWidget;
  box: ScreenBox;
  tag: TagView;
}

const zoneClass =
  "absolute cursor-pointer rounded-md ring-1 ring-inset ring-sky-500/40 transition-colors hover:bg-sky-400/10 hover:ring-2 hover:ring-sky-500/70 focus-visible:outline-none";
const zoneOnClass = "bg-sky-400/30 ring-2 ring-sky-500 hover:bg-sky-400/30";

const boxStyle = (box: ScreenBox): React.CSSProperties => ({
  left: box.left,
  top: box.top,
  width: box.width,
  height: box.height,
});

/**
 * The contacts that move with a zone, each drawn where it is now: a changeover switch shows
 * which way it is thrown, a DIP switch which of its switches are closed. The lines are in
 * fractions of the zone's box, so the drawing scales with it.
 */
function ZoneLines({ lines, on }: { lines: ZoneLine[]; on: boolean }): React.ReactElement {
  return (
    <svg
      data-testid="live-zone-lines"
      data-position={on ? "on" : "off"}
      className="pointer-events-none absolute inset-0 h-full w-full overflow-visible text-sky-600 dark:text-sky-400"
      viewBox="0 0 1 1"
      preserveAspectRatio="none"
      aria-hidden="true"
    >
      {lines.map((line, i) => {
        const [x1, y1, x2, y2] = on ? line.on : line.off;
        return (
          <line key={i} x1={x1} y1={y1} x2={x2} y2={y2} stroke="currentColor" strokeWidth={3} strokeLinecap="round" vectorEffect="non-scaling-stroke" />
        );
      })}
    </svg>
  );
}

/** What a zone is called: its symbol, and its own name when the symbol has several ("SW1, switch 3"). */
function zoneName(widget: LiveWidget): string {
  const label = widget.props.label;
  return typeof label === "string" && label ? `${widget.ref}, switch ${label}` : widget.ref;
}

/** A zone to hold down: held while the primary button is down on it. */
function PressZone({ widget, box }: WidgetProps): React.ReactElement | null {
  const { setInput, toCanvas, hit } = useLayer();
  const [held, setHeld] = React.useState(false);
  const input = widget.input!;
  const spec = input.input;
  const isHeld = React.useRef(false);
  const set = React.useCallback(
    (down: boolean) => {
      if (spec.type !== "momentary" || isHeld.current === down) return;
      isHeld.current = down;
      setHeld(down);
      setInput(input.vector, down ? spec.held : spec.released);
    },
    [input.vector, setInput, spec],
  );
  // A zone that goes away while it is held (its symbol was deleted, the sheet was left) lets go.
  React.useEffect(() => () => set(false), [set]);
  if (spec.type !== "momentary") return null;
  return (
    <Button
      data-testid="live-press"
      data-ref={widget.ref}
      data-held={held}
      aria-label={`${widget.ref}: hold to press`}
      aria-pressed={held}
      title={`${widget.ref}: hold to press`}
      tabIndex={-1}
      variant="plain"
      size="text"
      className={`${zoneClass} ${hit} ${held ? zoneOnClass : ""}`}
      style={{ ...boxStyle(box), touchAction: "none" }}
      onMouseDown={keepFocus}
      onContextMenu={noMenu}
      onPointerDown={(e) => {
        if (e.button !== 0) return toCanvas(e);
        e.currentTarget.setPointerCapture(e.pointerId);
        set(true);
      }}
      onPointerUp={(e) => {
        if (e.button === 0) set(false);
      }}
      onPointerCancel={() => set(false)}
      onLostPointerCapture={() => set(false)}
      onPointerMove={moveToCanvas}
      onWheel={wheelToCanvas}
    >
      {widget.lines && <ZoneLines lines={widget.lines} on={held} />}
    </Button>
  );
}

/** A zone to click: on, and on the next click off. */
function ToggleZone({ widget, box }: WidgetProps): React.ReactElement | null {
  const { set, setInput, toCanvas, hit } = useLayer();
  const input = widget.input!;
  const spec = input.input;
  if (spec.type !== "toggle") return null;
  const on = (set[input.vector] ?? input.initial) === spec.on;
  // A changeover has two sides and neither is "on": its part says highlight: false.
  const lit = on && widget.props.highlight !== false;
  return (
    <Button
      data-testid="live-toggle"
      data-ref={widget.ref}
      data-input={spec.name}
      data-on={on}
      aria-label={`${zoneName(widget)}: click to switch ${on ? "off" : "on"}`}
      aria-pressed={on}
      title={`${zoneName(widget)}: click to switch ${on ? "off" : "on"}`}
      tabIndex={-1}
      variant="plain"
      size="text"
      className={`${zoneClass} ${hit} ${lit ? zoneOnClass : ""}`}
      style={{ ...boxStyle(box), touchAction: "none" }}
      onMouseDown={keepFocus}
      onContextMenu={noMenu}
      onPointerDown={(e) => {
        if (e.button !== 0) return toCanvas(e);
        setInput(input.vector, on ? spec.off : spec.on);
      }}
      onPointerMove={moveToCanvas}
      onWheel={wheelToCanvas}
    >
      {widget.lines ? (
        <ZoneLines lines={widget.lines} on={on} />
      ) : (
        <span className="pointer-events-none absolute left-1/2 top-0 -translate-x-1/2 -translate-y-full whitespace-nowrap rounded-sm bg-white/90 px-1 text-[10px] font-semibold leading-4 text-sky-700 dark:bg-neutral-900/90 dark:text-sky-300">
          {on ? "ON" : "OFF"}
        </span>
      )}
    </Button>
  );
}

const tagClass =
  "absolute select-none whitespace-nowrap rounded-md bg-white/90 px-2 py-1 text-[11px] leading-4 text-neutral-900 shadow ring-1 ring-inset ring-black/10 hover:z-10 dark:bg-neutral-900/90 dark:text-white dark:ring-white/15";

/** A tag hangs from the middle of its upper edge, and shrinks and grows from there. */
const tagStyle = (box: ScreenBox, tag: TagView): React.CSSProperties => ({
  left: box.left,
  top: box.top,
  transform: `translateX(-50%) scale(${tag.scale})`,
  transformOrigin: "50% 0",
});

const MOVE_HINT = "Drag to move it. A double-click puts it back.";
/** A tag is not dragged closer to the layer's edge than this, in CSS px: it can be taken again. */
const EDGE_PX = 12;
const between = (v: number, low: number, high: number): number => (high < low ? v : Math.max(low, Math.min(high, v)));

/**
 * A tag is dragged by its handle with the primary button. The drag is the tag's own (the
 * editor does not hear it); the wheel and the other buttons are the editor's, as on a zone.
 */
function useTagMove(widget: LiveWidget, tag: TagView): { moving: boolean; handle: React.HTMLAttributes<HTMLElement> } {
  const { moveTag, saveTags, toCanvas, layerEl } = useLayer();
  const [moving, setMoving] = React.useState(false);
  const drag = React.useRef<{ x: number; y: number; at: [number, number] } | null>(null);
  const view = React.useRef(tag);
  view.current = tag;
  const end = (): void => {
    if (!drag.current) return;
    drag.current = null;
    setMoving(false);
    saveTags();
  };
  return {
    moving,
    handle: {
      title: MOVE_HINT,
      onMouseDown: keepFocus,
      onContextMenu: noMenu,
      onPointerDown: (e) => {
        if (e.button !== 0) return toCanvas(e);
        e.currentTarget.setPointerCapture(e.pointerId);
        const [dx, dy] = view.current.shift ?? [0, 0];
        drag.current = { x: e.clientX, y: e.clientY, at: [dx, dy] };
        setMoving(true);
      },
      onPointerMove: (e) => {
        const from = drag.current;
        if (!from) return moveToCanvas(e);
        const edge = layerEl.current?.getBoundingClientRect();
        const x = edge ? between(e.clientX, edge.left + EDGE_PX, edge.right - EDGE_PX) : e.clientX;
        const y = edge ? between(e.clientY, edge.top + EDGE_PX, edge.bottom - EDGE_PX) : e.clientY;
        // step by step: the wheel may zoom the sheet while the tag is held
        const pxPerMm = view.current.pxPerMm;
        from.at = [from.at[0] + (x - from.x) / pxPerMm, from.at[1] + (y - from.y) / pxPerMm];
        from.x = x;
        from.y = y;
        moveTag(widget.key, from.at);
      },
      onPointerUp: end,
      onPointerCancel: end,
      onLostPointerCapture: end,
      onDoubleClick: () => {
        moveTag(widget.key, null);
        saveTags();
      },
    },
  };
}

/**
 * A slider under the symbol: from the least to the most the part allows. It says where it
 * stands in percent; a part that gives its slider a unit has the value itself there (a
 * thermistor's degrees, a light sensor's lux).
 */
function SliderWidget({ widget, box, tag }: WidgetProps): React.ReactElement | null {
  const { set, setInput, hit } = useLayer();
  const { moving, handle } = useTagMove(widget, tag);
  const input = widget.input!;
  const spec = input.input;
  if (spec.type !== "range" || spec.max === spec.min) return null;
  const span = spec.max - spec.min;
  const value = set[input.vector] ?? input.initial;
  const percent = Math.round(((value - spec.min) / span) * 100);
  const unit = typeof widget.props.unit === "string" && widget.props.unit ? widget.props.unit : undefined;
  const text = sliderText(value, spec.min, spec.max, unit, widget.props.scale === "log");
  return (
    <div
      data-testid="live-slider"
      data-ref={widget.ref}
      data-percent={percent}
      data-text={text}
      data-moved={tag.shift !== undefined}
      className={`${tagClass} ${hit} ${moving ? "z-10" : ""} flex items-center gap-2`}
      style={tagStyle(box, tag)}
      onContextMenu={noMenu}
      onWheel={wheelToCanvas}
      onKeyDown={ownKey}
      onKeyUp={ownKey}
      onPointerUp={giveKeyboardBack}
    >
      <Slider
        min={0}
        max={100}
        step={1}
        value={[percent]}
        onValueChange={([next]) => {
          if (next === undefined) return;
          setInput(input.vector, spec.min + (span * next) / 100);
        }}
        thumbLabel={`${widget.ref}: ${spec.name}`}
        className="w-24"
      />
      {/* the knob is dragged along its track, so the tag is moved by its words */}
      <span
        data-testid="live-tag-handle"
        className={`min-w-[4.5rem] text-right tabular-nums ${moving ? "cursor-grabbing" : "cursor-grab"}`}
        style={{ touchAction: "none" }}
        {...handle}
      >
        {widget.ref} {text}
      </span>
    </div>
  );
}

const RED: [number, number, number] = [255, 58, 40];
const LED_COLOR: Record<string, [number, number, number]> = {
  red: RED,
  green: [50, 215, 90],
  blue: [64, 140, 255],
  yellow: [255, 200, 40],
  white: [255, 244, 220],
};

const clamp01 = (v: number): number => (v > 0 ? (v < 1 ? v : 1) : 0);

/** Light that follows a current: its average over the look, so a fast blink reads as brightness. */
function Glow({ widget, box }: WidgetProps): React.ReactElement {
  const el = React.useRef<HTMLDivElement>(null);
  const level = React.useRef(0);
  const full = typeof widget.props.full === "number" && widget.props.full > 0 ? widget.props.full : 0.01;
  const [r, g, b] = LED_COLOR[String(widget.props.color)] ?? RED;
  const vector = widget.signal!.vector;
  useValues(widget.key, (values) => {
    const target = clamp01((values.avg(vector) ?? 0) / full);
    level.current += (target - level.current) * 0.45;
    if (level.current < 0.002 && target === 0) level.current = 0;
    if (!el.current) return;
    el.current.style.opacity = String(Math.pow(level.current, 0.6));
    el.current.dataset.level = level.current.toFixed(3);
  });
  return (
    <div
      ref={el}
      data-testid="live-glow"
      data-ref={widget.ref}
      data-level="0.000"
      className="pointer-events-none absolute rounded-full"
      style={{ ...boxStyle(box), opacity: 0, background: glowBackground(r, g, b) }}
    />
  );
}

/**
 * A light on the sheet: bright in the middle, gone at the edge of its box. A pale light
 * (white, or a mix near it) would not show on the light sheet, so it gets a soft grey ring
 * around its core; a strong colour gets none.
 */
function glowBackground(r: number, g: number, b: number): string {
  const light = `radial-gradient(circle, rgba(${r},${g},${b},0.95) 0%, rgba(${r},${g},${b},0.55) 28%, rgba(${r},${g},${b},0) 68%)`;
  const pale = Math.min(r, g, b) / 255;
  const ring = (0.3 * pale * pale).toFixed(3);
  return pale < 0.3 ? light : `${light}, radial-gradient(circle, rgba(70,70,80,0) 26%, rgba(70,70,80,${ring}) 46%, rgba(70,70,80,0) 70%)`;
}

/** The colours of a mixed light when its part names none: an RGB LED. */
const MIX_COLORS = ["red", "green", "blue"];

/**
 * One light for two or three currents (an RGB LED, a two-colour LED). Each current has its
 * colour; the light is their mix, as the eye sees it through one lens. The strongest current
 * says how bright it is.
 */
function GlowMix({ widget, box }: WidgetProps): React.ReactElement {
  const el = React.useRef<HTMLDivElement>(null);
  const signals = widget.signals ?? [];
  const levels = React.useRef<number[]>([]);
  const full = typeof widget.props.full === "number" && widget.props.full > 0 ? widget.props.full : 0.01;
  const named = Array.isArray(widget.props.colors) ? widget.props.colors : [];
  const colors = signals.map((_, i) => LED_COLOR[String(named[i] ?? MIX_COLORS[i])] ?? RED);
  useValues(widget.key, (values) => {
    let most = 0;
    signals.forEach((signal, i) => {
      const target = clamp01((values.avg(signal.vector) ?? 0) / full);
      let level = levels.current[i] ?? 0;
      level += (target - level) * 0.45;
      if (level < 0.002 && target === 0) level = 0;
      levels.current[i] = level;
      most = Math.max(most, level);
    });
    if (!el.current) return;
    // the hue comes from how the currents compare, the brightness from the strongest of them
    const [r, g, b] = mixColors(colors, levels.current);
    el.current.style.opacity = String(Math.pow(most, 0.6));
    el.current.style.background = glowBackground(r, g, b);
    el.current.dataset.level = most.toFixed(3);
    el.current.dataset.levels = signals.map((_, i) => (levels.current[i] ?? 0).toFixed(2)).join(" ");
    el.current.dataset.color = `${r} ${g} ${b}`;
  });
  return (
    <div
      ref={el}
      data-testid="live-glow"
      data-ref={widget.ref}
      data-level="0.000"
      data-levels=""
      data-color=""
      className="pointer-events-none absolute rounded-full"
      style={{ ...boxStyle(box), opacity: 0 }}
    />
  );
}

// A 7-segment digit in a box 12 wide and 20 tall: the bars a to g, each a flat hexagon.
const BAR = 0.85; // half the thickness of a bar
const across = (y: number): string => {
  const [x0, x1] = [2.5, 8.3];
  return `${x0},${y} ${x0 + BAR},${y - BAR} ${x1 - BAR},${y - BAR} ${x1},${y} ${x1 - BAR},${y + BAR} ${x0 + BAR},${y + BAR}`;
};
const down = (x: number, y0: number, y1: number): string =>
  `${x},${y0} ${x + BAR},${y0 + BAR} ${x + BAR},${y1 - BAR} ${x},${y1} ${x - BAR},${y1 - BAR} ${x - BAR},${y0 + BAR}`;
const SEGMENTS: [name: string, points: string][] = [
  ["a", across(2.6)],
  ["b", down(8.6, 2.9, 9.7)],
  ["c", down(8.6, 10.3, 17.1)],
  ["d", across(17.4)],
  ["e", down(2.2, 10.3, 17.1)],
  ["f", down(2.2, 2.9, 9.7)],
  ["g", across(10)],
];
/** How much of an unlit segment shows on the dark face. */
const SEGMENT_DARK = 0.1;

/**
 * A 7-segment digit: a dark face over the symbol's own small drawing of the digit, and the
 * seven bars, each as bright as its current. An eighth current is the decimal point. The
 * digit stands upright also on a symbol that was turned.
 */
function SevenSegment({ widget, box }: WidgetProps): React.ReactElement {
  const el = React.useRef<HTMLDivElement>(null);
  const signals = widget.signals ?? [];
  const levels = React.useRef<number[]>([]);
  const full = typeof widget.props.full === "number" && widget.props.full > 0 ? widget.props.full : 0.006;
  const [r, g, b] = LED_COLOR[String(widget.props.color)] ?? RED;
  useValues(widget.key, (values) => {
    const root = el.current;
    if (!root) return;
    let lit = "";
    signals.forEach((signal, i) => {
      const target = clamp01((values.avg(signal.vector) ?? 0) / full);
      let level = levels.current[i] ?? 0;
      level += (target - level) * 0.45;
      if (level < 0.002 && target === 0) level = 0;
      levels.current[i] = level;
      const name = SEGMENTS[i]?.[0] ?? "p";
      if (level > 0.5) lit += name;
      const shape = root.querySelector<SVGElement>(`[data-segment="${name}"]`);
      if (shape) shape.style.opacity = String(SEGMENT_DARK + (1 - SEGMENT_DARK) * Math.pow(level, 0.6));
    });
    root.dataset.lit = lit;
  });
  const fill = `rgb(${r},${g},${b})`;
  return (
    <div
      ref={el}
      data-testid="live-seven-segment"
      data-ref={widget.ref}
      data-lit=""
      className="pointer-events-none absolute overflow-hidden rounded-[3px] bg-neutral-900 shadow ring-1 ring-inset ring-black/50"
      style={boxStyle(box)}
    >
      <svg className="h-full w-full" viewBox="0 0 12 20" preserveAspectRatio="xMidYMid meet" aria-hidden="true">
        <g transform="translate(0.9 0) skewX(-5)">
          {SEGMENTS.map(([name, points]) => (
            <polygon key={name} data-segment={name} points={points} fill={fill} style={{ opacity: SEGMENT_DARK }} />
          ))}
        </g>
        {signals.length > SEGMENTS.length && <circle data-segment="p" cx={10.6} cy={17.4} r={0.95} fill={fill} style={{ opacity: SEGMENT_DARK }} />}
      </svg>
    </div>
  );
}

/**
 * The contacts of a part that moves them by itself (a relay), drawn where they are now: as
 * the symbol draws them below half of the signal, the other way above it. Nothing to click.
 */
function Contact({ widget, box }: WidgetProps): React.ReactElement {
  const [on, setOn] = React.useState(false);
  const vector = widget.signal!.vector;
  useValues(widget.key, (values) => {
    const now = (values.avg(vector) ?? 0) > 0.5;
    setOn((was) => (was === now ? was : now));
  });
  return (
    <div data-testid="live-contact" data-ref={widget.ref} data-position={on ? "on" : "off"} className="pointer-events-none absolute" style={boxStyle(box)}>
      {widget.lines && <ZoneLines lines={widget.lines} on={on} />}
    </div>
  );
}

/** On the screen a part at its full speed goes round this many times a second: its real speed would be a blur. */
const SPIN_TURNS = 2;
/** Slower than this share of its full speed, a part stands still on the screen. */
const SPIN_LEAST = 0.005;
// two arcs of a sixth of the circle each, across from each other, on the rim of a box of 100
const SPIN_ARCS = ["M 95 50 A 45 45 0 0 1 72.5 88.97", "M 5 50 A 45 45 0 0 1 27.5 11.03"];

/**
 * A mark that goes round on a part that turns (a motor, a fan): faster with the signal,
 * the other way round below zero, pale and still while the part stands. The signal is the
 * part's speed, 1 at its full speed.
 */
function Spin({ widget, box }: WidgetProps): React.ReactElement {
  const root = React.useRef<HTMLDivElement>(null);
  const mark = React.useRef<SVGGElement>(null);
  const angle = React.useRef(0);
  const seenAt = React.useRef<number | null>(null);
  const vector = widget.signal!.vector;
  useValues(widget.key, (values) => {
    const speed = values.avg(vector) ?? 0;
    const now = performance.now();
    // a look that comes late (a tab in the background) does not make the mark jump
    const seconds = seenAt.current === null ? 0 : Math.min(now - seenAt.current, 100) / 1000;
    seenAt.current = now;
    const turning = Math.abs(speed) >= SPIN_LEAST;
    if (turning) angle.current = (angle.current + Math.max(-1.5, Math.min(1.5, speed)) * SPIN_TURNS * 360 * seconds) % 360;
    if (!root.current || !mark.current) return;
    mark.current.setAttribute("transform", `rotate(${angle.current.toFixed(1)} 50 50)`);
    root.current.style.opacity = turning ? "1" : "0.3";
    root.current.dataset.speed = speed.toFixed(3);
    root.current.dataset.turning = turning ? (speed > 0 ? "forward" : "back") : "no";
  });
  return (
    <div
      ref={root}
      data-testid="live-spin"
      data-ref={widget.ref}
      data-speed="0.000"
      data-turning="no"
      className="pointer-events-none absolute text-sky-600 dark:text-sky-400"
      style={{ ...boxStyle(box), opacity: 0.3 }}
    >
      <svg className="h-full w-full overflow-visible" viewBox="0 0 100 100" aria-hidden="true">
        <g ref={mark}>
          {SPIN_ARCS.map((d) => (
            <path key={d} d={d} fill="none" stroke="currentColor" strokeWidth={3} strokeLinecap="round" vectorEffect="non-scaling-stroke" />
          ))}
        </g>
      </svg>
    </div>
  );
}

/**
 * Rings that spread from a part while it sounds (a buzzer, a speaker): one when it can
 * just be heard, three at its full loudness. The signal is how loud it is, 1 at the most.
 */
function Sound({ widget, box }: WidgetProps): React.ReactElement {
  const root = React.useRef<HTMLDivElement>(null);
  const [rings, setRings] = React.useState(0);
  const vector = widget.signal!.vector;
  useValues(widget.key, (values) => {
    const level = values.avg(vector) ?? 0;
    const now = soundRings(level);
    setRings((was) => (was === now ? was : now));
    if (root.current) root.current.dataset.level = level.toFixed(3);
  });
  return (
    <div
      ref={root}
      data-testid="live-sound"
      data-ref={widget.ref}
      data-level="0.000"
      data-rings={rings}
      data-tone={toneHz(widget.props.tone) ?? undefined}
      className="pointer-events-none absolute"
      style={boxStyle(box)}
    >
      {Array.from({ length: rings }, (_, i) => (
        <span key={i} className="absolute inset-[24%] animate-ping rounded-full border-2 border-sky-500/80 dark:border-sky-400/80" style={{ animationDelay: `${i * 330}ms` }} />
      ))}
    </div>
  );
}

/**
 * A number with a unit under the symbol. A part that counts something (a motor's turns a
 * minute) has it whole, without a prefix in front of the unit; a temperature has it with
 * the decimals the part asks for.
 */
function Meter({ widget, box, tag }: WidgetProps): React.ReactElement {
  const { hit } = useLayer();
  const { moving, handle } = useTagMove(widget, tag);
  const el = React.useRef<HTMLSpanElement>(null);
  const shownAt = React.useRef(-Infinity);
  const unit = typeof widget.props.unit === "string" ? widget.props.unit : "";
  const decimals = widget.props.decimals;
  const say =
    widget.props.prefix !== false
      ? formatValue
      : typeof decimals === "number"
        ? (value: number, u: string): string => fixedValue(value, u, decimals)
        : countValue;
  const vector = widget.signal!.vector;
  useValues(widget.key, (values) => {
    const now = performance.now();
    if (now - shownAt.current < METER_MS || !el.current) return;
    const value = values.avg(vector);
    if (value === undefined) return;
    shownAt.current = now;
    el.current.textContent = say(value, unit);
    el.current.dataset.value = String(value);
  });
  return (
    <div
      data-testid="live-meter"
      data-ref={widget.ref}
      data-moved={tag.shift !== undefined}
      className={`${tagClass} ${hit} ${moving ? "z-10 cursor-grabbing" : "cursor-grab"}`}
      style={{ ...tagStyle(box, tag), touchAction: "none" }}
      onWheel={wheelToCanvas}
      {...handle}
    >
      <span className="mr-1 text-neutral-500 dark:text-white/50">{widget.ref}</span>
      <span ref={el} className="font-semibold tabular-nums">
        {`- ${unit}`}
      </span>
    </div>
  );
}

/** Below this many CSS px per mm the mark of a left-out symbol has no words: too small to read. */
const WORDS_PX_PER_MM = 3.5;

/** A symbol the run leaves out (it has no value, or the library has no part for it): a dashed frame, and why in two words when there is room. */
function LeftOut({ mark, box, words }: { mark: LeftOutMark; box: ScreenBox; words: boolean }): React.ReactElement {
  return (
    <div
      data-testid="live-left-out"
      data-ref={mark.ref}
      data-reason={mark.reason}
      aria-label={mark.sentence}
      className="pointer-events-none absolute rounded-sm border border-dashed border-neutral-500/80 bg-neutral-400/15 dark:border-white/50 dark:bg-white/10"
      style={boxStyle(box)}
    >
      {words && (
        <span className="absolute bottom-full left-0 mb-0.5 whitespace-nowrap rounded-sm bg-white/80 px-1 text-[9px] font-medium leading-tight text-neutral-600 dark:bg-neutral-900/80 dark:text-white/70">
          {mark.words}
        </span>
      )}
    </div>
  );
}

/**
 * The widgets this page can draw. A part that names another one runs without it. `ownSize`:
 * a tag, with a size of its own on the screen and a place the user can change.
 */
const WIDGETS: Record<string, { draw: (props: WidgetProps) => React.ReactElement | null; ownSize?: true }> = {
  "press-zone": { draw: PressZone },
  "toggle-zone": { draw: ToggleZone },
  slider: { draw: SliderWidget, ownSize: true },
  glow: { draw: Glow },
  "glow-mix": { draw: GlowMix },
  meter: { draw: Meter, ownSize: true },
  contact: { draw: Contact },
  spin: { draw: Spin },
  sound: { draw: Sound },
  "seven-segment": { draw: SevenSegment },
};

// --- the layer --------------------------------------------------------------

/** True while a KiCad dialog is open (the editor says when one opens and closes). */
function useDialogOpen(): boolean {
  const [, bump] = React.useReducer((n: number) => n + 1, 0);
  React.useEffect(
    () =>
      onEditorEvent((e) => {
        if (e.type === "dialogShown" || e.type === "dialogClosed") bump();
      }),
    [],
  );
  return anyDialogOpen();
}

/** The symbols of the open sheet, read again and again while the layer is up. */
function usePlaces(mod: SimPlacesModule, log: (msg: string) => void): { places: SheetPlaces | null; rect: CssRect | null } {
  const [places, setPlaces] = React.useState<SheetPlaces | null>(null);
  const [rect, setRect] = React.useState<CssRect | null>(null);
  React.useEffect(() => {
    let last = "";
    let lastRect = "";
    const read = () => {
      if (anyModalDialogOpen()) return; // its own event loop runs: the editor is left alone
      const now = glCanvasRect();
      const key = now ? `${now.x}|${now.y}|${now.width}|${now.height}` : "";
      if (key !== lastRect) {
        lastRect = key;
        setRect(now);
      }
      let raw: string;
      try {
        raw = mod.kicadSimPlaces();
      } catch {
        return; // the editor is busy: the next tick asks again
      }
      if (raw === last) return;
      last = raw;
      try {
        setPlaces(readPlaces(raw));
      } catch (e) {
        setPlaces(null);
        log(`live layer: ${e instanceof Error ? e.message : String(e)}`);
      }
    };
    read();
    const timer = setInterval(read, PLACES_MS);
    window.addEventListener("resize", read);
    return () => {
      clearInterval(timer);
      window.removeEventListener("resize", read);
    };
  }, [mod, log]);
  return { places, rect };
}

/**
 * The editor's viewport, asked every frame while the layer is up: the widgets
 * stay on their symbols through a pan. (The app's viewport store is not used:
 * it is fed a few times a second, which is right for a comment pin and too
 * slow for a light that sits on an LED.)
 */
function useLiveViewport(mod: LiveLayerModule): ViewportState | null {
  const [viewport, setViewport] = React.useState<ViewportState | null>(null);
  React.useEffect(() => {
    let last = "";
    let raf = requestAnimationFrame(function tick() {
      raf = requestAnimationFrame(tick);
      if (anyModalDialogOpen()) return;
      let raw: string | undefined;
      try {
        raw = mod.kicadCollabGetViewport?.();
      } catch {
        return; // the editor is busy: the next frame asks again
      }
      if (!raw || raw === last) return;
      last = raw;
      const next = parseViewport(raw);
      if (next) setViewport(next);
    });
    return () => cancelAnimationFrame(raf);
  }, [mod]);
  return viewport;
}

/** The schematic editor, as the layer needs it. */
export type LiveLayerModule = SimPlacesModule & {
  /** The drawing area's pan and zoom, as JSON. */
  kicadCollabGetViewport?: () => string;
};

export interface LiveLayerProps {
  /** A session whose circuit runs. The layer is mounted while it does. */
  session: LiveSession;
  /** The schematic editor: where the symbols of the open sheet are, and its pan and zoom. */
  mod: LiveLayerModule;
  /** A line for the app's own log. */
  log?: (msg: string) => void;
  /** The open project: where the user put the tags is remembered for it, in this browser. */
  project?: string;
}

/** Half a tag's height at its full size, in CSS px: where the line to a moved tag ends. */
const TAG_HALF_PX = 12;
/** A tag that is closer to its own place than this, in CSS px at its full size, has no line to it. */
const LINE_FROM_PX = 16;
/** A tag whose place is off the drawing area by more than this, in CSS px at its full size, is not drawn. */
const TAG_MARGIN_PX = 200;

const noLog = (): void => {};

export function LiveLayer({ session, mod, log = noLog, project }: LiveLayerProps): React.ReactElement | null {
  const run = session.run;
  const viewport = useLiveViewport(mod);
  const { places, rect } = usePlaces(mod, log);
  const dialogOpen = useDialogOpen();

  const updaters = React.useMemo<Updaters>(() => new Map(), []);
  const [set, setSet] = React.useState<Readonly<Record<string, number>>>({});
  const setInput = React.useMemo(() => {
    const send = createInputSender(
      (vector, value) => session.engine.setInput(vector, value),
      (text) => log(`live layer: an input was not set: ${text}`),
    );
    return (vector: string, value: number) => {
      setSet((was) => (was[vector] === value ? was : { ...was, [vector]: value }));
      send(vector, value);
    };
  }, [session, log]);

  // Every look at the circuit, to the widgets that show a value.
  React.useEffect(() => {
    let names: string[] = [];
    let index = new Map<string, number>();
    return session.onFrame((frame: LiveFrame) => {
      if (frame.names.length !== names.length || frame.names[0] !== names[0]) {
        names = frame.names;
        index = new Map(names.map((name, i) => [name, i]));
      }
      const pick = (list: ArrayLike<number>, vector: string): number | undefined => {
        const i = index.get(vector);
        return i === undefined ? undefined : list[i];
      };
      const values: Values = { latest: (v) => pick(frame.latest, v), avg: (v) => pick(frame.avg, v) };
      for (const update of [...updaters.values()]) update(values);
    });
  }, [session, updaters]);

  // While the middle or right button is down the widgets let everything through.
  const [through, setThrough] = React.useState(false);
  const toCanvas = React.useCallback((e: React.PointerEvent) => {
    if (e.pointerType !== "mouse") return;
    setThrough(true);
    const up = () => {
      setThrough(false);
      window.removeEventListener("mouseup", up, true);
    };
    window.addEventListener("mouseup", up, true);
    editorCanvas()?.dispatchEvent(new MouseEvent("mousedown", { ...keysOf(e), button: e.button, buttons: e.buttons }));
  }, []);

  // Where the user put the tags. Remembered when a drag ends, and when the layer goes.
  const [shifts, setShifts] = React.useState<TagShifts>(() => loadTagShifts(project));
  const tags = React.useRef({ shifts, unsaved: false });
  const moveTag = React.useCallback((key: string, shift: TagShift | null) => {
    const next = withTagShift(tags.current.shifts, key, shift);
    if (next === tags.current.shifts) return;
    tags.current = { shifts: next, unsaved: true };
    setShifts(next);
  }, []);
  const saveTags = React.useCallback(() => {
    if (!tags.current.unsaved) return;
    tags.current.unsaved = false;
    saveTagShifts(project, tags.current.shifts);
  }, [project]);
  React.useEffect(() => () => saveTags(), [saveTags]);
  const layerEl = React.useRef<HTMLDivElement | null>(null);

  const context = React.useMemo<LayerContext>(
    () => ({ updaters, set, setInput, toCanvas, hit: through ? "pointer-events-none" : "pointer-events-auto", moveTag, saveTags, layerEl }),
    [updaters, set, setInput, toCanvas, through, moveTag, saveTags],
  );

  const { widgets, notes } = React.useMemo(
    () => (run && places ? widgetsFor(run, places) : { widgets: [], notes: [] }),
    [run, places],
  );
  const leftOut = React.useMemo(() => (run && places ? leftOutFor(run, places) : []), [run, places]);
  const said = React.useRef("");
  React.useEffect(() => {
    const text = notes.join("; ");
    if (text && text !== said.current) log(`live layer: ${text}`);
    said.current = text;
  }, [notes, log]);

  if (!run || !places || !viewport || !rect || dialogOpen) return null;

  const ratio = cssRatio(viewport, rect);
  const pxPerUnit = viewport.scale * ratio;
  const pxPerMm = pxPerUnit * places.iuPerMm;
  const far = pxPerMm < FAR_PX_PER_MM;
  const scale = tagScale(pxPerMm);
  const toPx = (p: { x: number; y: number }) => {
    const px = worldToScreen(viewport, p);
    return { x: px.x * ratio, y: px.y * ratio };
  };

  // A tag the user moved away has a thin line from its own place under its symbol.
  const lines: { key: string; ref: string; x1: number; y1: number; x2: number; y2: number }[] = [];
  const drawn = widgets.map((widget) => {
    const kind = WIDGETS[widget.widget];
    if (!kind || (kind.ownSize && far)) return null;
    const shift = kind.ownSize ? shifts[widget.key] : undefined;
    const box = screenBox(shiftBox(widget.box, shift, places.iuPerMm), toPx, pxPerUnit);
    const right = box.left + (box.width ?? 0);
    const bottom = box.top + (box.height ?? 0);
    // Off the drawing area: not drawn. A tag is kept near the edge: its place is the middle of its upper edge.
    const margin = kind.ownSize ? TAG_MARGIN_PX * Math.max(1, scale) : 0;
    if (right < -margin || bottom < -margin || box.left > rect.width + margin || box.top > rect.height + margin) return null;
    if (shift) {
      const home = screenBox(widget.box, toPx, pxPerUnit);
      const to = { x: box.left, y: box.top + TAG_HALF_PX * scale };
      if (Math.hypot(to.x - home.left, to.y - home.top) >= LINE_FROM_PX * scale) lines.push({ key: widget.key, ref: widget.ref, x1: home.left, y1: home.top, x2: to.x, y2: to.y });
    }
    const Draw = kind.draw;
    return <Draw key={widget.key} widget={widget} box={box} tag={{ scale, pxPerMm, shift }} />;
  });

  return (
    <Context.Provider value={context}>
      <div
        ref={layerEl}
        data-testid="live-layer"
        data-sheet={places.sheet}
        data-widgets={widgets.length}
        data-left-out={leftOut.length}
        className="pointer-events-none absolute z-20 overflow-hidden"
        style={{ left: rect.x, top: rect.y, width: rect.width, height: rect.height }}
      >
        {lines.length > 0 && (
          <svg className="pointer-events-none absolute inset-0 h-full w-full text-sky-600/70 dark:text-sky-400/70" aria-hidden="true">
            {lines.map((line) => (
              <line
                key={line.key}
                data-testid="live-tag-line"
                data-ref={line.ref}
                x1={line.x1}
                y1={line.y1}
                x2={line.x2}
                y2={line.y2}
                stroke="currentColor"
                strokeWidth={1}
                strokeDasharray="3 3"
              />
            ))}
          </svg>
        )}
        {drawn}
        {leftOut.map((mark) => {
          const box = screenBox(mark.box, toPx, pxPerUnit);
          if (box.left + (box.width ?? 0) < 0 || box.top + (box.height ?? 0) < 0 || box.left > rect.width || box.top > rect.height) return null;
          return <LeftOut key={mark.key} mark={mark} box={box} words={pxPerUnit * places.iuPerMm >= WORDS_PX_PER_MM} />;
        })}
      </div>
    </Context.Provider>
  );
}
