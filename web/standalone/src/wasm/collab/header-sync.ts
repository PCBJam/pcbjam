/**
 * Live board-header sync (proposal 21 WP4 — sync audit SYNC-06a, layer drift).
 *
 * Board-level state — (general …) (paper …) (title_block …) (layers …) (setup …)
 * (property …) (variants …) — lives in the doc LAYOUT, not in items, so the item
 * bridge never carries it. Before this it reached the room only on File→Save
 * (miss 08B) and never reached an open peer's native board.
 *
 *  - local → room: the C++ bridge re-checks the header on every OnModify and
 *    fires `kicadCollab.onHeader(text)` when it changed; this three-way merges it
 *    into the layout (`syncLayoutToY` restricted to the header heads, against the
 *    layout baseline the save path shares).
 *  - room → local: a REMOTE layout transaction that touched a header head renders
 *    the room's header and hands it to `kicadCollabApplyHeader` — unless it
 *    already matches the native header. While Board Setup is open the apply
 *    waits (its OK would commit the state it loaded over the peer's change).
 *
 * The layout baseline (what the editor last agreed on: the opened file, each
 * save, each header emit/apply) is owned here and shared with the save path
 * (`syncFromSave`), so a save never re-asserts a stale header.
 */
import {
  docToFile,
  EMBEDDED_FILES_ROOM_BUDGET,
  fileToDoc,
  SCH_ROOT_EMBEDDED_HEADS,
  syncLayoutToY,
  unquoteAtom,
  Y_KDOC_LAYOUT,
  type KicadDoc,
  type Slot,
  type SyncLayoutOptions,
} from "@pcbjam/shared";
import type * as Y from "yjs";
import { clog, cwarn } from "./debug";
import { notifyEmbeddedTooLarge } from "./sync-limits";

export const PCB_HEADER_HEADS: ReadonlySet<string> = new Set([
  "general",
  "paper",
  "title_block",
  "layers",
  "setup",
  "property",
  "variants",
]);

/** eeschema's per-sheet header (S3): page settings + title block. */
export const SCH_HEADER_HEADS: ReadonlySet<string> = new Set(["paper", "title_block"]);

export const HEADER_ORIGIN = "header-sync";

/** Transaction origin of the live embedded-fonts writes ({@link syncEmbeddedToY}). */
export const EMBEDDED_ORIGIN = "embedded-sync";

/** Where a document's layout baseline lives (one per room). */
export interface BaselineStore {
  get(): KicadDoc | undefined;
  set(d: KicadDoc): void;
}

const EMBEDDED_FILES_HEAD: ReadonlySet<string> = new Set(["embedded_files"]);
const EMBEDDED_FLAG_HEAD: ReadonlySet<string> = new Set(["embedded_fonts"]);

/**
 * Embedded files stay within EMBEDDED_FILES_ROOM_BUDGET in a room (fonts 0001): past it the
 * room keeps its files and the user is told. The caller's baseline must keep them too, so
 * that the files that fit sync once some are removed.
 */
function embeddedBudget(docPath: string, onOver: () => void): SyncLayoutOptions {
  return {
    embeddedFilesBudget: EMBEDDED_FILES_ROOM_BUDGET,
    onEmbeddedOverBudget: (bytes) => {
      onOver();
      cwarn(`[embedded] ${docPath}: ${bytes} bytes of embedded files are past the room budget, not synced`);
      notifyEmbeddedTooLarge({ docPath, bytes, budget: EMBEDDED_FILES_ROOM_BUDGET });
    },
  };
}

/**
 * The editor's embedded fonts, live (wasm/bindings/embedded_sync.h): the C++ flush embeds
 * the fonts texts use and hands over a document holding just (embedded_fonts …) and
 * (embedded_files …) when they changed. Merge those heads into the room against the
 * layout baseline (per file: a peer's embedded fonts stay), then advance the baseline for
 * them only. The other direction stays on open: a peer picks the fonts up when it next
 * loads the file.
 */
