import * as React from "react";
import { ChevronDown, ChevronRight, RefreshCw, X } from "lucide-react";
import type * as Y from "yjs";
import { useDraggablePanel } from "@/components/useDraggablePanel";
import { PanelPin } from "@/overlay/PanelPin";
import { PanelDock } from "@/overlay/PanelDock";
import { Button, Input, Tip } from "@pcbjam/ui";
import { overlayIconClass } from "@/components/OverlayMenu";
import {
  LEFT_OUT_ORDER, clockSettingValue, clockSource, leftOutBy, leftOutGroup, leftOutName, leftOutRemark, settingAllows, type LeftOut, type PartSetting,
} from "@pcbjam/shared/sim-library";
import { chipFirmwares, clockingCrystals, firmwareExtension, type ChipClockLine, type ChipFirmware } from "@/wasm/chip-firmware";
import type { LiveReport } from "@/wasm/live-session";
import { thermalPinLabel, thermalPinTip, wireNameProblem } from "@/wasm/sim-thermal";
import {
  notLoadedSentence,
  simPartRows,
  withClocking,
  type SheetNotLoaded,
  type SimPartRow,
  type SimPartsReader,
  type SimPartState,
  type SimSymbolsModule,
} from "@/wasm/sim-parts";

/**
 * Floating "Simulation parts" list (live simulation, first version): one line
 * per symbol of the open schematic, every sheet, saying what runs it in a
 * simulation: a library part, a suggestion, KiCad's own model, or nothing.
 * Below the rows: what KiCad's netlist export complained about, if anything.
 *
 * A chip that runs firmware (a microcontroller of the library) has a second
 * line: the file of the project it runs, and "Choose file..." to give it one
 * from the user's computer (wasm/chip-firmware.ts stores the file in the
 * project and writes its name onto the chip's symbol).
 *
 * A part that has to do with heat (a heater, a fan, a temperature sensor) has
 * thermal pins, and a line for them: the name of the wire each pin is on.
 * Heat is drawn as a circuit, so such a wire is one the user draws: 1 V on it
 * is 1 degree Celsius. Typing a name writes it onto the symbol
 * (wasm/sim-thermal.ts); no names take the part off its wires. A name that no
 * wire of the schematic has is said under the line.
 *
 * Those two lines are what changes the schematic here; everything else only
 * reads it.
 *
 * Above the rows: what a run leaves out, in groups by the reason, each with what
 * to do about it (the reasons and their words are @pcbjam/shared's, the same a
 * run's notice uses). Once Play was pressed it is that run's own report, kept
 * after a start that failed and after Stop, with why the run did not start or
 * why it ended. The rows below are always the schematic as it is now; when that
 * differs from the run's report, the block says so.
 *
 * The rows come from wasm/sim-parts.ts (the editor's `kicadSimSymbols` and
 * `kicadSimNetlist` reads matched against the published library). The list is read when the panel
 * opens, on the refresh button, and a moment after every change of the bound
 * collab doc (the active sheet's room), so it follows edits without a wasm
 * push of its own.
 *
 * Same draggable-panel conventions as the sheet and layer panels: header =
 * drag handle, collapse-to-header, position/collapse persisted.
 */

const PANEL_POS_KEY = "pcbjam:sim-parts-panel-pos";
const PANEL_COLLAPSED_KEY = "pcbjam:sim-parts-panel-collapsed";
const PANEL_W = 384; // w-96
const PANEL_HEADER_H = 36;
/** How long the doc has to stay quiet before the list is read again. */
const REFRESH_QUIET_MS = 400;

type View =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; version: string; rows: SimPartRow[]; problems: string[]; chips: Map<string, ChipFirmware>; leftOut: LeftOut[]; notLoaded: SheetNotLoaded[] };

