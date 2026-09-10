import type * as Y from "yjs";
import {
  addMessage,
  args,
  colorForUser,
  commentAuthorColors,
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
  commentOpsUrl,
  type CommentAnchor,
  type CommentOp,
  type CommentThread,
} from "@pcbjam/shared";
import { clog } from "./debug";

/**
 * Comments controller (collab-presence 0005): glues the MIT `kdoc_comments`
 * helpers (0004) to the editor —
 *   - resolves every thread's anchor to a world position (tracking anchored
 *     items through `kdoc_items` changes),
 *   - feeds the GAL pin dots (`Module.kicadCollabSetPins`, throttled snapshot,
 *     same idempotent contract as the presence overlay),
 *   - exposes the threads + CRUD to the React layer (CommentLayer).
 * One controller per bound doc; eeschema rebinds it per sheet, exactly like
 * presence.
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
  detached: boolean;
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
  /** Presence-aware author color (nth-in-room when online, hash fallback). */
  colorFor(userId: string): string;
  /** Pan the editor to a thread's pin (comment panel "jump to"). */
  jumpTo(threadId: string): void;
  destroy(): void;
}

const PUSH_THROTTLE_MS = 30;

export function createComments(opts: {
  doc: Y.Doc;
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
  /** REST target for "comment" mode: the backend origin + the doc's address. */
  rest?: { apiBase: string; scope: string; project: string; docPath: string };
}): CommentsController {
  const { doc, mod, user } = opts;
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
    void fetch(`${r.apiBase}${commentOpsUrl(r.scope, r.project, r.docPath)}`, {
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
    listThreads(doc).find((t) => t.id === threadId);
  const canEditMessage = (thread: CommentThread, messageId: string): boolean => {
    if (mode === "read") return false;
    if (mode === "write") return true;
    return thread.messages.find((m) => m.id === messageId)?.author === user.id;
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
  const subscribers = new Set<(threads: ResolvedThread[]) => void>();

  const recompute = (): ResolvedThread[] => {
    cache = listThreads(doc).map((t) => {
      const { x, y, detached } = resolveAnchor(doc, t.anchor, iuPerMm);
      return { ...t, world: { x, y }, detached };
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
                (t) => !t.resolved && Number.isFinite(t.world.x) && Number.isFinite(t.world.y),
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
  const items = kicadItemsMap(doc);
  const onItems = () => schedule();
  items.observeDeep(onItems);

  recompute();
  pushPins();
  clog("comments: controller bound,", cache.length, "thread(s)");

  return {
    mode: () => mode,
    canEditMessage,
    canManageThread,
    subscribeErrors(cb) {
      errorSubscribers.add(cb);
      return () => errorSubscribers.delete(cb);
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
        return {
          itemUuid: best.uuid,
          pos: { x: world.x, y: world.y },
          offset: { x: world.x - best.pos.x, y: world.y - best.pos.y },
        };
      }

      return { pos: { x: world.x, y: world.y } };
    },
    create(anchor, body, mentions) {
      if (mode === "read") return "";
      if (mode === "comment") {
        // Pre-chosen id so the popover can open on the echo.
        const id = genId();
        post({ type: "createThread", anchor, body, mentions, id });
        return id;
      }
      return createThread(doc, {
        anchor,
        author: user.id,
        authorName: user.name,
        authorEmail: user.email,
        body,
        mentions,
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
      setThreadResolved(doc, threadId, resolved);
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
    moveThread(threadId, anchor) {
      const thread = threadOf(threadId);
      if (!thread || !canManageThread(thread)) return;
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
    colorFor,
    jumpTo(threadId) {
      const t = cache.find((x) => x.id === threadId);
      if (t) mod.kicadCollabSetViewport(t.world.x, t.world.y);
    },
    destroy() {
      offComments();
      items.unobserveDeep(onItems);
      subscribers.clear();
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
