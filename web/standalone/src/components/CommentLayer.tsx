import * as React from "react";
import { createPortal } from "react-dom";
import { overlayRowClass } from "@/components/OverlayMenu";
import {
  threadMentionsUnread,
  threadUnreadCount,
  type Collaborator,
  type CommentAnchor,
} from "@pcbjam/shared";
import {
  CheckCheck,
  ChevronDown,
  ChevronRight,
  Eye,
  EyeOff,
  List,
  MessageSquarePlus,
  Plus,
  SmilePlus,
  X,
} from "lucide-react";
import {
  screenToWorld,
  worldToScreen,
  type CommentsController,
  type ResolvedThread,
  type ViewportState,
} from "@/wasm/collab/comments";
import {
  bubbleCenterOffsetPx,
  pinRadiusPx,
  subscribePinRadius,
} from "@/wasm/collab/pin-geometry";
import { useDraggablePanel } from "@/components/useDraggablePanel";
import { EmojiPickerPopover } from "@/components/EmojiPicker";
import { MentionInput } from "@/components/MentionInput";
import { noteEmojiUsed, quickEmojis } from "@/lib/emoji-quick";
import { cachedCollaborators, collaborators, mergeCandidates } from "@/lib/mentions";

/**
 * DOM half of the hybrid comment pins (collab-presence 0005): the GAL overlay
 * draws the dots (zero pan/zoom lag); this layer adds what DOM does better —
 * click/drag targets over each dot, the thread popover (read/reply/edit/
 * resolve/delete), the comment-mode click catcher + composer, and the list
 * panel. One comment icon (top-right) expands into a small horizontal bar:
 * new comment · list · show/hide all. Pins are draggable — the anchor is
 * re-written live while dragging (LWW), and re-snapped to the nearest item on
 * drop. Positions map world→canvas-px via the exported viewport transform,
 * then canvas-px→CSS via the GAL panel's bounding rect (`#glcanvas-*`).
 */

interface CssRect {
  x: number;
  y: number;
  width: number;
  height: number;
}


/**
 * What to show for a comment author, and what to reveal on hover.
 *
 * `author`/`createdBy` is the SLUG — the identity key used for colors and
 * ownership. It is what used to be rendered, which is why comments showed a
 * scope-looking string instead of a person. Prefer the denormalized display
 * name; legacy messages (written before authorName existed) have none and fall
 * back to the slug, so old threads keep working.
 */
function authorLabel(a: { author?: string; createdBy?: string; authorName?: string; authorEmail?: string }): {
  text: string;
  title: string;
} {
  const slug = a.author ?? a.createdBy ?? "";
  const text = a.authorName || slug;
  // Tooltip: email when we captured one, otherwise the slug — always something
  // more identifying than the label itself.
  const title = a.authorEmail ? `${text} <${a.authorEmail}>` : slug;
  return { text, title };
}

function glCanvasRect(): CssRect | null {
  const el = Array.from(document.querySelectorAll('[id^="glcanvas-"]')).find((c) => {
    const r = (c as HTMLElement).getBoundingClientRect();
    return getComputedStyle(c as HTMLElement).display !== "none" && r.width > 0;
  }) as HTMLElement | undefined;

  if (!el) return null;
  const r = el.getBoundingClientRect();
  return { x: r.x, y: r.y, width: r.width, height: r.height };
}

function timeAgo(ms: number): string {
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 60) return "now";
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

const DRAG_THRESHOLD_PX = 4;
const DRAG_SYNC_MS = 60;

const PANEL_OPEN_KEY = "pcbjam:comments-panel-open";
const PANEL_COLLAPSED_KEY = "pcbjam:comments-panel-collapsed";
const PANEL_POS_KEY = "pcbjam:comments-panel-pos";
const PANEL_W = 288; // w-72
const PANEL_HEADER_H = 36;

