import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  EDITOR_EVENT,
  __resetEditorEventsForTests,
  anyDialogOpen,
  anyModalDialogOpen,
  installEditorEvents,
  onEditorEvent,
  openDialog,
  openDialogPtrs,
  parseEditorEvent,
  type EditorEvent,
} from "./editor-events";

const fire = (t: EventTarget, detail: unknown) => t.dispatchEvent(new CustomEvent(EDITOR_EVENT, { detail }));

describe("editor-events", () => {
  let target: EventTarget;
  let seen: EditorEvent[];

  beforeEach(() => {
    target = new EventTarget();
    seen = [];
    installEditorEvents(target);
    onEditorEvent((e) => seen.push(e));
  });
  afterEach(() => __resetEditorEventsForTests());

  it("validates details", () => {
    expect(parseEditorEvent({ type: "action", name: "a.b", depth: 1 })).toEqual({ type: "action", name: "a.b", depth: 1 });
    expect(parseEditorEvent({ type: "action", name: "" })).toBeNull();
    expect(parseEditorEvent({ type: "dialogShown", cls: "D", ptr: 5 })).toBeNull();
    expect(parseEditorEvent({ type: "checkFinished", kind: "erc", errors: 2, warnings: 0, unconnected: 0 })).toEqual({
      type: "checkFinished",
      kind: "erc",
      errors: 2,
      warnings: 0,
      unconnected: 0,
    });
    expect(parseEditorEvent({ type: "checkFinished", kind: "drc", errors: 0, warnings: 1 })).toMatchObject({ unconnected: 0 });
    expect(parseEditorEvent({ type: "checkFinished", kind: "lvs", errors: 0, warnings: 0 })).toBeNull();
    expect(parseEditorEvent({ type: "checkFinished", kind: "erc", errors: -1, warnings: 0 })).toBeNull();
    expect(parseEditorEvent("x")).toBeNull();
    expect(parseEditorEvent(null)).toBeNull();
  });

  it("fans out actions", () => {
    fire(target, { type: "action", name: "eeschema.InteractiveDrawing.placeSymbol", depth: 0 });
    fire(target, { type: "bogus" });
    expect(seen).toEqual([{ type: "action", name: "eeschema.InteractiveDrawing.placeSymbol", depth: 0 }]);
  });

  it("tracks open dialogs per class, newest first", () => {
    fire(target, { type: "dialogShown", cls: "D", ptr: "1", title: "one" });
    fire(target, { type: "dialogShown", cls: "D", ptr: "2", title: "two" });
    expect(openDialog("D")).toEqual({ ptr: "2", title: "two", modal: true });
    fire(target, { type: "dialogClosed", cls: "D", ptr: "2", title: "two" });
    expect(openDialog("D")).toEqual({ ptr: "1", title: "one", modal: true });
    fire(target, { type: "dialogClosed", cls: "D", ptr: "1", title: "one" });
    expect(openDialog("D")).toBeNull();
  });

  it("is idempotent per target and stops on dispose", () => {
    const dispose = installEditorEvents(target);
    fire(target, { type: "action", name: "x" });
    expect(seen).toHaveLength(1);
    dispose();
    fire(target, { type: "action", name: "y" });
    expect(seen).toHaveLength(1);
  });
  it("tells modal dialogs (a nested loop runs) from modeless ones; an engine that does not say is modal", () => {
    expect(parseEditorEvent({ type: "dialogShown", cls: "D", ptr: "1" })).toMatchObject({ modal: true });
    fire(target, { type: "dialogShown", cls: "DIALOG_ERC", ptr: "1", title: "ERC", modal: false });
    expect(anyDialogOpen()).toBe(true);
    expect(anyModalDialogOpen()).toBe(false);
    fire(target, { type: "dialogShown", cls: "DIALOG_SYMBOL_CHOOSER", ptr: "2", title: "Choose Symbol", modal: true });
    expect(anyModalDialogOpen()).toBe(true);
    fire(target, { type: "dialogClosed", cls: "DIALOG_SYMBOL_CHOOSER", ptr: "2", title: "Choose Symbol" });
    expect(anyModalDialogOpen()).toBe(false);
    expect(openDialog("DIALOG_ERC")).toEqual({ ptr: "1", title: "ERC", modal: false });
  });

  it("parses the simulator's events (overlay-system 0006), rejecting malformed ones", () => {
    expect(parseEditorEvent({ type: "simFinished", kind: "tran", ok: true, points: 3600, traces: ["I(D1)", 7, ""] })).toEqual({
      type: "simFinished", kind: "tran", ok: true, points: 3600, traces: ["I(D1)"],
    });
    expect(parseEditorEvent({ type: "simFinished", kind: "tran", points: -1 })).toEqual({ type: "simFinished", kind: "tran", ok: false, points: 0, traces: [] });
    expect(parseEditorEvent({ type: "simPlotChanged", kind: "tran", traces: ["I(D1)", "I(D2)"] })).toEqual({
      type: "simPlotChanged", kind: "tran", traces: ["I(D1)", "I(D2)"],
    });
    expect(parseEditorEvent({ type: "simFinished", points: 3 })).toBeNull();
    expect(parseEditorEvent({ type: "simPlotChanged", kind: "x".repeat(40), traces: [] })).toBeNull();
  });

  it("lists every open dialog's pointer, across classes", () => {
    fire(target, { type: "dialogShown", cls: "A", ptr: "1", title: "" });
    fire(target, { type: "dialogShown", cls: "B", ptr: "2", title: "" });
    fire(target, { type: "dialogShown", cls: "A", ptr: "3", title: "" });
    expect(openDialogPtrs().sort()).toEqual(["1", "2", "3"]);
    fire(target, { type: "dialogClosed", cls: "A", ptr: "1", title: "" });
    expect(openDialogPtrs().sort()).toEqual(["2", "3"]);
  });
});
