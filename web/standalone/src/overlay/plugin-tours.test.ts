import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { __resetOverlayForTests, overlay, pressButton } from "./api";
import { __resetEditorEventsForTests } from "./editor-events";
import { pluginSheetAdapter, pluginTourAdapter } from "./plugin-tours";
import type { TourDeps } from "./tours/declarative";
import { addResistorTour } from "./tours/add-resistor";
import { __stopAllToursForTests, readTourStatus, runningTours, startTour } from "./tours/runner";

const store = new Map<string, string>();
(globalThis as { localStorage?: Pick<Storage, "getItem" | "setItem"> }).localStorage = {
  getItem: (k) => store.get(k) ?? null,
  setItem: (k, v) => void store.set(k, v),
};

// Pointer targets resolve against the page: an empty one here (node environment).
(globalThis as { document?: unknown }).document ??= {
  querySelector: () => null,
  querySelectorAll: () => [],
  getElementById: () => null,
};

const deps = (over: Partial<TourDeps> = {}): TourDeps => ({
  symbols: () => "[]",
  nets: () => "[]",
  board: () => "{}",
  openBusy: () => false,
  dialogOpen: () => false,
  anyDialogOpen: () => false,
  modalDialogOpen: () => false,
  ...over,
});

const TOUR = {
  id: "blinky",
  editor: "eeschema",
  steps: [
    { id: "r", text: "Place a resistor", until: { symbols: { libId: "Device:R", min: 1 } } },
    { id: "end", text: "Done", until: { next: true } },
  ],
};

describe("pluginTourAdapter", () => {
  let abort: AbortController;
  const make = (key = "p1", tool = "eeschema", project: string | null = "proj-1") =>
    pluginTourAdapter({ pluginKey: key, pluginName: "Blinky Guide", project, tool: () => tool, signal: abort.signal, deps: deps() });

  beforeEach(() => {
    store.clear();
    __resetOverlayForTests();
    abort = new AbortController();
  });
  afterEach(() => {
    abort.abort();
    __stopAllToursForTests();
    __resetEditorEventsForTests();
  });

  it("runs a valid tour under the plugin's own name", () => {
    const a = make();
    expect(a.start(TOUR, false)).toEqual({ status: "started" });
    expect(overlay.getState().step).toMatchObject({ owner: "plugin:p1", attribution: "Blinky Guide", text: "Place a resistor" });
    expect(a.status()).toEqual({ id: "blinky", step: 1, of: 2, state: "active" });
  });

  it("ignores the tour's title for attribution", () => {
    make().start({ ...TOUR, title: "PCBJam official" }, false);
    expect(overlay.getState().step?.attribution).toBe("Blinky Guide");
  });

  it("rejects invalid tours, other editors and host-only targets", () => {
    const a = make();
    expect(() => a.start({ ...TOUR, steps: [] }, false)).toThrow(/invalid tour/);
    expect(() => a.start({ ...TOUR, editor: "pcbnew" }, false)).toThrow(/pcbnew editor/);
    expect(() => a.start({ ...TOUR, steps: [{ ...TOUR.steps[1], target: "panel:layers" }] }, false)).toThrow(/panel targets/);
    expect(runningTours()).toEqual([]);
  });

  it("is busy while another tour runs", () => {
    startTour(addResistorTour(deps()), { poll: false });
    expect(make().start(TOUR, false)).toEqual({ status: "busy" });
    expect(() => make().showPointer({ target: "menu:File", text: "x" })).toThrow(/Another guide/);
  });

  it("resumes only a tour still active in this project", () => {
    expect(make().start(TOUR, true)).toEqual({ status: "not-active" });
    make().start(TOUR, false);
    abort.abort(); // page goes away: tour stops, status stays active
    abort = new AbortController();
    expect(runningTours()).toEqual([]);
    expect(make().start(TOUR, true)).toEqual({ status: "started" });
    pressButton("close"); // user dismisses
    abort = new AbortController();
    expect(make().start(TOUR, true)).toEqual({ status: "not-active" });
  });

  it("keeps plugins' and projects' progress apart", () => {
    make("p1").start(TOUR, false);
    expect(readTourStatus("plugin:p1:proj-1:blinky")).toBe("active");
    expect(readTourStatus("blinky")).toBeNull();
    abort.abort(); // the page goes away
    abort = new AbortController();
    expect(make("p2").start(TOUR, true)).toEqual({ status: "not-active" }); // another plugin
    expect(make("p1", "eeschema", "proj-2").start(TOUR, true)).toEqual({ status: "not-active" }); // another project
    expect(make("p1", "eeschema", "proj-1").start(TOUR, true)).toEqual({ status: "started" });
  });

  it("pointers: shown or not-found, never during the plugin's own tour, cleared on stop", () => {
    const a = make();
    expect(a.showPointer({ target: "area:0,0,10,10", text: "here" })).toBe("not-found"); // no viewport in tests
    expect(overlay.getState().step).toMatchObject({ owner: "plugin:p1", attribution: "Blinky Guide", text: "here" });
    expect(() => a.showPointer({ target: "panel:layers", text: "x" })).toThrow(/panel targets/);
    a.start(TOUR, false);
    expect(() => a.showPointer({ target: "menu:File", text: "x" })).toThrow(/Stop your tour/);
    a.clearPointer(); // must not clear the tour's card
    expect(overlay.getState().step?.text).toBe("Place a resistor");
    a.stop();
    expect(overlay.getState().step).toBeNull();
    a.showPointer({ target: "menu:File", text: "x" });
    abort.abort();
    expect(overlay.getState().step).toBeNull();
    expect(() => a.showPointer({ target: "menu:File", text: "x" })).toThrow();
  });
});