/** The same list of left-out symbols, whatever its order: who, and why. */
const sameLeftOut = (a: readonly LeftOut[], b: readonly LeftOut[]): boolean => {
  const key = (list: readonly LeftOut[]): string => list.map((s) => `${s.ref} ${s.reason} ${s.off ?? ""} ${s.instead ?? ""}`).sort().join("\n");
  return a.length === b.length && key(a) === key(b);
};

const REPORT_TITLE: Record<LiveReport["outcome"], string> = {
  starting: "This run",
  running: "This run",
  stopped: "The last run",
  "not-started": "The last run did not start",
  ended: "The last run stopped by itself",
};

/**
 * What a run leaves out, in groups by the reason. `report`: the run that was tried last,
 * and then the list is that run's. Without one it is `now`, the schematic as it is: what
 * the next Play will leave out.
 */
function LeftOutBlock({ report, now }: { report: LiveReport | null; now: LeftOut[] | null }): React.ReactElement | null {
  const list = report ? report.leftOut : now ?? [];
  if (!report && !list.length) return null;
  // the circuit of a run that could not be written has no list of its own
  const unwritten = report?.outcome === "not-started" && !report.leftOut.length;
  const stale = !!report && !!now && !unwritten && !sameLeftOut(report.leftOut, now);
  return (
    <div
      data-testid="sim-parts-report"
      data-outcome={report?.outcome ?? "none"}
      data-left-out={list.length}
      data-stale={stale ? "yes" : "no"}
      className="border-t border-black/5 px-3 py-1.5 text-[11px] dark:border-white/5"
    >
      <p className="font-semibold text-neutral-700 dark:text-white/80">
        {report ? REPORT_TITLE[report.outcome] : "When it plays"}
        {list.length > 0 && <span className="font-normal text-neutral-500 dark:text-white/50"> - {list.length} left out</span>}
      </p>
      {report?.problem && (
        <p data-testid="sim-parts-report-problem" data-about={report.about.join(" ")} className="mt-0.5 break-words text-red-600 dark:text-red-300">
          {report.problem}
        </p>
      )}
      {report && !list.length && !unwritten && (
        <p data-testid="sim-parts-report-none" className="mt-0.5 text-neutral-500 dark:text-white/50">
          Nothing was left out.
        </p>
      )}
      {LEFT_OUT_ORDER.map((reason) => {
        const group = leftOutBy(list, reason);
        if (!group.length) return null;
        const { title, todo } = leftOutGroup(reason, group);
        // what the group's words cover is named in one line; the rest has a line each
        const plain = group.filter((s) => leftOutRemark(s) === null);
        const remarked = group.filter((s) => leftOutRemark(s) !== null);
        return (
          <div key={reason} data-testid="sim-parts-left-out" data-reason={reason} data-count={group.length} data-refs={group.map((s) => s.ref).join(" ")} className="mt-1">
            <p>
              <span className="font-semibold">{title}</span>
              <span className="text-neutral-500 dark:text-white/50"> ({group.length})</span>
              {reason !== "nothing" && plain.length > 0 && <span>: {plain.map(leftOutName).join(", ")}</span>}
            </p>
            {remarked.map((s) => (
              <p key={`${s.sheet}${s.ref}`} data-testid="sim-parts-left-out-remark" data-ref={s.ref} className="pl-2">
                <span className="font-semibold">{leftOutName(s)}</span>: {leftOutRemark(s)}
              </p>
            ))}
            <p className="text-neutral-500 dark:text-white/50">{todo}</p>
          </div>
        );
      })}
      {stale && (
        <p data-testid="sim-parts-report-stale" className="mt-1 text-amber-700 dark:text-amber-300">
          The schematic changed since this run. The rows below are the schematic as it is now; Play again for a new report.
        </p>
      )}
    </div>
  );
}

