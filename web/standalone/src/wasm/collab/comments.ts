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
  type CommentAnchor,
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

export interface CommentsController {
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
}): CommentsController {
  const { doc, mod, user } = opts;
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
      addMessage(doc, threadId, {
        author: user.id,
        authorName: user.name,
        authorEmail: user.email,
        body,
        mentions,
      });
    },
    markSeen(threadId) {
      markThreadSeen(doc, threadId, user.id);
    },
    toggleReaction(threadId, messageId, emoji) {
      toggleReaction(doc, threadId, messageId, user.id, emoji);
    },
    edit(threadId, messageId, body) {
      return editMessage(doc, threadId, messageId, body);
    },
    remove(threadId, messageId) {
      return removeMessage(doc, threadId, messageId);
    },
    setResolved(threadId, resolved) {
      setThreadResolved(doc, threadId, resolved);
    },
    deleteThread(threadId) {
      deleteThread(doc, threadId);
    },
    moveThread(threadId, anchor) {
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