export function syncEmbeddedToY(doc: Y.Doc, text: string, store: BaselineStore, docPath: string): boolean {
  const embedded = fileToDoc(text);
  let over = false;
  const changed = syncLayoutToY(embedded, doc, EMBEDDED_ORIGIN, store.get(), {
    heads: SCH_ROOT_EMBEDDED_HEADS,
    ...embeddedBudget(docPath, () => (over = true)),
  });
  const heads = over ? EMBEDDED_FLAG_HEAD : SCH_ROOT_EMBEDDED_HEADS;
  const cur = store.get();
  if (cur) store.set(withHeads(cur, embedded, heads));
  else if (!over) store.set(embedded);
  return changed;
}

/**
 * A saved file's layout into the room (miss 08B) against the baseline, embedded files
 * within their budget. Returns whether the room changed and the baseline to keep: the file,
 * except for embedded files the room did not take.
 */
export function syncSaveToY(
  fileDoc: KicadDoc,
  doc: Y.Doc,
  baseline: KicadDoc | undefined,
  docPath: string,
): { changed: boolean; baseline: KicadDoc } {
  let over = false;
  const changed = syncLayoutToY(fileDoc, doc, "layout-save", baseline, embeddedBudget(docPath, () => (over = true)));
  const kept = over ? withHeads(fileDoc, baseline ?? { ...fileDoc, layout: [] }, EMBEDDED_FILES_HEAD) : fileDoc;
  return { changed, baseline: kept };
}

/** pcbnew's header exports (kicad_editor exposes both sets; each no-ops for the other frame). */
export interface HeaderModule {
  kicadCollabHeaderText?(): string;
  kicadCollabApplyHeader?(text: string): void;
  kicadCollabHeaderBlocked?(): boolean;
}

/** eeschema's header exports. */
export interface SchHeaderModule {
  kicadSchHeaderText?(): string;
  kicadSchApplyHeader?(text: string): void;
  kicadSchHeaderBlocked?(): boolean;
}

/** The native side of the header sync, whichever editor it is. */
export interface HeaderAdapter {
  text(): string;
  apply(text: string): void;
  /** The native payload for a header text (what `apply` sends; the resolver answers it). */
  encode(text: string): string;
  /** A settings dialog is open whose OK would overwrite an applied header. */
  blocked(): boolean;
}

export function pcbHeaderAdapter(mod: HeaderModule): HeaderAdapter | undefined {
  if (typeof mod.kicadCollabHeaderText !== "function" || typeof mod.kicadCollabApplyHeader !== "function") {
    return undefined;
  }
  return {
    text: () => mod.kicadCollabHeaderText!(),
    apply: (t) => mod.kicadCollabApplyHeader!(t),
    encode: (t) => t,
    blocked: () => mod.kicadCollabHeaderBlocked?.() ?? false,
  };
}

/**
 * A sheet header decoded for `kicadSchApplyHeader` (the schematic parser only
 * takes these heads in a full-file parse, so the native side uses the setters).
 */
export interface SchHeaderJson {
  paper?: { type: string; w?: number; h?: number; portrait?: boolean };
  title?: { title?: string; date?: string; rev?: string; company?: string; comments?: Array<[number, string]> };
}

export function decodeSchHeader(text: string): SchHeaderJson {
  const out: SchHeaderJson = {};
  const atoms = (v: Slot[]) => v.flatMap((s) => ("atom" in s ? [s.atom] : []));
  for (const slot of fileToDoc(text).layout) {
    if (!("k" in slot)) continue;
    if (slot.k === "paper") {
      const a = atoms(slot.v);
      const type = unquoteAtom(a[0] ?? '"A4"');
      out.paper = { type, portrait: a.includes("portrait") };
      if (type === "User" && a.length >= 3) {
        out.paper.w = Number(a[1]);
        out.paper.h = Number(a[2]);
      }
    } else if (slot.k === "title_block") {
      const t: NonNullable<SchHeaderJson["title"]> = {};
      for (const f of slot.v) {
        if (!("k" in f)) continue;
        const a = atoms(f.v);
        if (f.k === "comment" && a.length >= 2) {
          (t.comments ??= []).push([Number(a[0]), unquoteAtom(a[1]!)]);
        } else if (f.k === "title" || f.k === "date" || f.k === "rev" || f.k === "company") {
          t[f.k] = unquoteAtom(a[0] ?? '""');
        }
      }
      out.title = t;
    }
  }
  return out;
}

