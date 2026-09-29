/**
 * Toolbar tool id → KiCad action name, from the engine's
 * `Module.kicadToolbarActions()` (overlay-system 0002 M2). Registry tool
 * entries carry `userId` = tool id and `parentId` = toolbar pointer; the
 * engine lists the same pair per action, so `${toolbar}:${toolId}` joins them.
 *
 * Cached; refreshed when a rendered tool shows up whose key the cache does
 * not know (a toolbar was rebuilt, another frame opened), at most once per
 * registry `renderedVersion`.
 */

export type ToolActionMap = Map<string, string>;

export const toolKey = (toolbar: string, toolId: number) => `${toolbar}:${toolId}`;

/** Parse the engine's JSON; malformed rows are skipped. */
export function parseToolActions(raw: string | null | undefined): ToolActionMap {
  const map: ToolActionMap = new Map();
  if (!raw) return map;
  let rows: unknown;
  try {
    rows = JSON.parse(raw);
  } catch {
    return map;
  }
  if (!Array.isArray(rows)) return map;
  for (const r of rows as { toolbar?: unknown; toolId?: unknown; action?: unknown }[]) {
    if (typeof r?.toolbar === "string" && typeof r.toolId === "number" && typeof r.action === "string") {
      map.set(toolKey(r.toolbar, r.toolId), r.action);
    }
  }
  return map;
}

/** The visible toolbar tool bound to `action`, first match. */
export function pickToolByAction(
  tools: WxRenderedElementInfo[],
  windows: Map<string, WxElementInfo> | undefined,
  actions: ToolActionMap,
  action: string,
): WxRenderedElementInfo | null {
  for (const t of tools) {
    if (t.userId === undefined || t.width <= 0 || t.height <= 0) continue;
    if (windows?.get(t.parentId)?.visible === false) continue;
    if (actions.get(toolKey(t.parentId, t.userId)) === action) return t;
  }
  return null;
}

let cache: ToolActionMap | null = null;
let refreshedAt = -1;

type ActionsSource = () => string | null | undefined;
const engineSource: ActionsSource = () => {
  const mod = (globalThis as { Module?: { kicadToolbarActions?: () => string } }).Module;
  return mod?.kicadToolbarActions?.();
};
let source: ActionsSource = engineSource;

/** The map, refreshed if `tools` holds a key it does not know. */
export function toolActionsFor(tools: WxRenderedElementInfo[], renderedVersion: number): ToolActionMap {
  const unknown = !cache || tools.some((t) => t.userId !== undefined && !cache!.has(toolKey(t.parentId, t.userId)));
  if (unknown && refreshedAt !== renderedVersion) {
    refreshedAt = renderedVersion;
    try {
      cache = parseToolActions(source());
    } catch {
      cache ??= new Map(); // engine busy — the next registry change retries
    }
  }
  return cache ?? new Map();
}

/** Tests: replace the engine read (null restores it) and drop the cache. */
export function __setToolActionsSourceForTests(fn: ActionsSource | null): void {
  source = fn ?? engineSource;
  cache = null;
  refreshedAt = -1;
}
