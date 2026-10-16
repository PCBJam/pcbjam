/** Where the AI panel is: tool calls on another file offer to open it. */
export interface PanelAt {
  scope: string;
  project: string;
  file: string;
}

/**
 * The project file a tool call worked on, when it is not the one open here. The path is the
 * model's: one that is absolute or climbs (`..`) would point the link at another project on
 * this site, so it gets none (ai-chat 0006 S11).
 */
export function otherFile(input: unknown, at: PanelAt): string | null {
  const i = input as { path?: unknown; file?: unknown; scope?: unknown; project?: unknown } | undefined;
  const file = typeof i?.path === 'string' ? i.path : typeof i?.file === 'string' ? i.file : null;
  // An empty scope would make the link `//projects/…`: another host.
  if (!at.scope || !at.project) return null;
  if (!file || file === at.file || (i?.scope !== undefined && i.scope !== at.scope) || (i?.project !== undefined && i.project !== at.project)) return null;
  if (file.startsWith('/') || file.includes('\\') || file.split('/').some((s) => s === '' || s === '.' || s === '..')) return null;
  return /\.(kicad_sch|kicad_pcb)$/.test(file) ? file : null;
}

/**
 * The editor URL of another file in this project (the agent never moves the person's view
 * itself), on this tab's working copy: of the query, only `copy` goes along.
 */
export function fileHref(at: PanelAt, file: string, search: string): string {
  const copy = new URLSearchParams(search).get('copy');
  const path = file.split('/').map(encodeURIComponent).join('/');
  return `/${encodeURIComponent(at.scope)}/projects/${encodeURIComponent(at.project)}/${path}${copy ? `?copy=${encodeURIComponent(copy)}` : ''}`;
}