export function CommentLayer({
  controller,
  viewport,
  currentUser,
  menuSlot,
  onUnreadChange,
  mentionPeers,
}: {
  controller: CommentsController;
  viewport: ViewportState | null;
  currentUser: string;
  /** The overlay menu's comments section (0010): the bar + list panel portal
   *  into it while the menu is open; null (menu closed) renders neither.
   *  Pins, popovers, composer and the click catcher stay canvas-anchored. */
  menuSlot: HTMLElement | null;
  /** Unread rollup for the overlay FAB badge (0001 C): threads with unread
   *  messages + whether any of them mentions the current user. */
  onUnreadChange?: (unreadThreads: number, mentioned: boolean) => void;
  /** Live presence peers as mention candidates (0001 E fallback roster). */
  mentionPeers?: Collaborator[];
}) {
  const [threads, setThreads] = React.useState<ResolvedThread[]>(controller.threads());
  const [mode, setMode] = React.useState(false);
  const [openId, setOpenId] = React.useState<string | null>(null);
  // The floating panel's open state survives reloads (position does too, via
  // useDraggablePanel inside CommentsPanel).
  const [panel, setPanelState] = React.useState<boolean>(() => {
    try {
      return localStorage.getItem(PANEL_OPEN_KEY) === "1";
    } catch {
      return false;
    }
  });
  const setPanel = (next: boolean | ((p: boolean) => boolean)) => {
    setPanelState((prev) => {
      const v = typeof next === "function" ? next(prev) : next;
      try {
        localStorage.setItem(PANEL_OPEN_KEY, v ? "1" : "0");
      } catch {
        /* private mode */
      }
      return v;
    });
  };
  const [showResolved, setShowResolved] = React.useState(false);
  const [hidden, setHidden] = React.useState(!controller.pinsVisible());
  const [draft, setDraft] = React.useState<{ anchor: CommentAnchor; css: { x: number; y: number } } | null>(null);
  // The GAL panel's CSS rect — re-measured on viewport pushes + window resize.
  const [glRect, setGlRect] = React.useState<CssRect | null>(null);
  // Live drag state: the dragged thread follows the pointer in CSS space (the
  // GAL dot follows through the throttled anchor writes).
  const [drag, setDrag] = React.useState<{ id: string; css: { x: number; y: number } } | null>(null);
  const dragRef = React.useRef<{
    id: string;
    startX: number;
    startY: number;
    moved: boolean;
    lastSync: number;
  } | null>(null);

  // Re-seed on controller rebind (eeschema sheet switch swaps the controller;
  // the useState initializer only covers the first mount).
  React.useEffect(() => {
    setThreads(controller.threads());
    setOpenId(null);
    setDraft(null);
    setHidden(!controller.pinsVisible());
    return controller.subscribe(setThreads);
  }, [controller]);

  // Viewing an open thread marks it seen — including replies that arrive
  // WHILE it is open (threads dep). markSeen is forward-only, so the
  // write-observe-rerun cycle settles instead of looping.
  React.useEffect(() => {
    if (openId) controller.markSeen(openId);
  }, [openId, threads, controller]);

  const unreadThreads = threads.filter((t) => threadUnreadCount(t, currentUser) > 0).length;
  const mentioned = threads.some((t) => threadMentionsUnread(t, currentUser));

  // Mention candidates (0001 E): backend roster (lazy, session-cached) ∪
  // presence peers ∪ authors already in the doc; never yourself.
  const threadsRef = React.useRef(threads);
  threadsRef.current = threads;
  const mentionPeersRef = React.useRef(mentionPeers);
  mentionPeersRef.current = mentionPeers;
  const getMentionCandidates = React.useCallback(async (): Promise<Collaborator[]> => {
    const server = (await collaborators()) ?? [];
    const peers = mentionPeersRef.current ?? [];
    const authors: Collaborator[] = threadsRef.current.flatMap((t) =>
      t.messages.map((m) => ({ slug: m.author, name: m.authorName || m.author })),
    );
    return mergeCandidates(server, peers, authors).filter((c) => c.slug !== currentUser);
  }, [currentUser]);

  React.useEffect(() => {
    onUnreadChange?.(unreadThreads, mentioned);
  }, [unreadThreads, mentioned, onUnreadChange]);

  React.useEffect(() => {
    const measure = () => setGlRect(glCanvasRect());
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [viewport]);

  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setMode(false);
        setDraft(null);
        setOpenId(null);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const cssRatio = viewport && glRect ? glRect.width / viewport.w : 1;

  const toCss = (world: { x: number; y: number }) => {
    if (!viewport || !glRect) return null;
    const px = worldToScreen(viewport, world);
    const x = glRect.x + px.x * cssRatio;
    const y = glRect.y + px.y * cssRatio;
    if (x < glRect.x - 20 || x > glRect.x + glRect.width + 20) return null;
    if (y < glRect.y - 20 || y > glRect.y + glRect.height + 20) return null;
    return { x, y };
  };

  const cssToWorld = (css: { x: number; y: number }) => {
    if (!viewport || !glRect) return null;
    return screenToWorld(viewport, {
      x: (css.x - glRect.x) / cssRatio,
      y: (css.y - glRect.y) / cssRatio,
    });
  };

  const snapRadiusIu = () =>
    viewport ? 14 / (viewport.scale * cssRatio) : 0;

  const onModeClick = (e: React.MouseEvent) => {
    const world = cssToWorld({ x: e.clientX, y: e.clientY });
    if (!world) return;
    setDraft({
      anchor: controller.anchorAt(world, snapRadiusIu()),
      css: { x: e.clientX, y: e.clientY },
    });
    setMode(false);
  };

  // ── pin dragging ────────────────────────────────────────────────────────
  const onPinPointerDown = (t: ResolvedThread) => (e: React.PointerEvent) => {
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    dragRef.current = { id: t.id, startX: e.clientX, startY: e.clientY, moved: false, lastSync: 0 };
  };

  const onPinPointerMove = (e: React.PointerEvent) => {
    const d = dragRef.current;
    if (!d) return;
    if (!d.moved) {
      if (Math.hypot(e.clientX - d.startX, e.clientY - d.startY) < DRAG_THRESHOLD_PX) return;
      d.moved = true;
      setOpenId(null);
    }
    setDrag({ id: d.id, css: { x: e.clientX, y: e.clientY } });
    // Throttled live re-anchor (pos-only while dragging — snap happens on
    // drop) so the GAL dot and every peer follow the drag.
    const now = Date.now();
    if (now - d.lastSync >= DRAG_SYNC_MS) {
      d.lastSync = now;
      const world = cssToWorld({ x: e.clientX, y: e.clientY });
      if (world) controller.moveThread(d.id, { pos: world });
    }
  };

  const onPinPointerUp = (t: ResolvedThread) => (e: React.PointerEvent) => {
    const d = dragRef.current;
    dragRef.current = null;
    setDrag(null);
    if (!d) return;
    if (d.moved) {
      const world = cssToWorld({ x: e.clientX, y: e.clientY });
      if (world) controller.moveThread(t.id, controller.anchorAt(world, snapRadiusIu()));
    } else {
      setOpenId((cur) => (cur === t.id ? null : t.id));
    }
  };

  const toggleHidden = () => {
    const next = !hidden;
    setHidden(next);
    controller.setPinsVisible(!next);
    if (next) {
      setOpenId(null);
      setMode(false);
      setDraft(null);
    }
  };

  // The GAL bubble's body floats up-right of the anchored point (sharp
  // corner) — DOM (hit target, popover) must sit on the body, not the tip.
  // The radius is LIVE (PresenceTuner re-styles the GAL pins at runtime), so
  // subscribe rather than reading a constant.
  const pinR = React.useSyncExternalStore(subscribePinRadius, pinRadiusPx);
  const bubbleOff = bubbleCenterOffsetPx();
  const toBodyCss = (css: { x: number; y: number }) => ({
    x: css.x + bubbleOff.dx * cssRatio,
    y: css.y + bubbleOff.dy * cssRatio,
  });

  const open = openId ? threads.find((t) => t.id === openId) : undefined;
  // A thread opened from the panel may sit off-screen (jump-to clamps at the
  // view bounds) — fall back to a centered popover rather than rendering none.
  const openAnchorCss = open ? toCss(open.world) : null;
  const openCss = open
    ? (openAnchorCss ? toBodyCss(openAnchorCss) : { x: window.innerWidth / 2 - 150, y: 120 })
    : null;
  const visibleThreads = threads.filter((t) => showResolved || !t.resolved);
  const pinThreads = hidden ? [] : visibleThreads;

  // Comment toolbar + list panel: portaled into the overlay menu's comments
  // slot (0010) while the menu is open — in-flow there, not absolute.
  const menuUi = menuSlot
    ? createPortal(
        <>
          {/* The overlay menu's "Comments" section IS the group, so there is no
              nested open/close toggle here any more — that was a collapsible
              inside a collapsible. And every action is a LABELLED row: the old
              bar was four bare icons whose meanings you had to hover to learn. */}
          <div className="flex w-full flex-col">
            <button
              data-testid="comment-mode-toggle"
              aria-pressed={mode}
              title={mode ? "Cancel (Esc)" : "Click the canvas to place a pin"}
              onClick={() => {
                if (hidden) toggleHidden();
                setMode((m) => !m);
                setDraft(null);
              }}
              className={`${overlayRowClass} ${mode ? "bg-amber-500/20 text-amber-600 dark:text-amber-200" : ""}`}
            >
              <MessageSquarePlus size={14} className="shrink-0 text-neutral-400 dark:text-white/50" />
              <span>{mode ? "Placing comment…" : "Add comment"}</span>
              <span className="ml-auto text-[10px] text-neutral-400 dark:text-white/40">
                {mode ? "Esc" : ""}
              </span>
            </button>

            <button
              data-testid="comment-panel-toggle"
              aria-pressed={panel}
              title="Show every comment in this file"
              onClick={() => setPanel((p) => !p)}
              className={`${overlayRowClass} ${panel ? "bg-black/10 dark:bg-white/10" : ""}`}
            >
              <List size={14} className="shrink-0 text-neutral-400 dark:text-white/50" />
              <span>{panel ? "Close comments panel" : "Open comments panel"}</span>
              <span className="ml-auto flex items-center gap-1 text-[10px] text-neutral-400 dark:text-white/40">
                {unreadThreads > 0 && (
                  <span
                    data-testid="comment-unread-badge"
                    title={mentioned ? "Unread comments — you were mentioned" : "Unread comments"}
                    className={`flex h-4 min-w-4 items-center justify-center rounded-full px-1 font-semibold text-white ${
                      mentioned ? "bg-rose-500" : "bg-amber-500"
                    }`}
                  >
                    {unreadThreads}
                  </span>
                )}
                {threads.length}
              </span>
            </button>

            <button
              data-testid="comment-visibility-toggle"
              aria-pressed={!hidden}
              title={hidden ? "Show the pins on the canvas" : "Hide the pins on the canvas"}
              onClick={toggleHidden}
              className={overlayRowClass}
            >
              {hidden ? (
                <EyeOff size={14} className="shrink-0 text-neutral-400 dark:text-white/50" />
              ) : (
                <Eye size={14} className="shrink-0 text-neutral-400 dark:text-white/50" />
              )}
              <span>{hidden ? "Show pins" : "Hide pins"}</span>
            </button>
          </div>

        </>,
        menuSlot,
      )
    : null;

  return (
    <>
      {menuUi}

      {/* Floating comments panel (comments-ux 0001 B): draggable, scrollable,
          independent of the overlay menu's open state. */}
      {panel && (
        <CommentsPanel
          threads={visibleThreads}
          total={threads.length}
          currentUser={currentUser}
          showResolved={showResolved}
          onShowResolved={setShowResolved}
          controller={controller}
          mode={mode}
          onToggleMode={() => {
            if (hidden) toggleHidden();
            setMode((m) => !m);
            setDraft(null);
          }}
          pinsHidden={hidden}
          onTogglePins={toggleHidden}
          onJump={(t) => {
            if (hidden) toggleHidden();
            controller.jumpTo(t.id);
            setOpenId(t.id);
          }}
          onClose={() => setPanel(false)}
        />
      )}

      {/* Comment-mode click catcher over the drawing area only. */}
      {mode && glRect && (
        <div
          data-testid="comment-click-catcher"
          className="absolute z-30 cursor-crosshair"
          style={{ left: glRect.x, top: glRect.y, width: glRect.width, height: glRect.height }}
          onClick={onModeClick}
        />
      )}

      {/* Pin hit/drag targets (the visual dot is GAL — these are the DOM halves). */}
      {pinThreads.map((t) => {
        const anchorCss = drag?.id === t.id ? drag.css : toCss(t.world);
        if (!anchorCss) return null;
        const css = toBodyCss(anchorCss);
        // The GAL bubble's CSS size (device px × ratio) — the visible ring
        // must hug the drawn body, while the transparent button keeps a
        // finger-friendly hit area regardless of DPI. +4 ≈ the default ring
        // width (collab_presence_style.h pinRingPx) so the highlight clears
        // the stroke's outer edge.
        const bubbleD = 2 * pinR * cssRatio + 4;
        const hitD = Math.max(26, bubbleD + 8);
        return (
          <button
            key={t.id}
            data-testid="comment-pin"
            data-thread-id={t.id}
            title={`${authorLabel(t).text}: ${t.messages[0]?.body ?? ""}${t.detached ? " (detached)" : ""} — drag to move`}
            onPointerDown={onPinPointerDown(t)}
            onPointerMove={onPinPointerMove}
            onPointerUp={onPinPointerUp(t)}
            className={`group absolute z-30 -translate-x-1/2 -translate-y-1/2 ${
              drag?.id === t.id ? "cursor-grabbing" : "cursor-grab"
            }`}
            style={{
              left: css.x,
              top: css.y,
              width: hitD,
              height: hitD,
              background: "transparent",
              touchAction: "none",
            }}
          >
            {/* Highlight sized + shaped like the GAL bubble (round, sharp
                bottom-left corner), always slightly padded from the hit
                area: a hugging soft wash + outline reads as "this pin",
                not a detached circle. */}
            <span
              className={`pointer-events-none absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 transition-opacity ${
                drag?.id === t.id
                  ? "bg-sky-400/25 ring-2 ring-sky-500 dark:ring-sky-300"
                  : "opacity-0 group-hover:opacity-100 bg-sky-400/15 ring-2 ring-sky-500/70 dark:ring-sky-300/70"
              }`}
              style={{
                width: bubbleD + 4,
                height: bubbleD + 4,
                borderRadius: "9999px",
                borderBottomLeftRadius: 0,
              }}
            />
          </button>
        );
      })}

      {/* New-comment composer at the clicked point. */}
      {draft && (
        <Composer
          css={draft.css}
          getCandidates={getMentionCandidates}
          onCancel={() => setDraft(null)}
          onSubmit={(body, mentions) => {
            const id = controller.create(draft.anchor, body, mentions);
            setDraft(null);
            setOpenId(id);
          }}
        />
      )}

      {/* Thread popover next to its pin. */}
      {open && openCss && !hidden && (
        <ThreadPopover
          thread={open}
          css={openCss}
          currentUser={currentUser}
          controller={controller}
          getCandidates={getMentionCandidates}
          onClose={() => setOpenId(null)}
        />
      )}

    </>
  );
}

/**
 * Floating comments panel (comments-ux 0001 B): a draggable window listing
 * every thread, newest activity first, with its own scrollbar. The header
 * carries the primary comment actions too (add pin, show/hide pins) and the
 * panel COLLAPSES to just that header. Position, open and collapsed state
 * persist per browser; useDraggablePanel guarantees the header can never be
 * restored or stranded offscreen.
 */
function CommentsPanel({
  threads,
  total,
  currentUser,
  showResolved,
  onShowResolved,
  controller,
  mode,
  onToggleMode,
  pinsHidden,
  onTogglePins,
  onJump,
  onClose,
}: {
  threads: ResolvedThread[];
  total: number;
  currentUser: string;
  showResolved: boolean;
  onShowResolved: (v: boolean) => void;
  controller: CommentsController;
  mode: boolean;
  onToggleMode: () => void;
  pinsHidden: boolean;
  onTogglePins: () => void;
  onJump: (t: ResolvedThread) => void;
  onClose: () => void;
}) {
  const rootRef = React.useRef<HTMLDivElement | null>(null);
  const drag = useDraggablePanel({
    storageKey: PANEL_POS_KEY,
    handleWidth: PANEL_W,
    handleHeight: PANEL_HEADER_H,
  });
  const [collapsed, setCollapsedState] = React.useState<boolean>(() => {
    try {
      return localStorage.getItem(PANEL_COLLAPSED_KEY) === "1";
    } catch {
      return false;
    }
  });
  const setCollapsed = (v: boolean) => {
    setCollapsedState(v);
    try {
      localStorage.setItem(PANEL_COLLAPSED_KEY, v ? "1" : "0");
    } catch {
      /* private mode */
    }
  };
  // Default anchor: top-right area but CLEAR of the overlay menu's panel
  // (which opens at the FAB, right-anchored, z-50 above us) — the panel is
  // usually opened FROM that menu, so spawning underneath it would hide it
  // and swallow its header drags.
  const style: React.CSSProperties = drag.pos
    ? { left: drag.pos.x, top: drag.pos.y }
    : { right: 308, top: 12 };

  const lastActivity = (t: ResolvedThread) =>
    t.messages[t.messages.length - 1]?.createdAt ?? t.createdAt;
  const sorted = [...threads].sort((a, b) => lastActivity(b) - lastActivity(a));

  return (
    <div
      ref={rootRef}
      data-testid="comments-panel"
      className="absolute z-40 flex w-72 flex-col overflow-hidden rounded-xl bg-white/95 text-neutral-900 shadow-2xl ring-1 ring-inset ring-black/10 dark:bg-neutral-950/90 dark:text-white dark:ring-white/15 backdrop-blur-sm"
      style={style}
    >
      {/* Header = drag handle. Interactive children stop pointerdown so they
          don't start a drag. */}
      <div
        data-testid="comments-panel-header"
        className="flex cursor-grab select-none items-center gap-2 px-3 py-2 text-xs font-semibold active:cursor-grabbing"
        style={{ touchAction: "none" }}
        title="Comments — drag to move"
        onPointerDown={(e) => drag.onPointerDown(e, rootRef.current!.getBoundingClientRect())}
        onPointerMove={(e) => void drag.onPointerMove(e)}
        onPointerUp={() => void drag.onPointerUp()}
      >
        <button
          data-testid="comments-panel-collapse"
          aria-expanded={!collapsed}
          title={collapsed ? "Expand" : "Collapse to header"}
          onPointerDown={(e) => e.stopPropagation()}
          onClick={() => setCollapsed(!collapsed)}
          className="rounded p-0.5 text-neutral-500 hover:bg-black/5 hover:text-neutral-900 dark:text-white/60 dark:hover:bg-white/10 dark:hover:text-white"
        >
          {collapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
        </button>
        <span>Comments ({threads.length})</span>
        <span
          className="ml-auto flex items-center gap-0.5"
          onPointerDown={(e) => e.stopPropagation()}
        >
          <button
            data-testid="comments-panel-add"
            aria-pressed={mode}
            title={mode ? "Cancel placing (Esc)" : "Add comment — click the canvas to place a pin"}
            onClick={onToggleMode}
            className={`rounded p-0.5 hover:bg-black/5 hover:text-neutral-900 dark:hover:bg-white/10 dark:hover:text-white ${
              mode ? "bg-amber-500/20 text-amber-600 dark:text-amber-200" : "text-neutral-500 dark:text-white/60"
            }`}
          >
            <MessageSquarePlus size={14} />
          </button>
          <button
            data-testid="comments-panel-pins"
            aria-pressed={!pinsHidden}
            title={pinsHidden ? "Show the pins on the canvas" : "Hide the pins on the canvas"}
            onClick={onTogglePins}
            className="rounded p-0.5 text-neutral-500 hover:bg-black/5 hover:text-neutral-900 dark:text-white/60 dark:hover:bg-white/10 dark:hover:text-white"
          >
            {pinsHidden ? <EyeOff size={14} /> : <Eye size={14} />}
          </button>
          {threads.some((t) => threadUnreadCount(t, currentUser) > 0) && (
            <button
              data-testid="comments-mark-all-seen"
              title="Mark all as seen"
              onClick={() => {
                for (const t of threads) {
                  if (threadUnreadCount(t, currentUser) > 0) controller.markSeen(t.id);
                }
              }}
              className="rounded p-0.5 text-neutral-500 hover:bg-black/5 hover:text-neutral-900 dark:text-white/60 dark:hover:bg-white/10 dark:hover:text-white"
            >
              <CheckCheck size={14} />
            </button>
          )}
          <button
            data-testid="comments-panel-close"
            title="Close"
            onClick={onClose}
            className="rounded p-0.5 text-neutral-500 hover:bg-black/5 hover:text-neutral-900 dark:text-white/60 dark:hover:bg-white/10 dark:hover:text-white"
          >
            <X size={14} />
          </button>
        </span>
      </div>

      {!collapsed && (
        <label
          className="flex items-center gap-1.5 border-t border-black/10 px-3 py-1.5 text-[11px] font-normal text-neutral-600 dark:border-white/10 dark:text-white/70"
          onPointerDown={(e) => e.stopPropagation()}
        >
          <input
            data-testid="comment-show-resolved"
            type="checkbox"
            checked={showResolved}
            onChange={(e) => onShowResolved(e.target.checked)}
          />
          show resolved
        </label>
      )}

      {!collapsed && (
      <div data-testid="comments-panel-list" className="max-h-[60vh] overflow-y-auto">
        {sorted.length === 0 && (
          <p className="px-3 pb-3 text-xs text-neutral-500 dark:text-white/50">
            {total === 0 ? "No comments yet." : "Nothing to show — check the resolved filter."}
          </p>
        )}
        {sorted.map((t) => (
          <button
            key={t.id}
            data-testid="comment-panel-item"
            onClick={() => onJump(t)}
            className="block w-full border-t border-black/10 px-3 py-2 text-left text-xs hover:bg-black/5 dark:border-white/10 dark:hover:bg-white/10"
          >
            <span className="flex items-center gap-1">
              <span
                className="font-semibold"
                style={{ color: controller.colorFor(t.createdBy) }}
                title={authorLabel(t).title}
              >
                {authorLabel(t).text}
              </span>{" "}
              <span className="text-neutral-500 dark:text-white/50">
                {timeAgo(lastActivity(t))} ago
                {t.resolved ? " · resolved" : ""}
                {t.messages.length > 1 ? ` · ${t.messages.length - 1} repl${t.messages.length === 2 ? "y" : "ies"}` : ""}
              </span>
              {threadUnreadCount(t, currentUser) > 0 && (
                <span
                  data-testid="comment-unread-dot"
                  title={threadMentionsUnread(t, currentUser) ? "Unread — you were mentioned" : "Unread"}
                  className={`ml-auto h-2 w-2 shrink-0 rounded-full ${
                    threadMentionsUnread(t, currentUser) ? "bg-rose-400" : "bg-amber-400"
                  }`}
                />
              )}
            </span>
            <span className="mt-0.5 block truncate text-neutral-800 dark:text-white/90">
              {t.messages[0]?.body ?? ""}
            </span>
          </button>
        ))}
      </div>
      )}
    </div>
  );
}

/** Slugs actually still `@`-present in the sent body (a mention accepted then
 *  deleted from the text doesn't count). */
function presentMentions(body: string, accepted: Set<string>): string[] {
  return [...accepted].filter((slug) => body.includes(`@${slug}`));
}

function Composer({
  css,
  getCandidates,
  onSubmit,
  onCancel,
}: {
  css: { x: number; y: number };
  getCandidates: () => Promise<Collaborator[]>;
  onSubmit: (body: string, mentions: string[]) => void;
  onCancel: () => void;
}) {
  const [body, setBody] = React.useState("");
  const acceptedRef = React.useRef<Set<string>>(new Set());
  const submit = () => {
    if (body.trim()) onSubmit(body.trim(), presentMentions(body, acceptedRef.current));
    else onCancel();
  };
  return (
    <div
      data-testid="comment-composer"
      className="absolute z-40 w-64 rounded-lg bg-white/95 p-2 shadow-lg ring-1 ring-inset ring-black/15 dark:bg-black/90 dark:ring-white/20"
      style={{ left: Math.min(css.x + 12, window.innerWidth - 280), top: Math.min(css.y, window.innerHeight - 120) }}
    >
      <MentionInput
        multiline
        autoFocus
        value={body}
        onChange={setBody}
        onMention={(slug) => acceptedRef.current.add(slug)}
        onSubmit={submit}
        getCandidates={getCandidates}
        placeholder="Add a comment… (@ to mention)"
        className="h-16 w-full resize-none rounded bg-black/5 p-2 text-xs text-neutral-900 placeholder-neutral-400 outline-none dark:bg-white/10 dark:text-white dark:placeholder-white/40"
      />
      <div className="mt-1 flex justify-end gap-2">
        <button onClick={onCancel} className="rounded px-2 py-1 text-xs text-neutral-600 hover:bg-black/5 dark:text-white/70 dark:hover:bg-white/10">
          Cancel
        </button>
        <button
          data-testid="comment-submit"
          onClick={submit}
          className="rounded bg-sky-600 px-2 py-1 text-xs text-white hover:bg-sky-500"
        >
          Comment
        </button>
      </div>
    </div>
  );
}

const MENTION_RE = /@([A-Za-z0-9][\w.-]*)/g;

/**
 * Message body with `@slug` tokens rendered as highlight chips (comments-ux
 * 0001 E). A token highlights when its slug is in the message's `mentions`
 * (composer-accepted) or matches a known collaborator from the session-cached
 * roster (covers hand-typed mentions). Your own slug gets the amber accent.
 */
function MentionBody({
  body,
  mentions,
  currentUser,
}: {
  body: string;
  mentions?: string[];
  currentUser: string;
}) {
  const known = new Set([
    ...(mentions ?? []),
    ...(cachedCollaborators() ?? []).map((c) => c.slug),
  ]);
  const parts: React.ReactNode[] = [];
  let last = 0;

  for (const match of body.matchAll(MENTION_RE)) {
    const slug = match[1];
    if (!slug || !known.has(slug) || match.index === undefined) continue;
    parts.push(body.slice(last, match.index));
    parts.push(
      <span
        key={match.index}
        data-testid="comment-mention"
        data-slug={slug}
        title={`@${slug}`}
        className={`rounded px-0.5 font-medium ${
          slug === currentUser ? "bg-amber-500/25 text-amber-700 dark:text-amber-300" : "bg-sky-500/15 text-sky-700 dark:bg-sky-500/20 dark:text-sky-300"
        }`}
      >
        {match[0]}
      </span>,
    );
    last = match.index + match[0].length;
  }
  parts.push(body.slice(last));

  return <p className="mt-0.5 whitespace-pre-wrap text-neutral-800 dark:text-white/90">{parts}</p>;
}

/**
 * Reaction chips + pickers for one message (comments-ux 0001 D). Chips are
 * plain text glyphs (no emoji-mart involved); the hover "add" button opens a
 * quick row of most-used emoji, whose "+" opens the lazy full picker. Both
 * popovers are body-portals at fixed coords — the popover's scroll container
 * would clip in-place absolute children.
 */
function MessageReactions({
  reactions,
  currentUser,
  onToggle,
}: {
  reactions?: Record<string, string[]>;
  currentUser: string;
  onToggle: (emoji: string) => void;
}) {
  const [picker, setPicker] = React.useState<{ kind: "quick" | "full"; x: number; y: number } | null>(null);
  const quickRef = React.useRef<HTMLDivElement | null>(null);

  React.useEffect(() => {
    if (picker?.kind !== "quick") return;
    const onDown = (e: PointerEvent) => {
      if (!quickRef.current?.contains(e.target as Node)) setPicker(null);
    };
    // Capture + stopPropagation: Esc closes the quick row, not the thread
    // popover underneath (CommentLayer's own window Esc handler).
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        setPicker(null);
      }
    };
    window.addEventListener("pointerdown", onDown, true);
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [picker?.kind]);

  const entries = Object.entries(reactions ?? {}).sort(
    (a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]),
  );

  return (
    <div className="mt-1 flex flex-wrap items-center gap-1">
      {entries.map(([emoji, slugs]) => (
        <button
          key={emoji}
          data-testid="comment-reaction-chip"
          data-emoji={emoji}
          title={slugs.join(", ")}
          onClick={() => onToggle(emoji)}
          className={`flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[11px] ring-1 ring-inset ${
            slugs.includes(currentUser)
              ? "bg-sky-500/20 ring-sky-500/50 dark:bg-sky-500/25 dark:ring-sky-300/50"
              : "bg-black/5 ring-black/15 hover:bg-black/10 dark:bg-white/5 dark:ring-white/15 dark:hover:bg-white/10"
          }`}
        >
          <span>{emoji}</span>
          <span className="text-neutral-600 dark:text-white/70">{slugs.length}</span>
        </button>
      ))}
      <button
        data-testid="comment-react"
        title="Add reaction"
        onClick={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          setPicker((p) => (p ? null : { kind: "quick", x: r.x, y: r.bottom }));
        }}
        className={`rounded-full p-1 text-neutral-400 ring-1 ring-inset ring-black/15 hover:bg-black/5 hover:text-neutral-900 dark:text-white/50 dark:ring-white/15 dark:hover:bg-white/10 dark:hover:text-white ${
          entries.length ? "" : "opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
        }`}
      >
        <SmilePlus size={12} />
      </button>

      {picker?.kind === "quick" &&
        createPortal(
          <div
            ref={quickRef}
            data-testid="comment-quick-react"
            className="fixed z-[70] flex items-center gap-0.5 rounded-full bg-white px-1.5 py-1 shadow-xl ring-1 ring-black/10 dark:bg-neutral-900 dark:ring-white/15"
            style={{
              left: Math.max(8, Math.min(picker.x, window.innerWidth - 260)),
              top: Math.min(picker.y + 4, window.innerHeight - 44),
            }}
          >
            {quickEmojis().map((e) => (
              <button
                key={e}
                data-emoji={e}
                title={`React ${e}`}
                onClick={() => {
                  onToggle(e);
                  setPicker(null);
                }}
                className="rounded px-1 text-sm hover:bg-black/5 dark:hover:bg-white/10"
              >
                {e}
              </button>
            ))}
            <button
              data-testid="comment-react-more"
              title="All emoji…"
              onClick={() => setPicker((p) => (p ? { ...p, kind: "full" } : p))}
              className="rounded px-1 text-neutral-500 hover:bg-black/5 hover:text-neutral-900 dark:text-white/60 dark:hover:bg-white/10 dark:hover:text-white"
            >
              <Plus size={14} />
            </button>
          </div>,
          document.body,
        )}

      {picker?.kind === "full" && (
        <EmojiPickerPopover
          anchor={picker}
          onPick={(e) => {
            onToggle(e);
            setPicker(null);
          }}
          onClose={() => setPicker(null)}
        />
      )}
    </div>
  );
}

