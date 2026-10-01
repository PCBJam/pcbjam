import { describe, expect, it } from "vitest";
import { isCanvasWork, isTargetAction, pointInRect, stepUseKey, targetActionName } from "./target-use";

describe("target use", () => {
  it("keys a step by what it asks for, so a new request dims again", () => {
    const a = stepUseKey({ owner: "plugin:x", target: "tool:a.b", title: "Resistor", text: "Click it" });
    expect(stepUseKey({ owner: "plugin:x", target: "tool:a.b", title: "Resistor", text: "Click it" })).toBe(a);
    expect(stepUseKey({ owner: "plugin:x", target: "tool:a.b", title: "LEDs", text: "Click it again" })).not.toBe(a);
    expect(stepUseKey({ owner: "plugin:x", text: "No target" })).toBe("plugin:x|||No target");
  });

  it("maps tool targets to their action; other targets have none", () => {
    expect(targetActionName("tool:eeschema.InteractiveDrawing.placePowerSymbol")).toBe(
      "eeschema.InteractiveDrawing.placePowerSymbol",
    );
    expect(targetActionName("menu:Tools")).toBeNull();
    expect(targetActionName("dialog:DIALOG_SYMBOL_CHOOSER/control:searchctrl")).toBeNull();
    expect(targetActionName(undefined)).toBeNull();
  });

  it("counts the target's action (button or hotkey) as a use, nothing else", () => {
    const t = "tool:eeschema.InteractiveDrawingLineWireBus.drawWires";
    expect(isTargetAction({ type: "action", name: "eeschema.InteractiveDrawingLineWireBus.drawWires", depth: 0 }, t)).toBe(true);
    expect(isTargetAction({ type: "action", name: "eeschema.InteractiveDrawing.placeSymbol", depth: 0 }, t)).toBe(false);
    expect(isTargetAction({ type: "dialogShown", cls: "DIALOG_X", ptr: "1", title: "", modal: true }, t)).toBe(false);
    expect(isTargetAction({ type: "action", name: "x.y", depth: 0 }, "menu:Tools")).toBe(false);
  });

  it("hit-tests a click against the target box, edges included", () => {
    const r = { x: 10, y: 20, width: 30, height: 40 };
    expect(pointInRect(10, 20, r)).toBe(true);
    expect(pointInRect(40, 60, r)).toBe(true);
    expect(pointInRect(25, 40, r)).toBe(true);
    expect(pointInRect(9, 40, r)).toBe(false);
    expect(pointInRect(25, 61, r)).toBe(false);
  });

  it("counts a click on the drawing as work, not one on a toolbar or inside a dialog", () => {
    const gal = { x: 200, y: 60, width: 900, height: 600 };
    const dialog = { x: 400, y: 200, width: 300, height: 200 };
    expect(isCanvasWork(500, 100, gal, [dialog])).toBe(true); // on the sheet
    expect(isCanvasWork(500, 300, gal, [dialog])).toBe(false); // inside the open dialog
    expect(isCanvasWork(100, 100, gal, [dialog])).toBe(false); // left toolbar / panels
    expect(isCanvasWork(500, 30, gal, [])).toBe(false); // top toolbar
    expect(isCanvasWork(500, 100, null, [])).toBe(false); // no editor canvas yet
  });
});
