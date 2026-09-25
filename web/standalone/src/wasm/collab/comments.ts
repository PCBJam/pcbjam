import type * as Y from "yjs";
import {
  addMessage,
  args,
  colorForUser,
  commentAuthorColors,
  COMMENTS_DOC_PATH,
  createThread,
  deleteThread,
  editMessage,
  field,
  kicadItemsMap,
  listThreads,
  markThreadSeen,
  observeComments,
  removeMessage,
  resolveAnchor,
  setThreadAnchor,
  setThreadResolved,
  threadUnreadCount,
  toggleReaction,
  yToItemUnchecked,
  projectCommentOpsUrl,
  commentReportUrl,
  type CommentAnchor,
  type CommentReportReason,
  type CommentOp,
  type CommentThread,
  type ThreadFilter,
} from "@pcbjam/shared";
import { clog } from "./debug";
import { currentCopyRef, withCopyParam } from "@/lib/copy-context";
import { dirtyAtWrite, markEditedInSession } from "@/lib/git-provenance";

/**
 * Comments controller (collab-presence 0005): glues the MIT `kdoc_comments`
 * helpers (0004) to the editor —
 *   - resolves every thread's anchor to a world position (tracking anchored
 *     items through `kdoc_items` changes),
 *   - feeds the GAL pin dots (`Module.kicadCollabSetPins`, throttled snapshot,
 *     same idempotent contract as the presence overlay),
 *   - exposes the threads + CRUD to the React layer (CommentLayer).
 *
 * git-integration 0001 (design-comments §5/§6.1): threads live in the PROJECT
 * comments document (`doc`), shared by every editor session of the project;
 * the ITEMS the pins track live in the bound file/sheet doc (`itemsDoc`).
 * The controller filters the project doc by the bound document (`filePath`
 * + optional `sheetPath`) and is rebound with `setDocument` on an eeschema
 * sheet switch instead of being recreated — one controller per SESSION.
 * Detached pins (item gone) leave the canvas unless `setDetachedPinsVisible`.
 */

/** File-mm → editor-IU factor per tool (anchors store IU; item slots store mm). */
export const IU_PER_MM: Record<string, number> = {
  pcbnew: 1e6,
  eeschema: 1e4,
};

export interface CommentPinsModule {
  kicadCollabSetPins(json: string): void;
  kicadCollabSetViewport(cx: number, cy: number): void;
  kicadCollabGetViewport(): string;
}

/** True when the loaded wasm exposes the comment-pin bridge (0005 exports). */
export function hasCommentsBridge(mod: unknown): mod is CommentPinsModule {
  const m = mod as Partial<CommentPinsModule> | undefined;
  return (
    typeof m?.kicadCollabSetPins === "function" &&
    typeof m?.kicadCollabSetViewport === "function"
  );
}

/** The GAL viewport transform (see presence-kicad ViewportState). */
export interface ViewportState {
  cx: number;
  cy: number;
  scale: number; // px per IU (canvas device px)
  w: number;
  h: number;
}

/** World IU → canvas px (the GAL panel's own pixel space). */
export function worldToScreen(vp: ViewportState, p: { x: number; y: number }) {
  return {
    x: (p.x - vp.cx) * vp.scale + vp.w / 2,
    y: (p.y - vp.cy) * vp.scale + vp.h / 2,
  };
}

/** Canvas px → world IU. */
export function screenToWorld(vp: ViewportState, p: { x: number; y: number }) {
  return {
    x: (p.x - vp.w / 2) / vp.scale + vp.cx,
    y: (p.y - vp.h / 2) / vp.scale + vp.cy,
  };
}

/** A thread with its anchor resolved to the current world position. */
export interface ResolvedThread extends CommentThread {
  world: { x: number; y: number };
  /** The anchor item is gone from the bound document (design-comments §6.1
   *  "detached"); `absent` never arises inside one session — a thread on
   *  another file is simply not listed. */
  detached: boolean;
  state: "anchored" | "detached";
}