describe("pluginTourAdapter lifecycle hooks", () => {
  it("reports start, running and end so the sidebar can collapse or keep a hidden panel", () => {
    store.clear();
    __resetOverlayForTests();
    const abort = new AbortController();
    const events: string[] = [];
    const a = pluginTourAdapter({
      pluginKey: "p9",
      pluginName: "Blinky Guide",
      tool: () => "eeschema",
      signal: abort.signal,
      deps: deps(),
      onTourStart: () => events.push("start"),
      onTourEnd: (status) => events.push("end:" + (status ?? "none")),
    });
    expect(a.isRunning()).toBe(false);
    a.start(TOUR, false);
    expect(a.isRunning()).toBe(true);
    pressButton("close"); // the user dismisses the card
    expect(a.isRunning()).toBe(false);
    a.start(TOUR, false);
    abort.abort(); // the plugin stops
    expect(events).toEqual(["start", "end:dismissed", "start", "end:none"]);
    __stopAllToursForTests();
  });
});

describe("pluginTourAdapter: a tour without close", () => {
  it("pauses when its panel closes — no status change — and resumes when it reopens", () => {
    store.clear();
    __resetOverlayForTests();
    const make = (signal: AbortSignal) =>
      pluginTourAdapter({ pluginKey: "p8", pluginName: "Blinky Guide", tool: () => "eeschema", signal, deps: deps() });
    const abort = new AbortController();
    const a = make(abort.signal);
    a.start(TOUR, false);
    expect(a.pausesOnClose()).toBe(false); // closable: the sidebar keeps its panel alive, hidden
    a.start({ ...TOUR, closable: false }, false);
    expect(a.pausesOnClose()).toBe(true);
    pressButton("close"); // there is no × to press; a stray close changes nothing
    expect(a.isRunning()).toBe(true);
    abort.abort(); // the sidebar closes the panel: the plugin stops, and its tour with it
    expect(a.isRunning()).toBe(false);
    expect(a.pausesOnClose()).toBe(false);
    expect(make(new AbortController().signal).start({ ...TOUR, closable: false }, true)).toEqual({ status: "started" });
    __stopAllToursForTests();
  });
});

describe("pluginSheetAdapter", () => {
  it("returns parsed engine reads and refuses while busy", () => {
    const sheet = pluginSheetAdapter(
      deps({
        symbols: () => JSON.stringify([{ uuid: "A", libId: "Device:R", ref: "R1", value: "10k", footprint: "" }]),
        nets: () => JSON.stringify([{ net: "+5V", pins: [{ uuid: "A", ref: "R1", libId: "Device:R", pin: "1", name: "~", noConnect: false }] }]),
      }),
    );
    expect(sheet.symbols()).toEqual([{ uuid: "a", libId: "Device:R", ref: "R1", value: "10k", footprint: "" }]);
    expect(sheet.connectivity()).toEqual([{ net: "+5V", pins: [{ uuid: "a", ref: "R1", libId: "Device:R", pin: "1", name: "~", noConnect: false }] }]);
    expect(() => pluginSheetAdapter(deps({ openBusy: () => true })).symbols()).toThrow(/loading/);
    expect(() => pluginSheetAdapter(deps({ anyDialogOpen: () => true, modalDialogOpen: () => true })).connectivity()).toThrow(/dialog/);
    // A modeless dialog (ERC) leaves the sheet readable.
    expect(pluginSheetAdapter(deps({ anyDialogOpen: () => true })).connectivity()).toEqual([]);
  });
});
