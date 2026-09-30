/**
 * Which plugin panel was open in this tab (overlay-system 0004 H2). Switching
 * between the schematic and PCB editors is a page navigation, which used to
 * lose the open plugin — and with it a guided tour that spans both editors.
 * The sidebar remembers the open plugin per tab and project, and reopens it on
 * the next page when the plugin is still installed, enabled and runs in that
 * editor; the plugin then resumes its own tour (`tour.start(def, {resume})`).
 */
import { BUILTIN, pluginKey, type Descriptor, type PluginView } from "./plugin-catalog";

const KEY = "pcbjam:plugin-panel";

type Store = Pick<Storage, "getItem" | "setItem" | "removeItem">;
export interface RememberedPanel {
  id: string;
  project: string | null;
}

function store(): Store | null {
  try {
    return typeof sessionStorage === "undefined" ? null : sessionStorage;
  } catch {
    return null; // blocked storage: nothing is remembered
  }
}

/** Record the current view: an open plugin is remembered, anything else forgets it. */
export function rememberPluginPanel(view: PluginView, project: string | null, s: Store | null = store()): void {
  try {
    if (view?.kind === "plugin") s?.setItem(KEY, JSON.stringify({ id: view.id, project }));
    else s?.removeItem(KEY);
  } catch {
    /* quota or blocked storage: the panel just is not reopened */
  }
}

export function readPluginPanel(s: Store | null = store()): RememberedPanel | null {
  try {
    const raw = s?.getItem(KEY);
    if (!raw) return null;
    const v = JSON.parse(raw) as Partial<RememberedPanel>;
    return typeof v.id === "string" && v.id ? { id: v.id, project: typeof v.project === "string" ? v.project : null } : null;
  } catch {
    return null;
  }
}

/** The view to reopen for `remembered` on this page, or null when it no longer fits. */
export function panelToReopen(
  remembered: RememberedPanel | null,
  plugins: readonly Descriptor[],
  tool: string,
  project: string | null,
): PluginView {
  if (!remembered || remembered.project !== project) return null;
  if (remembered.id === BUILTIN) return tool === "pcbnew" ? { kind: "plugin", id: BUILTIN } : null;
  const plugin = plugins.find((p) => pluginKey(p) === remembered.id);
  if (!plugin || plugin.enabled === false || !plugin.manifest.surfaces.includes("editor:" + tool)) return null;
  return { kind: "plugin", id: remembered.id };
}