/** What the list needs to show and to change a chip's firmware. */
export interface SimPartsFirmware {
  /** Whether the project has a file of this name, as far as the page knows. */
  inProject: (name: string) => boolean;
  /**
   * Stores the picked file in the project and names it on the chip; rejects
   * with a sentence for the user. Left out in a session that cannot write:
   * the line then only says which file the chip runs.
   */
  choose?: (chip: ChipFirmware, file: File) => Promise<string>;
  /**
   * Writes one setting of a chip onto its symbol (its clock); rejects with a sentence for
   * the user. Left out in a session that cannot write: the line then only says the value.
   */
  set?: (chip: ChipFirmware, setting: PartSetting, value: string) => Promise<void>;
}

/** What the list needs to join a part's thermal pins to wires. */
export interface SimPartsThermal {
  /**
   * Writes the names of its wires onto the part's symbol, in the order of its thermal
   * pins; none takes the part off its wires. Rejects with a sentence for the user. Left
   * out in a session that cannot write: the line then only says the wires.
   */
  put?: (row: Pick<SimPartRow, "uuid" | "ref">, names: string[]) => Promise<string[]>;
}

/**
 * The line of a part's thermal pins: the name of the wire each one is on. The names are
 * written when a field is left or Enter is pressed, and only when they changed.
 */
function ThermalLine({ row, thermal, put, onPut }: { row: SimPartRow; thermal: NonNullable<SimPartRow["thermal"]>; put: SimPartsThermal["put"]; onPut: () => void }): React.ReactElement {
  const { pins, wires } = thermal;
  const named = pins.map((_, i) => wires[i] ?? "");
  const key = named.join(" ");
  const [draft, setDraft] = React.useState(named);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  // the schematic's names win when they change under the line: an undo, a collaborator
  React.useEffect(() => setDraft(key.split(" ")), [key]);
  const commit = (): void => {
    const said = draft.map((n) => n.trim());
    if (!put || busy || said.join(" ") === key) return;
    const problem = said.map(wireNameProblem).find((p) => p !== null);
    if (problem) return setError(problem);
    setBusy(true);
    setError(null);
    put(row, said).then(
      () => {
        setBusy(false);
        onPut();
      },
      (err: unknown) => {
        setBusy(false);
        setError(err instanceof Error ? err.message : String(err));
      },
    );
  };
  const problem = error ?? thermal.problem ?? null;
  return (
    <>
      <div
        data-testid="sim-part-thermal"
        data-ref={row.ref}
        data-wires={wires.join(" ")}
        data-busy={busy ? "yes" : "no"}
        className="flex flex-wrap items-center gap-x-2 gap-y-1 pb-1 pl-[4.25rem] pr-3 text-[11px]"
      >
        {pins.map((pin, i) => (
          <React.Fragment key={pin.pin}>
            <span className="shrink-0 text-neutral-500 dark:text-white/60">{thermalPinLabel(pins, i)}</span>
            {put ? (
              <Tip content={thermalPinTip(row.ref, pin)}>
                <Input
                  data-testid="sim-part-thermal-input"
                  data-pin={pin.pin}
                  aria-label={`Heat wire ${i + 1} of ${row.ref}`}
                  value={draft[i] ?? ""}
                  placeholder="wire name"
                  disabled={busy}
                  spellCheck={false}
                  autoComplete="off"
                  className={`h-6 ${pins.length > 1 ? "w-20" : "w-28"} px-1.5 font-mono text-[11px]`}
                  onChange={(e) => {
                    const next = [...draft];
                    next[i] = e.target.value;
                    setDraft(next);
                    setError(null);
                  }}
                  onBlur={commit}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") commit();
                    else if (e.key === "Escape") setDraft(named);
                  }}
                />
              </Tip>
            ) : (
              <span className="font-mono">{named[i] || "none"}</span>
            )}
          </React.Fragment>
        ))}
      </div>
      {problem && (
        <p data-testid="sim-part-thermal-error" className="pb-1 pl-[4.25rem] pr-3 text-[11px] text-red-600 dark:text-red-300">
          {problem}
        </p>
      )}
    </>
  );
}

