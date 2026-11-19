import * as React from "react";
import { ArrowDownToLine, ChevronDown, ChevronRight, CornerDownLeft, Eraser, X } from "lucide-react";
import { useDraggablePanel } from "@/components/useDraggablePanel";
import { PanelPin } from "@/overlay/PanelPin";
import { PanelDock } from "@/overlay/PanelDock";
import { Button, Input, Tip, cn } from "@pcbjam/ui";
import { overlayIconClass } from "@/components/OverlayMenu";
import type { ConsoleKind, LiveConsole } from "@/wasm/live-console";

/**
 * Floating "Serial console" of live simulation: what the firmware of a chip in
 * the running circuit prints on its serial line (`Serial.println` in an Arduino
 * sketch), and a line to type text back to it. It is what the Serial Monitor of
 * the Arduino IDE is for a real board.
 *
 * The text is kept by the live session (wasm/live-console.ts), not here: the
 * panel can be closed and opened, and shows what the run printed so far. A
 * circuit with several chips has one console per chip, chosen by the chip's
 * reference in the header.
 *
 * What the chip printed is in the normal colour, what the user typed is blue,
 * and what the simulator says about the chip ("reset went low: ...") is dim.
 * Enter sends the typed line with a line end, as the Serial Monitor's "New
 * Line" setting does.
 *
 * New text keeps the end in view. Scrolling up to read holds the text still,
 * also under a chip that prints without pause; scrolling back to the end, the
 * arrow button, or sending a line goes back to the newest text.
 *
 * Same draggable-panel conventions as the simulation parts panel: header =
 * drag handle, collapse-to-header, position/collapse persisted.
 */

const PANEL_POS_KEY = "pcbjam:sim-console-panel-pos";
const PANEL_COLLAPSED_KEY = "pcbjam:sim-console-panel-collapsed";
const PANEL_W = 448; // w-[28rem]
const PANEL_HEADER_H = 36;
/** The text is drawn at most this often: firmware can print thousands of lines a second. */
const DRAW_MS = 80;
/** As close to its end the text counts as "at the end": new text then keeps it there. */
const AT_END_PX = 24;

const KIND_CLASS: Record<ConsoleKind, string> = {
  out: "",
  in: "text-sky-600 dark:text-sky-300",
  note: "italic text-neutral-400 dark:text-white/40",
  problem: "text-red-600 dark:text-red-400",
};

/** What the text area shows: a chip's console as it was at one moment. */
interface Shown {
  chip: string | null;
  run: number;
  entries: { kind: ConsoleKind; text: string }[];
  cut: boolean;
}

/** The console's change counter, read at most every DRAW_MS. */
function useConsoleStamp(serial: LiveConsole): number {
  const [stamp, setStamp] = React.useState(serial.stamp);
  React.useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const read = () => {
      timer = null;
      setStamp(serial.stamp);
    };
    read();
    const off = serial.onChange(() => {
      if (timer === null) timer = setTimeout(read, DRAW_MS);
    });
    return () => {
      off();
      if (timer !== null) clearTimeout(timer);
    };
  }, [serial]);
  return stamp;
}