function ThreadPopover({
  thread,
  css,
  currentUser,
  controller,
  getCandidates,
  onClose,
}: {
  thread: ResolvedThread;
  css: { x: number; y: number };
  currentUser: string;
  controller: CommentsController;
  getCandidates: () => Promise<Collaborator[]>;
  onClose: () => void;
}) {
  const [reply, setReply] = React.useState("");
  const [editing, setEditing] = React.useState<{ id: string; body: string } | null>(null);
  const replyMentionsRef = React.useRef<Set<string>>(new Set());

  const sendReply = () => {
    if (reply.trim()) {
      controller.reply(thread.id, reply.trim(), presentMentions(reply, replyMentionsRef.current));
      setReply("");
      replyMentionsRef.current = new Set();
    }
  };

  // z-[60] beats the overlay menu's z-50 ON PURPOSE: the menu panel is tall
  // enough to cover a pin popover, and a popover can be opened FROM the menu
  // (the thread list's jump-to), so the menu would otherwise swallow clicks on
  // the popover it just spawned. The focused surface wins; the menu stays one
  // click-away from dismissal.
  return (
    <div
      data-testid="comment-popover"
      className="absolute z-[60] w-72 rounded-lg bg-white/95 text-neutral-900 shadow-lg ring-1 ring-inset ring-black/15 dark:bg-black/90 dark:text-white dark:ring-white/20"
      style={{
        left: Math.min(css.x + 16, window.innerWidth - 300),
        top: Math.min(css.y - 8, window.innerHeight - 260),
      }}
    >
      <div className="flex items-center justify-between px-3 py-2">
        <span className="text-xs text-neutral-500 dark:text-white/60">
          {thread.detached && "detached pin · "}
          {thread.resolved ? "resolved" : "open"}
        </span>
        <div className="flex items-center gap-2">
          <button
            data-testid="comment-resolve"
            onClick={() => controller.setResolved(thread.id, !thread.resolved)}
            className="rounded px-1.5 py-0.5 text-[11px] text-neutral-700 ring-1 ring-inset ring-black/20 hover:bg-black/5 dark:text-white/80 dark:ring-white/25 dark:hover:bg-white/10"
          >
            {thread.resolved ? "Reopen" : "Resolve"}
          </button>
          {thread.createdBy === currentUser && (
            <button
              data-testid="comment-delete-thread"
              title="Delete thread"
              onClick={() => {
                controller.deleteThread(thread.id);
                onClose();
              }}
              className="rounded px-1.5 py-0.5 text-[11px] text-red-300 ring-1 ring-inset ring-red-400/40 hover:bg-red-500/20"
            >
              Delete
            </button>
          )}
          <button onClick={onClose} title="Close" className="text-neutral-500 hover:text-neutral-900 dark:text-white/60 dark:hover:text-white">
            <X size={14} />
          </button>
        </div>
      </div>

      <div className="max-h-56 overflow-y-auto border-t border-black/10 dark:border-white/10">
        {thread.messages.map((m) => (
          <div key={m.id} data-testid="comment-message" className="group px-3 py-2 text-xs">
            <div className="flex items-baseline gap-2">
              <span
                className="font-semibold"
                style={{ color: controller.colorFor(m.author) }}
                title={authorLabel(m).title}
              >
                {authorLabel(m).text}
              </span>
              <span className="text-[10px] text-neutral-400 dark:text-white/40">
                {timeAgo(m.createdAt)} ago{m.editedAt ? " · edited" : ""}
              </span>
              {m.author === currentUser && (
                <span className="ml-auto hidden gap-1 group-hover:flex">
                  <button
                    data-testid="comment-edit"
                    onClick={() => setEditing({ id: m.id, body: m.body })}
                    className="text-[10px] text-neutral-500 hover:text-neutral-900 dark:text-white/60 dark:hover:text-white"
                  >
                    edit
                  </button>
                  <button
                    data-testid="comment-remove"
                    onClick={() => {
                      if (controller.remove(thread.id, m.id) === "thread-deleted") onClose();
                    }}
                    className="text-[10px] text-red-300/80 hover:text-red-300"
                  >
                    delete
                  </button>
                </span>
              )}
            </div>
            {editing?.id === m.id ? (
              <div className="mt-1">
                <textarea
                  autoFocus
                  value={editing.body}
                  onChange={(e) => setEditing({ id: m.id, body: e.target.value })}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault();
                      controller.edit(thread.id, m.id, editing.body.trim());
                      setEditing(null);
                    }
                  }}
                  className="h-12 w-full resize-none rounded bg-black/5 p-1.5 text-xs text-neutral-900 outline-none dark:bg-white/10 dark:text-white"
                />
              </div>
            ) : (
              <MentionBody body={m.body} mentions={m.mentions} currentUser={currentUser} />
            )}
            <MessageReactions
              reactions={thread.reactions?.[m.id]}
              currentUser={currentUser}
              onToggle={(emoji) => {
                controller.toggleReaction(thread.id, m.id, emoji);
                noteEmojiUsed(emoji);
              }}
            />
          </div>
        ))}
      </div>

      <div className="border-t border-black/10 p-2 dark:border-white/10">
        <MentionInput
          testId="comment-reply"
          value={reply}
          onChange={setReply}
          onMention={(slug) => replyMentionsRef.current.add(slug)}
          onSubmit={sendReply}
          getCandidates={getCandidates}
          placeholder="Reply… (@ to mention)"
          className="w-full rounded bg-black/5 px-2 py-1.5 text-xs text-neutral-900 placeholder-neutral-400 outline-none dark:bg-white/10 dark:text-white dark:placeholder-white/40"
        />
      </div>
    </div>
  );
}
