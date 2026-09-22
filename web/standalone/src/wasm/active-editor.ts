import type { LibsSource } from "./libs/source";

/**
 * The one running editor's handles, for callers outside the React tree (the
 * remote-provider part save). The libs source here is THE instance the boot
 * effect created — `libsSourceConfig()` would build a second one with its own
 * SyncStacks and IndexedDB handles, which must not happen. Set by WasmTool's
 * boot effect, cleared on teardown.
 */
export interface ActiveEditor {
  source: LibsSource | null;
  /** "eeschema" | "pcbnew" | … */
  tool: string;
  /** The scope SLUG (URL segment), which the lib routes are addressed by. */
  scope: string;
  projectId: string;
}

let active: ActiveEditor | null = null;

export function setActiveEditor(editor: ActiveEditor | null): void {
  active = editor;
}

export function getActiveEditor(): ActiveEditor | null {
  return active;
}
