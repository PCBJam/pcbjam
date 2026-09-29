import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { __resetOverlayForTests, overlay, pressButton } from "../api";
import { EDITOR_EVENT, __resetEditorEventsForTests, installEditorEvents } from "../editor-events";
import { addResistorTour } from "./add-resistor";
import type { TourDeps } from "./declarative";
import { anyDialogOpen, openDialog } from "../editor-events";
import { startTour, type Tour } from "./runner";

// sessionStorage for the node test environment.
const store = new Map<string, string>();
(globalThis as { sessionStorage?: Pick<Storage, "getItem" | "setItem"> }).sessionStorage = {
  getItem: (k) => store.get(k) ?? null,
  setItem: (k, v) => void store.set(k, v),
};

const sym = (libId: string, uuid: string, ref = "R?") => ({ uuid, libId, ref, value: "", footprint: "" });
const snap = (...rows: ReturnType<typeof sym>[]) => JSON.stringify(rows);

/** Engine deps over a mutable sheet + the (test-installed) editor events. */
function fakeDeps(sheet: { raw: string; busy?: boolean }): TourDeps {
  return {
    symbols: () => sheet.raw,
    nets: () => "[]",
    openBusy: () => !!sheet.busy,
    dialogOpen: (cls) => !!openDialog(cls),
    anyDialogOpen,
  };
}

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

  it("walks the declarative add-resistor by state, not by script", async () => {
    const sheet = { raw: snap(sym("Device:R", "old", "R1")), busy: false };
    const runner = startTour(addResistorTour(fakeDeps(sheet)), { poll: false });
    expect(runner.currentStep()).toBe("tool");
    expect(overlay.getState().step).toMatchObject({ owner: "builtin:add-resistor", progress: { step: 1, of: 4 } });

    fire({ type: "dialogShown", cls: "DIALOG_SYMBOL_CHOOSER", ptr: "9", title: "Choose Symbol" });
    runner.tick(); // the event reaches the sampler through the next tick
    expect(runner.currentStep()).toBe("search");
    expect(overlay.getState().step).toMatchObject({
      target: "dialog:DIALOG_SYMBOL_CHOOSER/control:searchctrl",
      placement: "right",
    });

    fire({ type: "dialogClosed", cls: "DIALOG_SYMBOL_CHOOSER", ptr: "9", title: "" });
    runner.tick();
    expect(runner.currentStep()).toBe("place");

    // A busy engine (file open) must not count; the pre-existing R never does.
    sheet.busy = true;
    sheet.raw = snap();
    runner.tick();
    expect(runner.currentStep()).toBe("place");
    sheet.busy = false;
    sheet.raw = snap(sym("Device:R", "old", "R1"), sym("Device:R", "new", "R2"));
    runner.tick();
    expect(runner.currentStep()).toBe("done");
    expect(overlay.getState().step).toMatchObject({ target: "item:new", buttons: ["next"], progress: { step: 4, of: 4 } });

    pressButton("next");
    expect(overlay.getState().step).toBeNull();
    expect(store.get("pcbjam:tour:add-resistor")).toBe("done");
  });

  it("re-shows the search step whenever the chooser reopens", () => {
    const sheet = { raw: snap() };
    const runner = startTour(addResistorTour(fakeDeps(sheet)), { poll: false });
    fire({ type: "dialogShown", cls: "DIALOG_SYMBOL_CHOOSER", ptr: "9", title: "" });
    runner.tick();
    fire({ type: "dialogClosed", cls: "DIALOG_SYMBOL_CHOOSER", ptr: "9", title: "" });
    runner.tick();
    expect(runner.currentStep()).toBe("place");
    fire({ type: "dialogShown", cls: "DIALOG_SYMBOL_CHOOSER", ptr: "10", title: "" });
    runner.tick();
    expect(runner.currentStep()).toBe("search");
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
