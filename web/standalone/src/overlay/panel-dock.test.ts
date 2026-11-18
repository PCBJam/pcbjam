import { beforeEach, describe, expect, it } from "vitest";
import { DOCK_DEFAULT_W, DOCK_MIN_W, panelDock } from "./panel-dock";

const unmounts: Array<() => void> = [];
const mount = (id: string) => unmounts.push(panelDock.mount(id));

beforeEach(() => {
  for (const id of [...panelDock.get().left.tabs, ...panelDock.get().right.tabs]) panelDock.undock(id);
  while (unmounts.length) unmounts.pop()!();
  // The store reads only the window's width (and localStorage, which it may lack).
  (globalThis as { window?: unknown }).window = { innerWidth: 1400 };
});

describe("panelDock", () => {
  it("takes room on a side only while a docked panel is on screen", () => {
    panelDock.dock("chat", "right", "PCBJam AI");
    expect(panelDock.width("right")).toBe(0);
    mount("chat");
    expect(panelDock.width("right")).toBe(DOCK_DEFAULT_W);
    expect(panelDock.width("left")).toBe(0);
  });

  it("puts panels docked to the same side in tabs, the newest in front, and moves one between sides", () => {
    mount("chat");
    mount("comments");
    panelDock.dock("chat", "right", "PCBJam AI");
    panelDock.dock("comments", "right", "Comments");
    expect(panelDock.tabs("right")).toMatchObject({ ids: ["chat", "comments"], active: "comments" });
    panelDock.activate("right", "chat");
    expect(panelDock.tabs("right").active).toBe("chat");
    panelDock.dock("comments", "left", "Comments");
    expect(panelDock.tabs("right").ids).toEqual(["chat"]);
    expect(panelDock.sideOf("comments")).toBe("left");
  });

  it("brings the next tab to the front when the front one floats", () => {
    mount("a");
    mount("b");
    panelDock.dock("a", "left", "A");
    panelDock.dock("b", "left", "B");
    panelDock.undock("b");
    expect(panelDock.sideOf("b")).toBeNull();
    expect(panelDock.tabs("left")).toMatchObject({ ids: ["a"], active: "a" });
  });

  it("keeps a side between its minimum and half the window", () => {
    mount("chat");
    panelDock.dock("chat", "right", "PCBJam AI");
    panelDock.setWidth("right", 100);
    expect(panelDock.width("right")).toBe(DOCK_MIN_W);
    panelDock.setWidth("right", 5000);
    expect(panelDock.width("right")).toBe(700);
  });
});
