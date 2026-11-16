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
  createInputSender,
  formatValue,
  readPlaces,
  screenBox,
  widgetsFor,
  type LiveWidget,
  type ScreenBox,
  type SheetPlaces,
  type SimPlacesModule,
} from "@/wasm/live-overlay";
import type { LiveSession } from "@/wasm/live-session";
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

interface WidgetProps {
  widget: LiveWidget;
  box: ScreenBox;
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
    />
  );
}

/** A zone to click: on, and on the next click off. */
function ToggleZone({ widget, box }: WidgetProps): React.ReactElement | null {
  const { set, setInput, toCanvas, hit } = useLayer();
  const input = widget.input!;
  const spec = input.input;
  if (spec.type !== "toggle") return null;
  const on = (set[input.vector] ?? input.initial) === spec.on;
  return (
    <Button
      data-testid="live-toggle"
      data-ref={widget.ref}
      data-on={on}
      aria-label={`${widget.ref}: click to switch ${on ? "off" : "on"}`}
      aria-pressed={on}
      title={`${widget.ref}: click to switch ${on ? "off" : "on"}`}
      tabIndex={-1}
      variant="plain"
      size="text"
      className={`${zoneClass} ${hit} ${on ? zoneOnClass : ""}`}
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
      <span className="pointer-events-none absolute left-1/2 top-0 -translate-x-1/2 -translate-y-full whitespace-nowrap rounded-sm bg-white/90 px-1 text-[10px] font-semibold leading-4 text-sky-700 dark:bg-neutral-900/90 dark:text-sky-300">
        {on ? "ON" : "OFF"}
      </span>
    </Button>
  );
}

const tagClass =
  "absolute -translate-x-1/2 whitespace-nowrap rounded-md bg-white/90 px-2 py-1 text-[11px] leading-4 text-neutral-900 shadow ring-1 ring-inset ring-black/10 dark:bg-neutral-900/90 dark:text-white dark:ring-white/15";

/** A slider under the symbol: from the least to the most the part allows. */
function SliderWidget({ widget, box }: WidgetProps): React.ReactElement | null {
  const { set, setInput, hit } = useLayer();
  const input = widget.input!;
  const spec = input.input;
  if (spec.type !== "range" || spec.max === spec.min) return null;
  const span = spec.max - spec.min;
  const percent = Math.round((((set[input.vector] ?? input.initial) - spec.min) / span) * 100);
  return (
    <div
      data-testid="live-slider"
      data-ref={widget.ref}
      data-percent={percent}
      className={`${tagClass} ${hit} flex items-center gap-2`}
      style={{ left: box.left, top: box.top }}
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
        thumbLabel={`${widget.ref}: position`}
        className="w-24"
      />
      <span className="w-[4.5rem] text-right tabular-nums">
        {widget.ref} {percent} %
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
      style={{
        ...boxStyle(box),
        opacity: 0,
        background: `radial-gradient(circle, rgba(${r},${g},${b},0.95) 0%, rgba(${r},${g},${b},0.55) 28%, rgba(${r},${g},${b},0) 68%)`,
      }}
    />
  );
}

/** A number with a unit under the symbol. */
function Meter({ widget, box }: WidgetProps): React.ReactElement {
  const el = React.useRef<HTMLSpanElement>(null);
  const shownAt = React.useRef(-Infinity);
  const unit = typeof widget.props.unit === "string" ? widget.props.unit : "";
  const vector = widget.signal!.vector;
  useValues(widget.key, (values) => {
    const now = performance.now();
    if (now - shownAt.current < METER_MS || !el.current) return;
    const value = values.avg(vector);
    if (value === undefined) return;
    shownAt.current = now;
    el.current.textContent = formatValue(value, unit);
    el.current.dataset.value = String(value);
  });
  return (
    <div data-testid="live-meter" data-ref={widget.ref} className={`${tagClass} pointer-events-none`} style={{ left: box.left, top: box.top }}>
      <span className="mr-1 text-neutral-500 dark:text-white/50">{widget.ref}</span>
      <span ref={el} className="font-semibold tabular-nums">
        {`- ${unit}`}
      </span>
    </div>
  );
}

/** The widgets this page can draw. A part that names another one runs without it. */
const WIDGETS: Record<string, { draw: (props: WidgetProps) => React.ReactElement | null; ownSize?: true }> = {
  "press-zone": { draw: PressZone },
  "toggle-zone": { draw: ToggleZone },
  slider: { draw: SliderWidget, ownSize: true },
  glow: { draw: Glow },
  meter: { draw: Meter, ownSize: true },
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
}

const noLog = (): void => {};

export function LiveLayer({ session, mod, log = noLog }: LiveLayerProps): React.ReactElement | null {
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

  const context = React.useMemo<LayerContext>(
    () => ({ updaters, set, setInput, toCanvas, hit: through ? "pointer-events-none" : "pointer-events-auto" }),
    [updaters, set, setInput, toCanvas, through],
  );

  const { widgets, notes } = React.useMemo(
    () => (run && places ? widgetsFor(run, places) : { widgets: [], notes: [] }),
    [run, places],
  );
  const said = React.useRef("");
  React.useEffect(() => {
    const text = notes.join("; ");
    if (text && text !== said.current) log(`live layer: ${text}`);
    said.current = text;
  }, [notes, log]);

  if (!run || !places || !viewport || !rect || dialogOpen) return null;

  const ratio = cssRatio(viewport, rect);
  const pxPerUnit = viewport.scale * ratio;
  const far = pxPerUnit * places.iuPerMm < FAR_PX_PER_MM;
  const toPx = (p: { x: number; y: number }) => {
    const px = worldToScreen(viewport, p);
    return { x: px.x * ratio, y: px.y * ratio };
  };

  return (
    <Context.Provider value={context}>
      <div
        data-testid="live-layer"
        data-sheet={places.sheet}
        data-widgets={widgets.length}
        className="pointer-events-none absolute z-20 overflow-hidden"
        style={{ left: rect.x, top: rect.y, width: rect.width, height: rect.height }}
      >
        {widgets.map((widget) => {
          const kind = WIDGETS[widget.widget];
          if (!kind || (kind.ownSize && far)) return null;
          const box = screenBox(widget.box, toPx, pxPerUnit);
          const right = box.left + (box.width ?? 0);
          const bottom = box.top + (box.height ?? 0);
          // Off the drawing area: not drawn. A widget with its own size is kept near the edge.
          const margin = kind.ownSize ? 200 : 0;
          if (right < -margin || bottom < -margin || box.left > rect.width + margin || box.top > rect.height + margin) return null;
          const Draw = kind.draw;
          return <Draw key={widget.key} widget={widget} box={box} />;
        })}
      </div>
    </Context.Provider>
  );
}