export function schHeaderAdapter(mod: SchHeaderModule): HeaderAdapter | undefined {
  if (typeof mod.kicadSchHeaderText !== "function" || typeof mod.kicadSchApplyHeader !== "function") {
    return undefined;
  }
  return {
    text: () => mod.kicadSchHeaderText!(),
    apply: (t) => mod.kicadSchApplyHeader!(JSON.stringify(decodeSchHeader(t))),
    encode: (t) => JSON.stringify(decodeSchHeader(t)),
    blocked: () => mod.kicadSchHeaderBlocked?.() ?? false,
  };
}

export interface HeaderWindow {
  kicadCollab?: {
    onHeader?: (text: string) => void;
    /** Apply-time resolution: the room's latest header payload, "" = nothing to apply. */
    resolveHeader?: () => string;
    /** The live embedded fonts of the document saved at `absPath` ({@link syncEmbeddedToY}). */
    onEmbedded?: (absPath: string, text: string) => void;
  };
}

export interface LayoutSync {
  /** Reconcile a just-saved file's layout (all heads) against the shared baseline. */
  /** `docPath` names the document in notices (embedded files past their budget). */
  syncFromSave(fileDoc: KicadDoc, docPath: string): boolean;
  /** The layout the editor last agreed on (tests/inspection). */
  baseline(): KicadDoc | undefined;
  destroy(): void;
}

/** `base` with the given heads' slot groups replaced by `from`'s (other heads untouched). */
export function withHeads(base: KicadDoc, from: KicadDoc, heads: ReadonlySet<string>): KicadDoc {
  const pick = (s: Slot) => "k" in s && heads.has(s.k);
  const incoming = from.layout.filter(pick);
  const layout: Slot[] = [];
  let placed = false;
  for (const s of base.layout) {
    if (pick(s)) {
      if (!placed) {
        layout.push(...incoming);
        placed = true;
      }
      continue;
    }
    layout.push(s);
  }
  if (!placed) {
    const firstItem = layout.findIndex((s) => "item" in s);
    layout.splice(firstItem < 0 ? layout.length : firstItem, 0, ...incoming);
  }
  return { ...base, layout };
}

const headerSlots = (layout: readonly Slot[], heads: ReadonlySet<string>): Slot[] =>
  layout.filter((s) => "k" in s && heads.has(s.k));

/**
 * Start the shared layout baseline + (when the module speaks it) the live header
 * sync for one single-room document. `baseline` is the layout the editor opened.
 */
