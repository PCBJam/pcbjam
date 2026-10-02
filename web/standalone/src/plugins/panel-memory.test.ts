import { describe, expect, it } from "vitest";
import { BUILTIN, type Descriptor } from "./plugin-catalog";
import { panelToReopen, readPluginPanel, rememberPluginPanel } from "./panel-memory";

function memoryStore() {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k), m };
}
/** One browser: `project` is shared by its tabs, `tab` is each tab's own. */
const browser = () => ({ tab: memoryStore(), project: memoryStore() });

const plugin = (id: string, surfaces: string[], over: Partial<Descriptor> = {}) =>
  ({ manifest: { id, name: id, surfaces }, ...over }) as unknown as Descriptor;

const TUTORIAL = plugin("usb-stick-tutorial", ["editor:eeschema", "editor:pcbnew"]);
const SCH_ONLY = plugin("sch-only", ["editor:eeschema"]);
const OPEN = { kind: "plugin", id: "usb-stick-tutorial" } as const;

describe("plugin panel memory", () => {
  it("remembers an open plugin per project and forgets it when the panel closes", () => {
    const s = browser();
    rememberPluginPanel(OPEN, "proj-1", { forgetProject: true }, s);
    expect(readPluginPanel("proj-1", s)).toEqual({ id: "usb-stick-tutorial", project: "proj-1" });
    expect(readPluginPanel("proj-2", s)).toBeNull();
    rememberPluginPanel({ kind: "manager" }, "proj-1", { forgetProject: true }, s);
    expect(readPluginPanel("proj-1", s)).toBeNull();
    rememberPluginPanel({ kind: "plugin", id: "x" }, null, { forgetProject: true }, s);
    rememberPluginPanel(null, null, { forgetProject: true }, s);
    expect(readPluginPanel(null, s)).toBeNull();
  });

  it("a new tab — or the next visit — reopens the panel last left open in the project", () => {
    const s = browser();
    rememberPluginPanel(OPEN, "proj-1", { forgetProject: true }, s);
    const later = { tab: memoryStore(), project: s.project }; // the tab closed; same browser
    expect(readPluginPanel("proj-1", later)).toEqual({ id: "usb-stick-tutorial", project: "proj-1" });
    // That page's first, empty view does not make the project forget it…
    rememberPluginPanel(null, "proj-1", { forgetProject: false }, later);
    expect(readPluginPanel("proj-1", { tab: memoryStore(), project: s.project })).toEqual({ id: "usb-stick-tutorial", project: "proj-1" });
    // …closing the panel does.
    rememberPluginPanel(null, "proj-1", { forgetProject: true }, later);
    expect(readPluginPanel("proj-1", { tab: memoryStore(), project: s.project })).toBeNull();
  });

  it("this tab's own panel wins over another tab's, in the same project only", () => {
    const s = browser();
    rememberPluginPanel({ kind: "plugin", id: "sch-only" }, "proj-1", { forgetProject: true }, s);
    const other = { tab: memoryStore(), project: s.project };
    rememberPluginPanel(OPEN, "proj-1", { forgetProject: true }, other);
    expect(readPluginPanel("proj-1", s)?.id).toBe("sch-only");
    expect(readPluginPanel("proj-1", other)?.id).toBe("usb-stick-tutorial");
    // This tab moved on to another project: that project's own memory counts there.
    expect(readPluginPanel("proj-2", s)).toBeNull();
  });

  it("ignores garbage and blocked storage", () => {
    const s = browser();
    s.tab.setItem("pcbjam:plugin-panel", "{not json");
    s.project.setItem("pcbjam:plugin-panel:proj-1", JSON.stringify({ id: 42 }));
    expect(readPluginPanel("proj-1", s)).toBeNull();
    const throwing = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); }, removeItem: () => { throw new Error("blocked"); } };
    const blocked = { tab: throwing, project: throwing };
    expect(readPluginPanel("proj-1", blocked)).toBeNull();
    expect(() => rememberPluginPanel({ kind: "plugin", id: "x" }, null, { forgetProject: true }, blocked)).not.toThrow();
    expect(readPluginPanel("proj-1", { tab: null, project: null })).toBeNull();
  });

  it("reopens only a plugin that is still installed, enabled and runs in this editor, in the same project", () => {
    const remembered = { id: "usb-stick-tutorial", project: "proj-1" };
    expect(panelToReopen(remembered, [TUTORIAL], "pcbnew", "proj-1")).toEqual({ kind: "plugin", id: "usb-stick-tutorial" });
    expect(panelToReopen(remembered, [TUTORIAL], "pcbnew", "proj-2")).toBeNull(); // another project
    expect(panelToReopen(remembered, [], "pcbnew", "proj-1")).toBeNull(); // uninstalled
    expect(panelToReopen(remembered, [plugin("usb-stick-tutorial", ["editor:pcbnew"], { enabled: false })], "pcbnew", "proj-1")).toBeNull();
    expect(panelToReopen({ id: "sch-only", project: "proj-1" }, [SCH_ONLY], "pcbnew", "proj-1")).toBeNull(); // not in this editor
    expect(panelToReopen(null, [TUTORIAL], "pcbnew", "proj-1")).toBeNull();
  });

  it("matches marketplace plugins by their server id, and the built-in inspector only in pcbnew", () => {
    const hosted = plugin("usb-stick-tutorial", ["editor:pcbnew"], { pluginId: "srv-7" });
    expect(panelToReopen({ id: "srv-7", project: null }, [hosted], "pcbnew", null)).toEqual({ kind: "plugin", id: "srv-7" });
    expect(panelToReopen({ id: "usb-stick-tutorial", project: null }, [hosted], "pcbnew", null)).toBeNull();
    expect(panelToReopen({ id: BUILTIN, project: null }, [], "pcbnew", null)).toEqual({ kind: "plugin", id: BUILTIN });
    expect(panelToReopen({ id: BUILTIN, project: null }, [], "eeschema", null)).toBeNull();
  });
});