/**
 * How this session writes comments (comments-ux 0003 §4.5):
 *   - "write"   — editors: straight into the ydoc (also `@local`/demo);
 *   - "comment" — commenters: one REST comment op per action, the server
 *                 stamps the author and the room applies it; the write
 *                 comes back over the read-only socket as a normal update;
 *   - "read"    — readers: pins + panel render, every mutator is a no-op.
 */
export type CommentsMode = "write" | "comment" | "read";

export interface CommentsController {
  /** The session's comment capability — the UI gates its affordances on it. */
  mode(): CommentsMode;
  /** May the current user edit/delete this message? (own, and not a reader) */
  canEditMessage(thread: CommentThread, messageId: string): boolean;
  /** May the current user resolve / re-anchor / delete this thread? */
  canManageThread(thread: CommentThread): boolean;
  /** Errors from the REST path (rejected / throttled ops). */
  subscribeErrors(cb: (message: string, status: number) => void): () => void;
  /** Report a comment to the admins (comments-ux 0003 §6.1); any session with a backend. */
  report(threadId: string, messageId: string, reason: CommentReportReason, note?: string): Promise<boolean>;
  threads(): ResolvedThread[];
  subscribe(cb: (threads: ResolvedThread[]) => void): () => void;
  /** Build an anchor for a world-pos click: nearest positioned item within
   *  `maxDistIu` becomes the tracked anchor (+offset), else pos-only. */
  anchorAt(world: { x: number; y: number }, maxDistIu: number): CommentAnchor;
  create(anchor: CommentAnchor, body: string, mentions?: string[]): string;
  reply(threadId: string, body: string, mentions?: string[]): void;
  /** Advance the bound user's seen watermark on a thread (0001 C) — pins and
   *  badges refresh through the normal observe → subscribe cycle. */
  markSeen(threadId: string): void;
  /** Toggle the bound user's emoji reaction on a message (0001 D). */
  toggleReaction(threadId: string, messageId: string, emoji: string): void;
  edit(threadId: string, messageId: string, body: string): boolean;
  remove(threadId: string, messageId: string): "removed" | "thread-deleted" | false;
  setResolved(threadId: string, resolved: boolean): void;
  deleteThread(threadId: string): void;
  /** Re-pin a thread (drag): LWW anchor replace, live-syncs to peers. */
  moveThread(threadId: string, anchor: CommentAnchor): void;
  /** Globally show/hide the pins (GAL dots follow; DOM targets are the
   *  layer's own state). */
  setPinsVisible(visible: boolean): void;
  pinsVisible(): boolean;
  /** Draw detached pins at their stored position (default off, C-N4). */
  setDetachedPinsVisible(visible: boolean): void;
  detachedPinsVisible(): boolean;
  /** The bound document (thread filter) — `undefined` in legacy single-doc mode. */
  document(): ThreadFilter | undefined;
  /** Rebind the items doc + filter (eeschema sheet switch) without losing the
   *  project doc, subscribers or the UI state. Notifies `subscribeDocument`. */
  setDocument(itemsDoc: Y.Doc, filePath: string, sheetPath?: string): void;
  subscribeDocument(cb: (filter: ThreadFilter | undefined) => void): () => void;
  /** Presence-aware author color (nth-in-room when online, hash fallback). */
  colorFor(userId: string): string;
  /** Pan the editor to a thread's pin (comment panel "jump to"). */
  jumpTo(threadId: string): void;
  destroy(): void;
}

const PUSH_THROTTLE_MS = 30;