/**
 * The line of a chip without a board: the speed it runs at and where that comes from, and
 * a field for the speed by hand ("16MHz"; empty leaves it to the schematic). It is written
 * when the field is left or Enter is pressed, and only when it changed.
 */
function ClockLine({ chip, clock, set, onSet }: { chip: ChipFirmware; clock: ChipClockLine; set: SimPartsFirmware["set"]; onSet: () => void }): React.ReactElement {
  const shown = clock.value === clock.setting.default ? "" : clock.value;
  const [draft, setDraft] = React.useState(shown);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  // the schematic's value wins when it changes under the line: an undo, a collaborator
  React.useEffect(() => setDraft(shown), [shown]);
  const commit = (): void => {
    const value = clockSettingValue(draft);
    if (!set || busy || value === clock.value) return;
    if (!settingAllows(clock.setting, value)) return setError(`"${draft.trim()}" is not a speed: write it like 16MHz, 8MHz or 500kHz, or leave the field empty.`);
    setBusy(true);
    setError(null);
    set(chip, clock.setting, value).then(
      () => {
        setBusy(false);
        onSet();
      },
      (err: unknown) => {
        setBusy(false);
        setError(err instanceof Error ? err.message : String(err));
      },
    );
  };
  const label = clock.setting.label ?? "Clock";
  return (
    <>
      <div
        data-testid="sim-part-clock"
        data-ref={chip.ref}
        data-hz={clock.now.hz}
        data-from={clock.now.from}
        data-setting={clock.value}
        data-busy={busy ? "yes" : "no"}
        className="flex items-center gap-2 pb-1 pl-[4.25rem] pr-3 text-[11px]"
      >
        <span className="shrink-0 text-neutral-500 dark:text-white/60">{label}</span>
        <Tip content={`${chip.ref} runs at this speed when Play is clicked. A sketch is built for one speed: at another its delays and its serial speed are off.`}>
          <span data-testid="sim-part-clock-now" className={`min-w-0 flex-1 truncate ${clock.now.from === "assumed" ? "text-amber-600 dark:text-amber-300" : ""}`}>{clockSource(clock.now)}</span>
        </Tip>
        {set && (
          <Tip content="The speed by hand, like 16MHz. Empty: the crystal on the chip's clock pins says it, or the chip's own 8 MHz.">
            <Input
              data-testid="sim-part-clock-input"
              aria-label={`${label} of ${chip.ref}`}
              value={draft}
              placeholder="auto"
              disabled={busy}
              spellCheck={false}
              autoComplete="off"
              className="h-6 w-20 shrink-0 px-1.5 font-mono text-[11px]"
              onChange={(e) => {
                setDraft(e.target.value);
                setError(null);
              }}
              onBlur={commit}
              onKeyDown={(e) => {
                if (e.key === "Enter") commit();
                else if (e.key === "Escape") setDraft(shown);
              }}
            />
          </Tip>
        )}
      </div>
      {error && (
        <p data-testid="sim-part-clock-error" className="pb-1 pl-[4.25rem] pr-3 text-[11px] text-red-600 dark:text-red-300">
          {error}
        </p>
      )}
    </>
  );
}

/** The chip a file is being stored for, or the sentence its last try ended with. */
type Giving = { uuid: string; busy: true } | { uuid: string; busy: false; error: string };

const STATE_CLASS: Record<SimPartState, string> = {
  live: "text-emerald-600 dark:text-emerald-300",
  suggested: "text-amber-600 dark:text-amber-300",
  choice: "text-amber-600 dark:text-amber-300",
  error: "text-red-600 dark:text-red-300",
  off: "text-neutral-400 dark:text-white/40",
  "own-model": "text-sky-600 dark:text-sky-300",
  kicad: "text-neutral-500 dark:text-white/60",
  none: "text-neutral-400 dark:text-white/40",
  excluded: "text-neutral-400 dark:text-white/40",
};

