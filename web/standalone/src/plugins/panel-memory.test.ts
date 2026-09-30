import { describe, expect, it } from "vitest";
import { BUILTIN, type Descriptor } from "./plugin-catalog";
import { panelToReopen, readPluginPanel, rememberPluginPanel } from "./panel-memory";

function memoryStore() {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k), m };
}

const plugin = (id: string, surfaces: string[], over: Partial<Descriptor> = {}) =>
  ({ manifest: { id, name: id, surfaces }, ...over }) as unknown as Descriptor;

const TUTORIAL = plugin("usb-stick-tutorial", ["editor:eeschema", "editor:pcbnew"]);
const SCH_ONLY = plugin("sch-only", ["editor:eeschema"]);

describe("plugin panel memory", () => {
  it("remembers an open plugin per project and forgets it when the panel closes", () => {
    const s = memoryStore();
    rememberPluginPanel({ kind: "plugin", id: "usb-stick-tutorial" }, "proj-1", s);
    expect(readPluginPanel(s)).toEqual({ id: "usb-stick-tutorial", project: "proj-1" });
    rememberPluginPanel({ kind: "manager" }, "proj-1", s);
    expect(readPluginPanel(s)).toBeNull();
    rememberPluginPanel({ kind: "plugin", id: "x" }, null, s);
    rememberPluginPanel(null, null, s);
    expect(readPluginPanel(s)).toBeNull();
  });

  it("ignores garbage and blocked storage", () => {
    const s = memoryStore();
    s.setItem("pcbjam:plugin-panel", "{not json");
    expect(readPluginPanel(s)).toBeNull();
    s.setItem("pcbjam:plugin-panel", JSON.stringify({ id: 42 }));
    expect(readPluginPanel(s)).toBeNull();
    const throwing = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); }, removeItem: () => { throw new Error("blocked"); } };
    expect(readPluginPanel(throwing)).toBeNull();
    expect(() => rememberPluginPanel({ kind: "plugin", id: "x" }, null, throwing)).not.toThrow();
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