export function startLayoutSync(opts: {
  doc: Y.Doc;
  win: HeaderWindow;
  /** The editor's header exports; absent ⇒ save-time sync only (no live header). */
  header?: HeaderAdapter;
  /** Initial baseline (the opened file) — ignored when `store` is given. */
  baseline?: KicadDoc;
  /** External baseline storage (the sheet pool keeps one per room). */
  store?: BaselineStore;
  readOnly?: boolean;
  heads?: ReadonlySet<string>;
  root?: string;
  /**
   * Take the editor's live embedded fonts into this doc (`kicadCollab.onEmbedded`). For a
   * single-room document; the sheet pool routes a schematic's to its root sheet's room.
   */
  embedded?: boolean;
}): LayoutSync {
  const { doc, win } = opts;
  const heads = opts.heads ?? PCB_HEADER_HEADS;
  const root = opts.root ?? "kicad_pcb";
  let own = opts.baseline;
  const store = opts.store ?? { get: () => own, set: (d: KicadDoc) => void (own = d) };
  let destroyed = false;
  const header = opts.readOnly ? undefined : opts.header;
  const live = header !== undefined;

  const advance = (fileDoc: KicadDoc, only?: ReadonlySet<string>): void => {
    const cur = store.get();
    store.set(cur && only ? withHeads(cur, fileDoc, only) : fileDoc);
  };

  // ── local → room ──────────────────────────────────────────────────────────
  const onHeader = (text: string): void => {
    if (destroyed) return;
    try {
      const headerDoc = fileToDoc(text);
      if (syncLayoutToY(headerDoc, doc, HEADER_ORIGIN, store.get(), { heads })) {
        clog("[header] local header change → room");
      }
      advance(headerDoc, heads);
    } catch (err) {
      cwarn("[header] local header sync failed", err);
    }
  };

  // ── room → local ──────────────────────────────────────────────────────────
  const layout = doc.getArray<Slot>(Y_KDOC_LAYOUT);
  let pending = false;
  let retry: ReturnType<typeof setTimeout> | undefined;

  const roomHeaderText = (): { text: string; doc: KicadDoc } | null => {
    const slots = layout.toArray();
    const version = slots.find((s) => "k" in s && s.k === "version");
    const header = headerSlots(slots, heads);
    if (!version || header.length === 0) return null;
    const d: KicadDoc = { root, items: {}, layout: [version, ...header] };
    return { text: docToFile(d), doc: d };
  };

  const applyRemote = (): void => {
    pending = false;
    if (destroyed) return;
    if (header!.blocked()) {
      // Board Setup is open: re-check once it closes (a local, per-tab timer —
      // nothing reaches the server).
      pending = true;
      retry ??= setTimeout(() => {
        retry = undefined;
        if (pending) applyRemote();
      }, 1000);
      return;
    }
    try {
      const room = roomHeaderText();
      if (!room) return;
      const native = fileToDoc(header!.text());
      if (
        JSON.stringify(headerSlots(native.layout, heads)) ===
        JSON.stringify(headerSlots(room.doc.layout, heads))
      ) {
        return;
      }
      clog("[header] remote header change → editor");
      // The native side resolves again at execution time (resolveHeader) and
      // the baseline advances there — to exactly what it applies.
      header!.apply(room.text);
    } catch (err) {
      cwarn("[header] remote header apply failed", err);
    }
  };

  const onLayout = (ev: Y.YArrayEvent<Slot>, txn: Y.Transaction): void => {
    if (txn.local || destroyed) return;
    const touched = [...ev.changes.added, ...ev.changes.deleted].some((item) =>
      item.content.getContent().some((s: unknown) => {
        const slot = s as Slot;
        return slot && typeof slot === "object" && "k" in slot && heads.has(slot.k);
      }),
    );
    if (!touched || pending) return;
    pending = true;
    queueMicrotask(applyRemote);
  };

  // Apply-time resolution: the native side flushed its pending local header
  // (merged into the room above) and asks for the room's LATEST header.
  const resolveHeader = (): string => {
    if (destroyed) return "";
    try {
      const room = roomHeaderText();
      if (!room) return "";
      advance(room.doc, heads);
      return header!.encode(room.text);
    } catch (err) {
      cwarn("[header] resolve failed", err);
      return "";
    }
  };

  if (live) {
    win.kicadCollab = { ...win.kicadCollab, onHeader, resolveHeader };
    layout.observe(onLayout);
  }

  const onEmbedded = (absPath: string, text: string): void => {
    if (destroyed) return;
    try {
      if (syncEmbeddedToY(doc, text, store, absPath)) clog("[embedded] local embedded fonts → room");
    } catch (err) {
      cwarn("[embedded] local embedded fonts sync failed", err);
    }
  };
  const embedded = !opts.readOnly && !!opts.embedded;
  if (embedded) win.kicadCollab = { ...win.kicadCollab, onEmbedded };

  return {
    syncFromSave(fileDoc, docPath) {
      const { changed, baseline } = syncSaveToY(fileDoc, doc, store.get(), docPath);
      advance(baseline);
      return changed;
    },
    baseline: () => store.get(),
    destroy() {
      destroyed = true;
      if (retry) clearTimeout(retry);
      if (live) {
        layout.unobserve(onLayout);
        if (win.kicadCollab?.onHeader === onHeader) {
          win.kicadCollab = { ...win.kicadCollab, onHeader: undefined, resolveHeader: undefined };
        }
      }
      if (embedded && win.kicadCollab?.onEmbedded === onEmbedded) {
        win.kicadCollab = { ...win.kicadCollab, onEmbedded: undefined };
      }
    },
  };
}
