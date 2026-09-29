import { describe, expect, it } from "vitest";
import { findDialogControl, isWithin } from "./dialog-controls";

const win = (id: string, parentId: string | null, typeName: string, label = "", over: Partial<WxElementInfo> = {}) =>
  [
    id,
    {
      id,
      parentId,
      typeName,
      name: "",
      label,
      visible: true,
      enabled: true,
      screenX: 10,
      screenY: 20,
      centerX: 0,
      centerY: 0,
      width: 30,
      height: 40,
      ...over,
    } as WxElementInfo,
  ] as const;

const rendered = (parentId: string, elementType: string, label = "", over: Partial<WxRenderedElementInfo> = {}) =>
  ({
    id: `${parentId}:${elementType}:0`,
    parentId,
    elementType,
    subType: "",
    label,
    tooltip: "",
    screenX: 1,
    screenY: 2,
    width: 3,
    height: 4,
    centerX: 0,
    centerY: 0,
    enabled: true,
    index: 0,
    ...over,
  }) as WxRenderedElementInfo;

// dialog D ─ panel P ─ { OK button, Cancel button, search ctrl S (owner-drawn) }
// other dialog E ─ Cancel button
const windows = new Map<string, WxElementInfo>([
  win("D", null, "wxDialog", "Choose Symbol"),
  win("P", "D", "wxPanel"),
  win("OK", "P", "wxButton", "&OK"),
  win("CANCEL", "P", "wxButton", "Cancel"),
  win("S", "P", "wxSearchCtrl"),
  win("E", null, "wxDialog"),
  win("ECANCEL", "E", "wxButton", "Cancel"),
  win("HIDDEN", "P", "wxChoice", "", { visible: false }),
]);

describe("isWithin", () => {
  it("walks the parent chain", () => {
    expect(isWithin("OK", "D", windows)).toBe(true);
    expect(isWithin("D", "D", windows)).toBe(true);
    expect(isWithin("ECANCEL", "D", windows)).toBe(false);
    expect(isWithin(null, "D", windows)).toBe(false);
  });

  it("uses topLevelId when the parent chain is broken by unregistered panels", () => {
    const broken = new Map([
      win("D2", null, "wxDialog"),
      win("S2", "UNREGISTERED_PANEL", "wxSearchCtrl", "", { topLevelId: "D2" }),
    ]);
    expect(isWithin("S2", "D2", broken)).toBe(true);
    expect(findDialogControl("D2", { type: "searchctrl" }, broken, [])).toBe(broken.get("S2"));
    expect(findDialogControl("D2", { type: "listrow" }, broken, [rendered("S2", "listrow")])?.screenX).toBe(1);
    expect(findDialogControl("D", { type: "listrow" }, broken, [rendered("S2", "listrow")])).toBeNull();
  });

  it("stops on cycles", () => {
    const loop = new Map([win("A", "B", "wxPanel"), win("B", "A", "wxPanel")]);
    expect(isWithin("A", "X", loop)).toBe(false);
  });
});

describe("findDialogControl", () => {
  it("matches wx windows by class without the wx prefix and by label", () => {
    expect(findDialogControl("D", { type: "button", label: "Cancel" }, windows, [])).toBe(windows.get("CANCEL"));
    expect(findDialogControl("D", { type: "Button", label: "ok" }, windows, [])).toBe(windows.get("OK"));
  });

  it("stays inside the given dialog", () => {
    expect(findDialogControl("E", { type: "button", label: "Cancel" }, windows, [])).toBe(windows.get("ECANCEL"));
  });

  it("prefers the window over an owner-drawn item of the same type", () => {
    const field = rendered("S", "searchctrl", "Search");
    expect(findDialogControl("D", { type: "searchctrl" }, windows, [field])).toBe(windows.get("S"));
  });

  it("matches owner-drawn items painted by a descendant", () => {
    const row = rendered("S", "listrow", "R");
    const elsewhere = rendered("E", "listrow", "R");
    expect(findDialogControl("D", { type: "listrow" }, windows, [elsewhere, row])).toBe(row);
  });

  it("skips hidden and empty candidates", () => {
    expect(findDialogControl("D", { type: "choice" }, windows, [])).toBeNull();
    expect(findDialogControl("D", { type: "listrow" }, windows, [rendered("S", "listrow", "", { width: 0 })])).toBeNull();
  });


});