export function createComments(opts: {
  /** The PROJECT comments document (threads). */
  doc: Y.Doc;
  /** The bound file/sheet doc holding `kdoc_items` (anchors resolve against
   *  it). Defaults to `doc` — the legacy single-doc shape (@local without a
   *  project room, unit tests). */
  itemsDoc?: Y.Doc;
  /** The bound document, as the thread filter; omit for "every thread" (legacy). */
  filePath?: string;
  sheetPath?: string;
  mod: CommentPinsModule;
  /**
   * Author for new messages. `id` is the slug (identity key); `name`/`email`
   * are denormalized onto each message at write time so a comment still shows
   * a real author when they are offline, renamed, or gone (comments-wire.ts).
   */
  user: { id: string; name?: string; email?: string };
  tool: string;
  /** Presence color resolver (nth-in-room); undefined falls back to the hash. */
  colorFor?: (userId: string) => string | undefined;
  /** Comment capability (default "write"). */
  mode?: CommentsMode;
  /** REST target for "comment" mode: the backend origin + the project's
   *  address (`docPath` is informational — ops and reports go to the project
   *  comments document since git-integration 0001). */
  rest?: { apiBase: string; scope: string; project: string; docPath: string };
}): CommentsController {
  const { doc, mod, user } = opts;
  let itemsDoc: Y.Doc = opts.itemsDoc ?? doc;
  let filter: ThreadFilter | undefined = opts.filePath
    ? { filePath: opts.filePath, ...(opts.sheetPath ? { sheetPath: opts.sheetPath } : {}) }
    : undefined;
  const mode: CommentsMode = opts.mode ?? "write";
  const errorSubscribers = new Set<(message: string, status: number) => void>();
  const fail = (message: string, status: number) => {
    for (const cb of errorSubscribers) cb(message, status);
  };
  const genId = () =>
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `c-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  // "comment" mode: post the op; the echo (or a rejection) follows. Errors are
  // surfaced through subscribeErrors — the UI shows them, never the console.
  const post = (op: CommentOp): void => {
    const r = opts.rest;
    if (!r) {
      fail("comments unavailable (no backend)", 0);
      return;
    }
    void fetch(withCopyParam(`${r.apiBase}${projectCommentOpsUrl(r.scope, r.project)}`), {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ op }),
    })
      .then(async (res) => {
        if (res.ok) return;
        const body = (await res.json().catch(() => null)) as { message?: string } | null;
        fail(body?.message ?? `comment failed (${res.status})`, res.status);
      })
      .catch((e: unknown) => fail(e instanceof Error ? e.message : String(e), 0));
  };
  const threadOf = (threadId: string): CommentThread | undefined =>
    listThreads(doc, filter).find((t) => t.id === threadId);
  /**
   * Where a new thread is written (design-comments C-D3, git-integration
   * 0004): the working copy and its document generation this session is
   * bound to. Absent on copy-less backends (@local, the example backend).
   */
  const provenance = () => {
    const ref = currentCopyRef();
    // git-integration 0005: a connected copy also records the commit its
    // content is based on ("introduced at <sha>").
    if (!ref) return undefined;
    // git-integration 0006 (design-comments C-N2): the anchor may sit on
    // uncommitted work — the file has changes in this copy or was edited here.
    const dirty = ref.headCommit ? dirtyAtWrite(filter?.filePath) : undefined;
    return {
      workingCopyId: ref.id,
      docGeneration: ref.generation,
      ...(ref.headCommit ? { headCommit: ref.headCommit } : {}),
      ...(dirty !== undefined ? { dirtyAtWrite: dirty } : {}),
    };
  };
  /** Stamp the bound document onto an anchor (create / move / anchorAt). */
  const stampDoc = (anchor: CommentAnchor): CommentAnchor =>
    filter
      ? {
          ...anchor,
          filePath: anchor.filePath ?? filter.filePath,
          ...(filter.sheetPath && anchor.sheetPath === undefined ? { sheetPath: filter.sheetPath } : {}),
        }
      : anchor;
  const canEditMessage = (thread: CommentThread, messageId: string): boolean => {
    if (mode === "read") return false;
    const msg = thread.messages.find((m) => m.id === messageId);
    // Tombstones (moderation) are inert for everyone in the editor.
    if (msg?.moderation) return false;
    if (mode === "write") return true;
    return msg?.author === user.id;
  };
  const canManageThread = (thread: CommentThread): boolean => {
    if (mode === "read") return false;
    if (mode === "write") return true;
    return thread.createdBy === user.id;
  };
  const iuPerMm = IU_PER_MM[opts.tool] ?? 1e6;
  // Fallback chain: live presence (nth-in-room) → the doc's comment-author
  // slot (0009 C — presence-less binds still color deterministically) → hash.
  const colorFor = (userId: string) =>
    opts.colorFor?.(userId) ??
    commentAuthorColors(doc).get(userId) ??
    colorForUser(userId);

  let cache: ResolvedThread[] = [];
  let visible = true;
  let detachedVisible = false;
  const subscribers = new Set<(threads: ResolvedThread[]) => void>();
  const docSubscribers = new Set<(filter: ThreadFilter | undefined) => void>();

  const recompute = (): ResolvedThread[] => {
    cache = listThreads(doc, filter).map((t) => {
      const { x, y, detached } = resolveAnchor(itemsDoc, t.anchor, iuPerMm);
      return { ...t, world: { x, y }, detached, state: detached ? "detached" : "anchored" };
    });
    return cache;
  };

  const pushPins = () => {
    mod.kicadCollabSetPins(
      JSON.stringify({
        // Resolved threads drop their dot (figma-style) — they stay reachable
        // through the panel's "resolved" filter. Matches the DOM hit targets.
        // A global hide (toolbar eye) empties the set entirely.
        pins: !visible
          ? []
          : cache
              // Findings W-1: never hand the wasm a non-finite coordinate
              // (JSON null → nlohmann type_error across embind).
              .filter(
                (t) =>
                  !t.resolved &&
                  // Detached pins stay off the canvas unless asked for (C-D5).
                  (detachedVisible || !t.detached) &&
                  Number.isFinite(t.world.x) &&
                  Number.isFinite(t.world.y),
              )
              .map((t) => ({
                id: t.id,
                // Author name rides along so the tuner's palette override can
                // recolor pins consistently with that user's cursor/boxes.
                name: t.createdBy,
                x: t.world.x,
                y: t.world.y,
                color: colorFor(t.createdBy),
                resolved: t.resolved,
                unread: threadUnreadCount(t, user.id) > 0,
              })),
      }),
    );
  };

  let timer: ReturnType<typeof setTimeout> | undefined;
  const schedule = () => {
    if (timer) return;
    timer = setTimeout(() => {
      timer = undefined;
      recompute();
      pushPins();
      for (const cb of subscribers) cb(cache);
    }, PUSH_THROTTLE_MS);
  };

  // Threads change → re-render; anchored ITEMS change (moves) → pins follow.
  const offComments = observeComments(doc, schedule);
  let items = kicadItemsMap(itemsDoc);
  // git-integration 0006: a LOCAL edit of the bound document makes new
  // threads on it `dirtyAtWrite` (the anchor may be uncommitted work).
  const onLocalEdit = (tr: Y.Transaction) => {
    if (tr.local && tr.changed.size > 0 && filter?.filePath) markEditedInSession(filter.filePath);
  };
  itemsDoc.on("afterTransaction", onLocalEdit);
  const onItems = () => schedule();
  items.observeDeep(onItems);

  recompute();
  pushPins();
  clog("comments: controller bound,", cache.length, "thread(s)", filter ? `on ${filter.filePath}` : "");

  return {
    mode: () => mode,
    canEditMessage,
    canManageThread,
    subscribeErrors(cb) {
      errorSubscribers.add(cb);
      return () => errorSubscribers.delete(cb);
    },
    async report(threadId, messageId, reason, note) {
      const r = opts.rest;
      if (!r || mode === "read") {
        fail("reporting needs a signed-in session on a backend", 0);
        return false;
      }
      try {
        // The thread lives in the project comments document; the moderation
        // lookup opens that room (git-integration 0001). Legacy single-doc
        // sessions (no filter) still name the file.
        const reportDoc = filter ? COMMENTS_DOC_PATH : r.docPath;
        const res = await fetch(withCopyParam(`${r.apiBase}${commentReportUrl(r.scope, r.project, reportDoc)}`), {
          method: "POST",
          credentials: "include",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ threadId, messageId, reason, ...(note ? { note } : {}) }),
        });
        if (!res.ok) {
          const body = (await res.json().catch(() => null)) as { message?: string } | null;
          fail(body?.message ?? `report failed (${res.status})`, res.status);
          return false;
        }
        return true;
      } catch (e) {
        fail(e instanceof Error ? e.message : String(e), 0);
        return false;
      }
    },
    threads: () => cache,
    subscribe(cb) {
      subscribers.add(cb);
      return () => subscribers.delete(cb);
    },
    anchorAt(world, maxDistIu) {
      let best: { uuid: string; pos: { x: number; y: number }; d2: number } | null = null;

      for (const [uuid, ym] of items) {
        const item = yToItemUnchecked(ym);
        const at = field(item.body, "at");
        const [xs, ys] = at ? args(at) : [];
        const x = Number(xs) * iuPerMm;
        const y = Number(ys) * iuPerMm;

        if (!Number.isFinite(x) || !Number.isFinite(y)) continue;

        const d2 = (x - world.x) ** 2 + (y - world.y) ** 2;

        if (d2 <= maxDistIu * maxDistIu && (!best || d2 < best.d2)) {
          best = { uuid, pos: { x, y }, d2 };
        }
      }

      if (best) {
        return stampDoc({
          itemUuid: best.uuid,
          pos: { x: world.x, y: world.y },
          offset: { x: world.x - best.pos.x, y: world.y - best.pos.y },
        });
      }

      return stampDoc({ pos: { x: world.x, y: world.y } });
    },
    create(rawAnchor, body, mentions) {
      if (mode === "read") return "";
      const anchor = stampDoc(rawAnchor);
      if (mode === "comment") {
        // Pre-chosen id so the popover can open on the echo.
        const id = genId();
        post({ type: "createThread", anchor, body, mentions, id, provenance: provenance() });
        return id;
      }
      return createThread(doc, {
        anchor,
        author: user.id,
        authorName: user.name,
        authorEmail: user.email,
        body,
        mentions,
        provenance: provenance(),
      });
    },
    reply(threadId, body, mentions) {
      if (mode === "read") return;
      if (mode === "comment") {
        post({ type: "addMessage", threadId, body, mentions });
        return;
      }
      addMessage(doc, threadId, {
        author: user.id,
        authorName: user.name,
        authorEmail: user.email,
        body,
        mentions,
      });
    },
    markSeen(threadId) {
      if (mode === "read") return;
      if (mode === "comment") {
        post({ type: "markSeen", threadId });
        return;
      }
      markThreadSeen(doc, threadId, user.id);
    },
    toggleReaction(threadId, messageId, emoji) {
      if (mode === "read") return;
      if (mode === "comment") {
        post({ type: "toggleReaction", threadId, messageId, emoji });
        return;
      }
      toggleReaction(doc, threadId, messageId, user.id, emoji);
    },
    edit(threadId, messageId, body) {
      const thread = threadOf(threadId);
      if (!thread || !canEditMessage(thread, messageId)) return false;
      if (mode === "comment") {
        post({ type: "editMessage", threadId, messageId, body });
        return true;
      }
      return editMessage(doc, threadId, messageId, body);
    },
    remove(threadId, messageId) {
      const thread = threadOf(threadId);
      if (!thread || !canEditMessage(thread, messageId)) return false;
      if (mode === "comment") {
        // Mirror the doc rule: a commenter's root only goes when every other
        // message is theirs too (the server answers 409 otherwise).
        const isRoot = thread.rootId === messageId;
        if (isRoot && thread.messages.some((m) => m.author !== user.id)) {
          fail("you can't delete a comment others have replied to", 409);
          return false;
        }
        post({ type: "removeMessage", threadId, messageId });
        return isRoot || thread.messages.length <= 1 ? "thread-deleted" : "removed";
      }
      return removeMessage(doc, threadId, messageId);
    },
    setResolved(threadId, resolved) {
      const thread = threadOf(threadId);
      if (!thread || !canManageThread(thread)) return;
      if (mode === "comment") {
        post({ type: "setResolved", threadId, resolved });
        return;
      }
      // Write mode records where it was resolved (design-comments C-D8); in
      // comment mode the backend stamps it from the request's copy.
      const ref = currentCopyRef();
      setThreadResolved(
        doc,
        threadId,
        resolved,
        ref ? { workingCopyId: ref.id, ...(ref.headCommit ? { headCommit: ref.headCommit } : {}) } : undefined,
      );
    },
    deleteThread(threadId) {
      const thread = threadOf(threadId);
      if (!thread || !canManageThread(thread)) return;
      if (mode === "comment") {
        // No delete-thread op for commenters: removing the root deletes the
        // thread (only when every message is theirs — the server enforces).
        if (thread.messages.some((m) => m.author !== user.id)) {
          fail("you can't delete a thread others have replied to", 409);
          return;
        }
        post({ type: "removeMessage", threadId, messageId: thread.rootId });
        return;
      }
      deleteThread(doc, threadId);
    },
    moveThread(threadId, rawAnchor) {
      const thread = threadOf(threadId);
      if (!thread || !canManageThread(thread)) return;
      // A move never changes which document the thread belongs to: keep the
      // thread's own filePath/sheetPath (a drag hands back a bare anchor).
      const anchor: CommentAnchor = {
        ...rawAnchor,
        ...(thread.anchor.filePath !== undefined ? { filePath: thread.anchor.filePath } : {}),
        ...(thread.anchor.sheetPath !== undefined ? { sheetPath: thread.anchor.sheetPath } : {}),
      };
      if (mode === "comment") {
        post({ type: "setAnchor", threadId, anchor });
        return;
      }
      setThreadAnchor(doc, threadId, anchor);
    },
    setPinsVisible(v) {
      visible = v;
      pushPins();
    },
    pinsVisible: () => visible,
    setDetachedPinsVisible(v) {
      detachedVisible = v;
      pushPins();
    },
    detachedPinsVisible: () => detachedVisible,
    document: () => filter,
    setDocument(nextItems, filePath, sheetPath) {
      const next: ThreadFilter = { filePath, ...(sheetPath ? { sheetPath } : {}) };
      const same =
        nextItems === itemsDoc &&
        filter?.filePath === next.filePath &&
        filter?.sheetPath === next.sheetPath;
      if (same) return;
      items.unobserveDeep(onItems);
      itemsDoc.off("afterTransaction", onLocalEdit);
      itemsDoc.off("afterTransaction", onLocalEdit);
      itemsDoc = nextItems;
      itemsDoc.on("afterTransaction", onLocalEdit);
      items = kicadItemsMap(itemsDoc);
      items.observeDeep(onItems);
      filter = next;
      if (timer) clearTimeout(timer);
      timer = undefined;
      recompute();
      pushPins();
      clog("comments: rebound to", filePath, "—", cache.length, "thread(s)");
      for (const cb of docSubscribers) cb(filter);
      for (const cb of subscribers) cb(cache);
    },
    subscribeDocument(cb) {
      docSubscribers.add(cb);
      return () => docSubscribers.delete(cb);
    },
    colorFor,
    jumpTo(threadId) {
      const t = cache.find((x) => x.id === threadId);
      if (t) mod.kicadCollabSetViewport(t.world.x, t.world.y);
    },
    destroy() {
      offComments();
      items.unobserveDeep(onItems);
      subscribers.clear();
      docSubscribers.clear();
      if (timer) clearTimeout(timer);
      timer = undefined;
      try {
        mod.kicadCollabSetPins(JSON.stringify({ pins: [] }));
      } catch {
        /* wasm may already be gone on teardown */
      }
    },
  };
}