export function SimConsolePanel({ console: serial, onClose }: { console: LiveConsole; onClose: () => void }) {
  const drag = useDraggablePanel({
    storageKey: PANEL_POS_KEY,
    handleWidth: PANEL_W,
    handleHeight: PANEL_HEADER_H,
  });
  const rootRef = React.useRef<HTMLDivElement>(null);
  const textRef = React.useRef<HTMLDivElement>(null);
  // Whether the text follows its end: false while the user has scrolled up to read. The
  // ref is for the scroll handler, the state for the draw.
  const atEnd = React.useRef(true);
  const [following, setFollowing] = React.useState(true);
  const follow = React.useCallback((on: boolean) => {
    atEnd.current = on;
    setFollowing(on);
  }, []);

  const [collapsed, setCollapsedState] = React.useState<boolean>(() => {
    try {
      return localStorage.getItem(PANEL_COLLAPSED_KEY) === "1";
    } catch {
      return false;
    }
  });
  const setCollapsed = (next: boolean) => {
    setCollapsedState(next);
    try {
      localStorage.setItem(PANEL_COLLAPSED_KEY, next ? "1" : "0");
    } catch {
      /* private mode: the panel still works, it just forgets */
    }
  };

  const stamp = useConsoleStamp(serial);
  const chips = serial.chips;
  // The chip whose console shows: the one picked, while the circuit has it.
  const [picked, setPicked] = React.useState<string | null>(null);
  const chip = chips.find((c) => c.name === picked) ?? chips[0] ?? null;
  const chipName = chip?.name ?? null;
  const run = serial.run;
  // Another chip, or a new run: its text is shown from its end.
  React.useEffect(() => follow(true), [follow, chipName, run]);
  // The text as it was at the last draw. The console goes on growing between two draws,
  // and a draw for another reason (the page above draws often while a circuit runs) must
  // not show more than the draw that moves the text to its end. While the user reads
  // further up, the text is not drawn again at all: it would move under their eyes when
  // the console drops its oldest lines.
  const held = React.useRef<Shown | null>(null);
  const shown = React.useMemo(() => {
    const was = held.current;
    if (!following && was && was.chip === chipName && was.run === run) return was;
    const next: Shown = {
      chip: chipName,
      run,
      entries: chipName ? serial.entries(chipName).map((e) => ({ kind: e.kind, text: e.text })) : [],
      cut: chipName ? serial.cut(chipName) : false,
    };
    held.current = next;
    return next;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- stamp says when the console changed
  }, [serial, chipName, run, stamp, following]);
  const entries = shown.entries;
  const canSend = !!chip && serial.canSend;

  const [draft, setDraft] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);

  // New text keeps the end in view, unless the user scrolled up to read.
  React.useLayoutEffect(() => {
    const el = textRef.current;
    if (el && atEnd.current) el.scrollTop = el.scrollHeight;
  }, [shown, collapsed]);

  const send = () => {
    if (!chip || !canSend) return;
    const name = chip.name;
    const text = draft;
    setDraft("");
    setError(null);
    follow(true);
    serial.send(name, `${text}\n`).catch((e: unknown) => {
      setError(e instanceof Error ? e.message : String(e));
      setDraft((now) => now || text); // the line is not lost
    });
  };

  const style: React.CSSProperties = drag.pos ? { left: drag.pos.x, top: drag.pos.y } : { left: 12, bottom: 44 };

  return (
    <div
      ref={rootRef}
      data-snap-panel={drag.snapId}
      data-dock-title="Serial console"
      data-testid="sim-console-panel"
      data-chip={chip?.ref ?? ""}
      data-can-send={canSend ? "yes" : "no"}
      className="absolute z-40 flex w-[28rem] max-w-[calc(100vw-1.5rem)] flex-col overflow-hidden rounded-xl bg-white/95 text-neutral-900 shadow-2xl ring-1 ring-inset ring-black/10 backdrop-blur-sm dark:bg-neutral-950/90 dark:text-white dark:ring-white/10"
      style={drag.docked ?? style}
    >
      {/* Header = drag handle. Interactive children stop pointerdown so they
          don't start a drag. */}
      <Tip content="Serial console - drag to move">
        <div
          data-testid="sim-console-panel-header"
          className="flex cursor-grab select-none items-center gap-2 px-3 py-2 text-xs font-semibold active:cursor-grabbing"
          style={{ touchAction: "none" }}
          onPointerDown={(e) => drag.onPointerDown(e, rootRef.current!.getBoundingClientRect())}
          onPointerMove={(e) => void drag.onPointerMove(e)}
          onPointerUp={() => void drag.onPointerUp()}
        >
          <PanelDock id={drag.snapId} />
          <PanelPin id={drag.snapId} />
          <Tip content={collapsed ? "Expand" : "Collapse to header"}>
            <Button
              data-testid="sim-console-panel-collapse"
              aria-expanded={!collapsed}
              onPointerDown={(e) => e.stopPropagation()}
              onClick={() => setCollapsed(!collapsed)}
              variant="plain"
              size="icon-xs"
              className={overlayIconClass}
            >
              {collapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
            </Button>
          </Tip>
          <span>Serial console</span>
          {chips.length === 1 && chip && (
            <span data-testid="sim-console-chip" className="text-[10px] font-normal text-neutral-400 dark:text-white/40">
              {chip.ref}
            </span>
          )}
          {chips.length > 1 && (
            <span className="flex items-center gap-0.5" onPointerDown={(e) => e.stopPropagation()}>
              {chips.map((c) => (
                <Tip key={c.name} content={`What ${c.ref} prints`}>
                  <Button
                    data-testid="sim-console-chip-tab"
                    data-ref={c.ref}
                    data-problems={serial.problems(c.name)}
                    aria-pressed={c.name === chip?.name}
                    onClick={() => setPicked(c.name)}
                    variant="plain"
                    size="icon-xs"
                    className={cn(
                      "px-1.5 text-[11px] font-medium",
                      c.name === chip?.name
                        ? "bg-black/10 dark:bg-white/15"
                        : "font-normal text-neutral-500 hover:bg-black/5 dark:text-white/60 dark:hover:bg-white/10",
                    )}
                  >
                    {c.ref}
                    {/* the simulator told of a problem with this chip: its console says which */}
                    {serial.problems(c.name) > 0 && <span aria-hidden className="ml-1 inline-block size-1.5 rounded-full bg-red-500" />}
                  </Button>
                </Tip>
              ))}
            </span>
          )}
          <span className="ml-auto flex items-center gap-0.5" onPointerDown={(e) => e.stopPropagation()}>
            <Tip content="Clear the text">
              <Button
                data-testid="sim-console-panel-clear"
                onClick={() => {
                  if (!chip) return;
                  follow(true);
                  serial.clear(chip.name);
                }}
                disabled={!entries.length}
                variant="plain"
                size="icon-xs"
                className={overlayIconClass}
              >
                <Eraser size={13} />
              </Button>
            </Tip>
            <Tip content="Close">
              <Button
                data-testid="sim-console-panel-close"
                onClick={onClose}
                variant="plain"
                size="icon-xs"
                className={overlayIconClass}
              >
                <X size={14} />
              </Button>
            </Tip>
          </span>
        </div>
      </Tip>

      {!collapsed && (
        <>
          <div className="relative border-t border-black/5 dark:border-white/5">
            <div
              ref={textRef}
              data-testid="sim-console-text"
              data-following={following ? "yes" : "no"}
              data-native-copy
              className="h-56 select-text overflow-y-auto px-3 py-2 font-mono text-[11px] leading-4"
              onScroll={(e) => {
                const el = e.currentTarget;
                const on = el.scrollHeight - el.scrollTop - el.clientHeight < AT_END_PX;
                if (on !== atEnd.current) follow(on);
              }}
            >
              {!chip && (
                <p data-testid="sim-console-empty" className="font-sans text-xs text-neutral-500 dark:text-white/50">
                  What the program of a chip prints shows here, while a circuit runs that has a chip with firmware (an
                  Arduino, an ESP32).
                </p>
              )}
              {chip && !entries.length && (
                <p data-testid="sim-console-empty" className="font-sans text-xs text-neutral-500 dark:text-white/50">
                  {serial.canSend ? `${chip.ref} has not printed anything yet.` : `${chip.ref} printed nothing.`}
                </p>
              )}
              {chip && entries.length > 0 && (
                <pre className="m-0 whitespace-pre-wrap break-words font-mono">
                  {shown.cut && <span className={KIND_CLASS.note}>{"... older lines are gone\n"}</span>}
                  {entries.map((entry, i) => (
                    <span key={i} data-kind={entry.kind} className={KIND_CLASS[entry.kind]}>
                      {entry.text}
                    </span>
                  ))}
                </pre>
              )}
            </div>
            {!following && (
              <Tip content="Go to the newest text">
                <Button
                  data-testid="sim-console-newest"
                  onClick={() => follow(true)}
                  variant="plain"
                  size="icon-xs"
                  className="absolute bottom-1.5 right-3 bg-white p-1 shadow ring-1 ring-black/10 hover:bg-neutral-100 dark:bg-neutral-800 dark:ring-white/15 dark:hover:bg-neutral-700"
                >
                  <ArrowDownToLine size={13} />
                </Button>
              </Tip>
            )}
          </div>

          <form
            className="flex items-center gap-1.5 border-t border-black/5 px-2 py-1.5 dark:border-white/5"
            onSubmit={(e) => {
              e.preventDefault();
              send();
            }}
          >
            <Input
              data-testid="sim-console-input"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              disabled={!canSend}
              placeholder={
                canSend ? `Type to ${chip?.ref ?? "the chip"} and press Enter` : "Press Play to type to the chip"
              }
              aria-label="Text for the chip's serial input"
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="off"
              spellCheck={false}
              className="h-7 flex-1 px-2 font-mono text-[11px] shadow-none"
            />
            <Tip content="Send the line to the chip (Enter)">
              <Button
                data-testid="sim-console-send"
                type="submit"
                disabled={!canSend}
                variant="plain"
                size="icon-xs"
                className={overlayIconClass}
              >
                <CornerDownLeft size={14} />
              </Button>
            </Tip>
          </form>
          {error && (
            <p data-testid="sim-console-error" className="px-3 pb-2 text-[11px] text-red-600 dark:text-red-300">
              Not sent: {error}
            </p>
          )}
        </>
      )}
    </div>
  );
}
