/**
 * The engine's `pcbjam:editor-event` window CustomEvents (kicad
 * pcbjam_editor_events.h, overlay-system 0002 M2), as ONE listener with a
 * typed fan-out. Also remembers which KiCad dialogs are open, so a
 * `dialog:<CLASS>` target can find the dialog's window.
 */

export type EditorEvent =
  | { type: "action"; name: string; depth: number }
  /** `modal`: a nested event loop runs the dialog (ShowModal / ShowQuasiModal / a modal frame);
   *  false for modeless ones (ERC, DRC, Find). Engines before overlay-system 0005 do not say:
   *  taken as modal. */
  | { type: "dialogShown"; cls: string; ptr: string; title: string; modal: boolean }
  | { type: "dialogClosed"; cls: string; ptr: string; title: string }
  /** ERC / DRC finished in its dialog, with the counts it shows (overlay-system 0005). */
  | { type: "checkFinished"; kind: "erc" | "drc"; errors: number; warnings: number; unconnected: number };

export type EditorEventType = EditorEvent["type"];

export const EDITOR_EVENT = "pcbjam:editor-event";

const listeners = new Set<(e: EditorEvent) => void>();
/** Open dialogs by class, most recently shown last (a class can be open twice). */
const openDialogs = new Map<string, { ptr: string; title: string; modal: boolean }[]>();
let installedOn: EventTarget | null = null;

/** Validate an untrusted `detail`; null when it is not an editor event. */
export function parseEditorEvent(detail: unknown): EditorEvent | null {
  if (!detail || typeof detail !== "object") return null;
  const d = detail as Record<string, unknown>;
  if (d.type === "action" && typeof d.name === "string" && d.name) {
    return { type: "action", name: d.name, depth: typeof d.depth === "number" ? d.depth : 0 };
  }
  if ((d.type === "dialogShown" || d.type === "dialogClosed") && typeof d.cls === "string" && typeof d.ptr === "string") {
    const title = typeof d.title === "string" ? d.title : "";
    if (d.type === "dialogClosed") return { type: d.type, cls: d.cls, ptr: d.ptr, title };
    return { type: d.type, cls: d.cls, ptr: d.ptr, title, modal: d.modal !== false };
  }
  if (d.type === "checkFinished" && (d.kind === "erc" || d.kind === "drc")) {
    const n = (v: unknown) => (typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : null);
    const errors = n(d.errors);
    const warnings = n(d.warnings);
    if (errors === null || warnings === null) return null;
    return { type: "checkFinished", kind: d.kind, errors, warnings, unconnected: n(d.unconnected) ?? 0 };
  }
  return null;
}

function track(e: EditorEvent): void {
  if (e.type !== "dialogShown" && e.type !== "dialogClosed") return;
  const list = (openDialogs.get(e.cls) ?? []).filter((d) => d.ptr !== e.ptr);
  if (e.type === "dialogShown") list.push({ ptr: e.ptr, title: e.title, modal: e.modal });
  if (list.length) openDialogs.set(e.cls, list);
  else openDialogs.delete(e.cls);
}

function onEvent(ev: Event): void {
  const e = parseEditorEvent((ev as CustomEvent).detail);
  if (!e) return;
  track(e);
  for (const cb of listeners) {
    try {
      cb(e);
    } catch (err) {
      console.error("[editor-events] listener failed:", err);
    }
  }
}

/** Start listening (idempotent). Returns the disposer. */
export function installEditorEvents(target: EventTarget = window): () => void {
  if (installedOn === target) return () => uninstall(target);
  if (installedOn) uninstall(installedOn);
  target.addEventListener(EDITOR_EVENT, onEvent);
  installedOn = target;
  return () => uninstall(target);
}

function uninstall(target: EventTarget): void {
  if (installedOn !== target) return;
  target.removeEventListener(EDITOR_EVENT, onEvent);
  installedOn = null;
  openDialogs.clear();
}

export function onEditorEvent(cb: (e: EditorEvent) => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/** True while any KiCad dialog is open, modal or not. */
export function anyDialogOpen(): boolean {
  return openDialogs.size > 0;
}

/** True while a modal KiCad dialog is open: its nested event loop runs, so the page must not
 *  read the engine. A modeless one (ERC, DRC) leaves the editor as it is. */
export function anyModalDialogOpen(): boolean {
  return [...openDialogs.values()].some((list) => list.some((d) => d.modal));
}

/** Every open KiCad dialog (window pointer as the registry id). */
export function openDialogPtrs(): string[] {
  return [...openDialogs.values()].flatMap((list) => list.map((d) => d.ptr));
}

/** The most recently shown open dialog of this class. */
export function openDialog(cls: string): { ptr: string; title: string; modal: boolean } | null {
  const list = openDialogs.get(cls);
  return list?.[list.length - 1] ?? null;
}

/** Tests. */
export function __resetEditorEventsForTests(): void {
  if (installedOn) uninstall(installedOn);
  listeners.clear();
  openDialogs.clear();
}
