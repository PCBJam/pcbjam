/**
 * Which plugin panel was open (overlay-system 0004 H2; tutorial round 2). Switching between the
 * schematic and PCB editors is a page navigation, which used to lose the open plugin — and with
 * it a guided tour that spans both editors; closing the tab lost it too. The sidebar remembers
 * the open plugin per tab, and per project in this browser, and reopens it on the next page —
 * after an editor switch, a reload, or the next visit to the project — when the plugin is still
 * installed, enabled and runs in that editor; the plugin then resumes its own tour
 * (`tour.start(def, {resume})`).
 */
import { BUILTIN, pluginKey, type Descriptor, type PluginView } from "./plugin-catalog";

/** This tab's open panel. */
const TAB_KEY = "pcbjam:plugin-panel";
/** The panel last left open in a project, in any tab. */
const projectKey = (project: string | null) => `pcbjam:plugin-panel:${project ?? "-"}`;

type Store = Pick<Storage, "getItem" | "setItem" | "removeItem">;
export interface PanelStores {
  tab: Store | null;
  project: Store | null;
}
export interface RememberedPanel {
  id: string;
  project: string | null;
}

function browserStores(): PanelStores {
  const pick = (get: () => Storage | undefined): Store | null => {
    try {
      return get() ?? null;
    } catch {
      return null; // blocked storage: nothing is remembered
    }
  };
  return {
    tab: pick(() => (typeof sessionStorage === "undefined" ? undefined : sessionStorage)),
    project: pick(() => (typeof localStorage === "undefined" ? undefined : localStorage)),
  };
}

function write(store: Store | null, key: string, value: string | null): void {
  try {
    if (value === null) store?.removeItem(key);
    else store?.setItem(key, value);
  } catch {
    /* quota or blocked storage: the panel just is not reopened */
  }
}

function read(store: Store | null, key: string): Record<string, unknown> | null {
  try {
    const raw = store?.getItem(key);
    const v = raw ? (JSON.parse(raw) as unknown) : null;
    return v && typeof v === "object" && typeof (v as { id?: unknown }).id === "string" && (v as { id: string }).id
      ? (v as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/**
 * Record the current view: an open plugin is remembered, anything else forgets it. `forgetProject`
 * false leaves the project's memory alone when nothing is open — the page's first, empty view only
 * means the panel has not reopened YET (another tab, or this one before the catalog loads).
 */
export function rememberPluginPanel(
  view: PluginView,
  project: string | null,
  opts: { forgetProject: boolean },
  s: PanelStores = browserStores(),
): void {
  const open = view?.kind === "plugin";
  write(s.tab, TAB_KEY, open ? JSON.stringify({ id: view.id, project }) : null);
  if (open) write(s.project, projectKey(project), JSON.stringify({ id: view.id }));
  else if (opts.forgetProject) write(s.project, projectKey(project), null);
}

/** The panel to reopen in `project`: this tab's, else the one last left open in the project. */
export function readPluginPanel(project: string | null, s: PanelStores = browserStores()): RememberedPanel | null {
  const tab = read(s.tab, TAB_KEY);
  if (tab && (typeof tab.project === "string" ? tab.project : null) === project) return { id: tab.id as string, project };
  const last = read(s.project, projectKey(project));
  return last ? { id: last.id as string, project } : null;
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