export function SimPartsPanel({
  mod,
  reader,
  doc,
  firmware,
  thermal,
  report,
  show,
  onClose,
}: {
  mod: SimSymbolsModule;
  reader: SimPartsReader;
  /** The bound collab doc; its changes refresh the list. Null (?collab=0) ⇒ the refresh button only. */
  doc: Y.Doc | null;
  /** The chips' firmware lines. Left out, the list says nothing about firmware. */
  firmware?: SimPartsFirmware;
  /** The lines of the parts' thermal pins. Left out, the list says nothing about heat. */
  thermal?: SimPartsThermal;
  /** The report of the run that was tried last (wasm/live-session.ts). Null: no Play yet. */
  report?: LiveReport | null;
  /** Counts up when something asks for the list (a click on a run's notice): a collapsed panel opens. */
  show?: number;
  onClose: () => void;
}) {
  const rootRef = React.useRef<HTMLDivElement | null>(null);
  const drag = useDraggablePanel({
    storageKey: PANEL_POS_KEY,
    handleWidth: PANEL_W,
    handleHeight: PANEL_HEADER_H,
  });
  const [collapsed, setCollapsedState] = React.useState<boolean>(() => {
    try {
      return localStorage.getItem(PANEL_COLLAPSED_KEY) === "1";
    } catch {
      return false; // private mode
    }
  });
  const setCollapsed = (v: boolean) => {
    setCollapsedState(v);
    try {
      localStorage.setItem(PANEL_COLLAPSED_KEY, v ? "1" : "0");
    } catch {
      /* private mode */
    }
  };

  // somebody asked for the list: a panel that was left collapsed shows it
  React.useEffect(() => {
    if (show) setCollapsedState(false);
  }, [show]);

  const [view, setView] = React.useState<View>({ status: "loading" });
  const [busy, setBusy] = React.useState(false);
  // Only the newest read may answer: a slow first read must not overwrite a later one.
  const latest = React.useRef(0);

  const withFirmware = !!firmware;
  const refresh = React.useCallback(() => {
    const turn = ++latest.current;
    setBusy(true);
    reader.read(mod).then(
      async (parts) => {
        // Which file each chip runs. A library that cannot say leaves the lines out: the rows are still right.
        const none = new Map<string, ChipFirmware>();
        const chips = withFirmware ? await chipFirmwares(parts).catch(() => none) : none;
        if (turn !== latest.current) return;
        // a crystal that clocks a chip is used by the run, though no part and no model stands for it
        const { rows, leftOut } = withClocking(simPartRows(parts), parts.leftOut, clockingCrystals(chips));
        setView({ status: "ready", version: parts.library.version, rows, problems: parts.problems, chips, leftOut, notLoaded: parts.notLoaded });
        setBusy(false);
      },
      (err: unknown) => {
        if (turn !== latest.current) return;
        setView({ status: "error", message: err instanceof Error ? err.message : String(err) });
        setBusy(false);
      },
    );
  }, [mod, reader, withFirmware]);

  // A chip's firmware: one hidden file chooser for the whole list, opened for one chip.
  const fileInput = React.useRef<HTMLInputElement | null>(null);
  const pickingFor = React.useRef<ChipFirmware | null>(null);
  const [giving, setGiving] = React.useState<Giving | null>(null);
  const choose = firmware?.choose;
  const give = (chip: ChipFirmware, file: File) => {
    if (!choose) return;
    setGiving({ uuid: chip.uuid, busy: true });
    choose(chip, file).then(
      () => {
        setGiving(null);
        refresh();
      },
      (err: unknown) => setGiving({ uuid: chip.uuid, busy: false, error: err instanceof Error ? err.message : String(err) }),
    );
  };

  React.useEffect(() => {
    refresh();
    return () => {
      latest.current++; // a read still under way answers nobody
    };
  }, [refresh]);

  // Follow edits: a remote change reaches the doc before the editor applied
  // it, so wait until the doc has been quiet for a moment, then read.
  React.useEffect(() => {
    if (!doc) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const onUpdate = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(refresh, REFRESH_QUIET_MS);
    };
    doc.on("update", onUpdate);
    return () => {
      doc.off("update", onUpdate);
      if (timer) clearTimeout(timer);
    };
  }, [doc, refresh]);

  const style: React.CSSProperties = drag.pos
    ? { left: drag.pos.x, top: drag.pos.y }
    : { left: 12, top: 56 };

  const rows = view.status === "ready" ? view.rows : [];
  const chips = view.status === "ready" ? view.chips : null;
  const live = rows.filter((r) => r.state === "live").length;

  return (
    <div
      ref={rootRef}
      data-snap-panel={drag.snapId}
      data-dock-title="Simulation parts"
      data-testid="sim-parts-panel"
      data-status={view.status}
      className="absolute z-40 flex w-96 flex-col overflow-hidden rounded-xl bg-white/95 text-neutral-900 shadow-2xl ring-1 ring-inset ring-black/10 backdrop-blur-sm dark:bg-neutral-950/90 dark:text-white dark:ring-white/15"
      style={drag.docked ?? style}
    >
      {/* Header = drag handle. Interactive children stop pointerdown so they
          don't start a drag. */}
      <Tip content="Simulation parts - drag to move">
        <div
          data-testid="sim-parts-panel-header"
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
              data-testid="sim-parts-panel-collapse"
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
          <span>Simulation parts</span>
          {view.status === "ready" && (
            <span data-testid="sim-parts-live-count" className="text-[10px] font-normal text-neutral-400 dark:text-white/40">
              {live} live
            </span>
          )}
          <span className="ml-auto flex items-center gap-0.5" onPointerDown={(e) => e.stopPropagation()}>
            <Tip content="Read the schematic again">
              <Button
                data-testid="sim-parts-panel-refresh"
                onClick={refresh}
                disabled={busy}
                variant="plain"
                size="icon-xs"
                className={overlayIconClass}
              >
                <RefreshCw size={13} className={busy ? "animate-spin" : undefined} />
              </Button>
            </Tip>
            <Tip content="Close">
              <Button
                data-testid="sim-parts-panel-close"
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
        <div data-testid="sim-parts-panel-list" className="max-h-[60vh] overflow-y-auto pb-1">
          {view.status === "loading" && (
            <p className="px-3 pb-3 text-xs text-neutral-500 dark:text-white/50">
              Reading the simulation library...
            </p>
          )}
          {view.status === "error" && (
            <p data-testid="sim-parts-panel-error" className="px-3 pb-3 text-xs text-red-600 dark:text-red-300">
              The parts could not be listed: {view.message}
            </p>
          )}
          {/* a sheet that did not load: said here, unless the last run's own reason says the same below */}
          {view.status === "ready" && view.notLoaded.length > 0 && !report?.problem?.includes(notLoadedSentence(view.notLoaded)) && (
            <p data-testid="sim-parts-not-loaded" className="border-t border-black/5 px-3 py-1 text-[11px] text-red-600 dark:border-white/5 dark:text-red-300">
              {notLoadedSentence(view.notLoaded).replace(/^t/, "T")}
            </p>
          )}
          <LeftOutBlock report={report ?? null} now={view.status === "ready" ? view.leftOut : null} />
          {view.status === "ready" && rows.length === 0 && (
            <p className="px-3 pb-3 text-xs text-neutral-500 dark:text-white/50">
              This schematic has no symbols yet.
            </p>
          )}
          {rows.map((r) => {
            const chip = firmware && r.state === "live" ? chips?.get(r.uuid) : undefined;
            const stored = chip ? firmware!.inProject(chip.name) : false;
            const mine = chip && giving?.uuid === chip.uuid ? giving : null;
            // the simulator's reason for the last run names a line of this symbol
            const named = !!report?.problem && report.about.includes(r.ref);
            return (
              <React.Fragment key={r.key}>
                <Tip content={r.sheet === "/" ? r.note : `${r.note} Sheet ${r.sheet}`}>
                  <div
                    data-testid="sim-part-row"
                    data-ref={r.ref}
                    data-state={r.state}
                    data-reason={r.reason ?? ""}
                    data-named={named ? "yes" : "no"}
                    className={`flex items-baseline gap-2 border-t border-black/5 px-3 py-1 text-xs dark:border-white/5 ${named ? "bg-red-500/10" : ""}`}
                  >
                    <span className="w-12 shrink-0 truncate font-semibold">{r.ref}</span>
                    <span className="w-24 shrink-0 truncate text-neutral-500 dark:text-white/60">{r.value}</span>
                    <span data-testid="sim-part-row-part" className="min-w-0 flex-1 truncate">{r.part}</span>
                    <span className={`shrink-0 text-[11px] ${named ? "text-red-600 dark:text-red-300" : STATE_CLASS[r.state]}`}>{named ? "named by the simulator" : r.label}</span>
                  </div>
                </Tip>
                {chip && (
                  <div
                    data-testid="sim-part-firmware"
                    data-ref={r.ref}
                    data-name={chip.name}
                    data-stored={stored ? "yes" : "no"}
                    data-busy={mine?.busy ? "yes" : "no"}
                    className="flex items-center gap-2 pb-1 pl-[4.25rem] pr-3 text-[11px]"
                  >
                    <span className="shrink-0 text-neutral-500 dark:text-white/60">Firmware</span>
                    <Tip content={stored ? `${r.ref} runs the project's file ${chip.name}.` : `${r.ref} asks for ${chip.name}. The project has no such file yet.`}>
                      <span className="min-w-0 flex-1 truncate">
                        <span className="font-mono">{chip.name}</span>
                        {!stored && <span className="text-amber-600 dark:text-amber-300"> - not in the project</span>}
                      </span>
                    </Tip>
                    {choose && (
                      <Button
                        data-testid="sim-part-firmware-choose"
                        variant="outline"
                        size="xs"
                        className="h-6 shrink-0 px-2 text-[11px]"
                        disabled={giving?.busy === true}
                        onClick={() => {
                          pickingFor.current = chip;
                          // the chooser shows the files of this chip's kind: .bin for an ESP32, .hex for an Arduino
                          if (fileInput.current) fileInput.current.accept = firmwareExtension(chip);
                          fileInput.current?.click();
                        }}
                      >
                        {mine?.busy ? "Storing..." : "Choose file..."}
                      </Button>
                    )}
                  </div>
                )}
                {chip?.clock && <ClockLine chip={chip} clock={chip.clock} set={firmware?.set} onSet={refresh} />}
                {thermal && r.state === "live" && r.thermal && <ThermalLine row={r} thermal={r.thermal} put={thermal.put} onPut={refresh} />}
                {mine && !mine.busy && (
                  <p
                    data-testid="sim-part-firmware-error"
                    className="pb-1 pl-[4.25rem] pr-3 text-[11px] text-red-600 dark:text-red-300"
                  >
                    {mine.error}
                  </p>
                )}
              </React.Fragment>
            );
          })}
          {choose && (
            <input
              ref={fileInput}
              data-testid="sim-part-firmware-input"
              type="file"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                const chip = pickingFor.current;
                e.target.value = ""; // the same file can be chosen again (a new build)
                if (file && chip) give(chip, file);
              }}
            />
          )}
          {view.status === "ready" &&
            view.problems.map((text, i) => (
              <p
                key={i}
                data-testid="sim-parts-problem"
                className="border-t border-black/5 px-3 py-1 text-[11px] text-amber-700 dark:border-white/5 dark:text-amber-300"
              >
                KiCad: {text}
              </p>
            ))}
          {view.status === "ready" && (
            <p
              data-testid="sim-parts-library-version"
              className="border-t border-black/5 px-3 pt-1.5 text-[10px] text-neutral-400 dark:border-white/5 dark:text-white/40"
            >
              Library {view.version}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
