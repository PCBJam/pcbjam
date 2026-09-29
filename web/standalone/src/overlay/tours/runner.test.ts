import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { __resetOverlayForTests, overlay, pressButton } from "../api";
import { EDITOR_EVENT, __resetEditorEventsForTests, installEditorEvents } from "../editor-events";
import { addResistorTour, placedSymbolUuids } from "./add-resistor";
import { startTour, type Tour } from "./runner";

// sessionStorage for the node test environment.
const store = new Map<string, string>();
(globalThis as { sessionStorage?: Pick<Storage, "getItem" | "setItem"> }).sessionStorage = {
  getItem: (k) => store.get(k) ?? null,
  setItem: (k, v) => void store.set(k, v),
};

const sym = (libId: string, uuid: string) => ({ uuid, libId });
const snap = (...rows: { uuid: string; libId: string }[]) => JSON.stringify(rows);

describe("placedSymbolUuids", () => {
  it("returns the uuids of matching lib ids only", () => {
    const raw = JSON.stringify([sym("Device:R", "AAA"), sym("Device:C", "bbb"), { uuid: 5 }, null, sym("Device:R", "ccc")]);
    expect(placedSymbolUuids(raw, "Device:R")).toEqual(["aaa", "ccc"]);
    expect(placedSymbolUuids("{", "Device:R")).toEqual([]);
    expect(placedSymbolUuids('{"a":1}', "Device:R")).toEqual([]);
  });
});

describe("tour runner", () => {
  let target: EventTarget;
  const fire = (detail: unknown) => target.dispatchEvent(new CustomEvent(EDITOR_EVENT, { detail }));

  beforeEach(() => {
    store.clear();
    __resetOverlayForTests();
    target = new EventTarget();
    installEditorEvents(target);
  });
  afterEach(() => __resetEditorEventsForTests());

  it("walks add-resistor by state, not by script", () => {
    let raw: string | undefined = snap(sym("Device:R", "old"));
    const runner = startTour(addResistorTour(() => raw), { poll: false });
    expect(runner.currentStep()).toBe("tool");
    expect(overlay.getState().step).toMatchObject({ owner: "builtin:add-resistor", progress: { step: 1, of: 4 } });

    fire({ type: "dialogShown", cls: "DIALOG_SYMBOL_CHOOSER", ptr: "9", title: "Choose Symbol" });
    runner.tick();
    expect(runner.currentStep()).toBe("search");
    expect(overlay.getState().step?.target).toBe("dialog:DIALOG_SYMBOL_CHOOSER/control:searchctrl");

    fire({ type: "dialogClosed", cls: "DIALOG_SYMBOL_CHOOSER", ptr: "9", title: "" });
    runner.tick();
    expect(runner.currentStep()).toBe("place");

    // A busy engine (undefined) must not count; the pre-existing R never does.
    raw = undefined;
    runner.tick();
    expect(runner.currentStep()).toBe("place");
    raw = snap(sym("Device:R", "old"), sym("Device:R", "new"));
    runner.tick();
    expect(runner.currentStep()).toBe("done");
    expect(overlay.getState().step).toMatchObject({ target: "item:new", buttons: ["next"] });

    pressButton("next");
    expect(overlay.getState().step).toBeNull();
    expect(store.get("pcbjam:tour:add-resistor")).toBe("done");
  });

  it("goes back when the user cancels out of the tool", () => {
    const runner = startTour(addResistorTour(() => snap()), { poll: false });
    fire({ type: "dialogClosed", cls: "DIALOG_SYMBOL_CHOOSER", ptr: "9", title: "" });
    runner.tick();
    expect(runner.currentStep()).toBe("place");
    fire({ type: "action", name: "eeschema.InteractiveDrawing.placeSymbol", depth: 0 });
    runner.tick();
    expect(runner.currentStep()).toBe("tool");
  });

  it("does not re-show an unchanged step and stops when the user closes it", () => {
    const tour: Tour<number> = {
      id: "t",
      editor: "eeschema",
      title: "T",
      sample: () => 1,
      steps: [{ id: "only", when: () => true, content: () => ({ text: "hi" }) }],
    };
    const runner = startTour(tour, { poll: false });
    const id = overlay.getState().id;
    runner.tick();
    expect(overlay.getState().id).toBe(id);
    pressButton("close");
    expect(store.get("pcbjam:tour:t")).toBe("dismissed");
    runner.tick();
    expect(overlay.getState().step).toBeNull();
  });

  it("keeps the tour active when the page unmounts (editor switch)", () => {
    const tour: Tour<number> = {
      id: "u",
      editor: "eeschema",
      title: "U",
      sample: () => 1,
      steps: [{ id: "only", when: () => true, content: () => ({ text: "hi" }) }],
    };
    startTour(tour, { poll: false });
    overlay.clear(undefined, "unmount");
    expect(store.get("pcbjam:tour:u")).toBe("active");
  });
});

describe("demoTourFor", () => {
  beforeEach(() => store.clear());

  it("starts the named tour only in its editor", async () => {
    const { demoTourFor } = await import("../demo");
    expect(demoTourFor("eeschema", "?overlayDemo=add-resistor")).toBe("add-resistor");
    expect(demoTourFor("pcbnew", "?overlayDemo=add-resistor")).toBeNull();
    expect(demoTourFor("eeschema", "?overlayDemo=nope")).toBeNull();
    expect(demoTourFor("eeschema", "")).toBeNull();
  });

  it("resumes an active tour without the query, never a done/dismissed one", async () => {
    const { demoTourFor } = await import("../demo");
    store.set("pcbjam:tour:add-resistor", "active");
    expect(demoTourFor("eeschema", "")).toBe("add-resistor");
    store.set("pcbjam:tour:add-resistor", "dismissed");
    expect(demoTourFor("eeschema", "")).toBeNull();
    store.set("pcbjam:tour:add-resistor", "done");
    expect(demoTourFor("eeschema", "")).toBeNull();
  });
});
