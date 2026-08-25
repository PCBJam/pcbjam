// Extracted from WasmTool.tsx (2026-08-25 split) — behavior unchanged.
import * as React from "react";
import {
  AlertTriangle,
  Crosshair,
  EyeOff,
  Layers,
  Moon,
  PanelsTopLeft,
  RefreshCw,
  Sun,
} from "lucide-react";
import type { Tool } from "@pcbjam/shared";
import { setTheme } from "@/lib/theme";
import type { SourceDescriptor } from "@/lib/project-source-shared";
import type { PresencePeer } from "@/wasm/collab/presence";
import type { FollowTarget } from "@/wasm/collab/follow-user";
import { PresenceRoster } from "@/components/PresenceRoster";
import { SourceChip } from "@/components/SourceChip";
import { OverlayMenu, OverlayMenuSection, overlayRowClass } from "@/components/OverlayMenu";
import { CHROME_HOTKEY_LABEL } from "./ui-helpers";
import type { StaleLibEntry } from "./useLibNotices";

/**
 * Behind-the-library state (libs 0017 §2b/2c): placed items a peer updated in
 * the library. Persistent — unlike the toast — and actionable without a page
 * reload: "Update from library" re-reads just those items into the placed
 * instances.
 */
export function StaleLibsRow({
  items,
  updating,
  readOnly,
  onUpdate,
  onDismiss,
}: {
  items: Map<string, StaleLibEntry>;
  updating: boolean;
  readOnly: boolean;
  onUpdate: () => void;
  onDismiss: () => void;
}) {
  const entries = [...items.values()];
  return (
    <div
      data-testid="stale-libs-row"
      className="flex w-full flex-col gap-1 rounded-md bg-amber-500/10 px-2 py-1.5 text-xs text-neutral-800 dark:text-white/90"
    >
      <div className="flex items-center gap-2">
        <AlertTriangle size={14} className="shrink-0 text-amber-500" />
        <span>
          {entries.reduce((n, e) => n + e.names.size, 0)} placed{" "}
          {entries.every((e) => e.kind === "footprint")
            ? "footprint(s)"
            : entries.every((e) => e.kind === "symbol")
              ? "symbol(s)"
              : "item(s)"}{" "}
          behind the library
        </span>
      </div>
      <ul className="ml-6 list-disc font-mono text-[11px] text-neutral-600 dark:text-white/70">
        {entries.flatMap((e) =>
          [...e.names].map((n) => (
            <li key={`${e.kind}:${e.lib}:${n}`} data-testid="stale-lib-item">
              {e.lib}:{n}
            </li>
          )),
        )}
      </ul>
      <div className="ml-6 flex gap-2">
        <button
          type="button"
          data-testid="update-from-library"
          disabled={updating || readOnly}
          onClick={onUpdate}
          className="inline-flex items-center gap-1 rounded bg-amber-500 px-2 py-0.5 text-[11px] font-medium text-neutral-900 hover:bg-amber-400 disabled:opacity-50"
        >
          <RefreshCw size={11} className={updating ? "animate-spin" : ""} />
          Update from library
        </button>
        <button
          type="button"
          data-testid="stale-libs-dismiss"
          onClick={onDismiss}
          className="rounded px-2 py-0.5 text-[11px] text-neutral-500 hover:bg-black/5 dark:text-white/50 dark:hover:bg-white/10"
        >
          Dismiss
        </button>
      </div>
    </div>
  );
}

/**
 * Follow-user (0008): who we're following + how to stop. Esc also works
 * because any canvas key input breaks the follow via noteLocalViewport only
 * when the viewport moves — this banner is the explicit out.
 */
export function FollowBanner({
  target,
  onStop,
}: {
  target: FollowTarget;
  onStop: () => void;
}) {
  return (
    <div
      data-testid="follow-banner"
      className="absolute left-1/2 top-3 z-20 flex -translate-x-1/2 items-center gap-2 rounded-full bg-black/70 px-3 py-1 text-xs text-white shadow-sm ring-1 ring-inset ring-white/20"
    >
      <span>
        Following <span className="font-semibold">{target.name}</span> — move to stop
      </span>
      <button
        type="button"
        className="rounded-full bg-white/15 px-2 py-0.5 font-medium hover:bg-white/25"
        onClick={onStop}
      >
        Stop
      </button>
    </div>
  );
}

/**
 * Overlay menu (0010): the single draggable circular icon replacing the old
 * top-right row. Its badge is the peer count; the panel stacks the session
 * sections — roster, source chip, view-only pill, stale-libs row, comments
 * (portal slot filled by CommentLayer), viewer-panel toggles, chrome toggle,
 * theme. It is the one control that stays up in canvas-only (chrome-hidden)
 * mode.
 */
export function SessionMenu({
  tool,
  readOnly,
  theme,
  peers,
  activeSheetPath,
  followingTarget,
  onFollow,
  sourceDescriptor,
  staleLibItems,
  staleUpdating,
  onUpdateStale,
  onDismissStale,
  commentsUnread,
  hasComments,
  setCommentsSlot,
  effectiveChromeHidden,
  hasLayers,
  layersOpen,
  setLayersOpen,
  inspectorOpen,
  setInspectorOpen,
  canToggleChrome,
  chromeHidden,
  onToggleChrome,
}: {
  tool: Tool;
  readOnly: boolean;
  theme: string;
  peers: PresencePeer[];
  activeSheetPath: string | undefined;
  followingTarget: FollowTarget | null;
  onFollow: (target: FollowTarget | null) => void;
  sourceDescriptor: SourceDescriptor | undefined;
  staleLibItems: Map<string, StaleLibEntry>;
  staleUpdating: boolean;
  onUpdateStale: () => void;
  onDismissStale: () => void;
  commentsUnread: { threads: number; mentioned: boolean };
  /** A comments controller is bound — the Comments section renders its slot. */
  hasComments: boolean;
  /** Ref-callback slot the CommentLayer portals its bar/panel into. */
  setCommentsSlot: (el: HTMLDivElement | null) => void;
  effectiveChromeHidden: boolean;
  /** The layers bridge is available (pcbnew sessions). */
  hasLayers: boolean;
  layersOpen: boolean;
  setLayersOpen: (v: boolean) => void;
  inspectorOpen: boolean;
  setInspectorOpen: (v: boolean) => void;
  /** The loaded bundle exports kicadSetChrome. */
  canToggleChrome: boolean;
  chromeHidden: boolean;
  onToggleChrome: () => void;
}) {
  return (
    <OverlayMenu
      badge={peers.length}
      unread={commentsUnread.threads}
      unreadMention={commentsUnread.mentioned}
      alert={staleLibItems.size > 0}
    >
      {/* PEOPLE — who else is here, and whose view you're locked to. The
          follow state lives on each person's own row (PresenceRoster), so
          there is no separate "Following…" banner to keep in sync. */}
      {peers.length > 0 && (
        <OverlayMenuSection label="People">
          <PresenceRoster
            peers={peers}
            activeSheetPath={activeSheetPath}
            following={followingTarget}
            onFollow={onFollow}
          />
        </OverlayMenuSection>
      )}

      {/* DOCUMENT — where this file came from and whether you may edit it.
          SourceChip is shared with the light project pages, so instead of
          restyling it we ask for its `muted` tone: colour drops to a dot,
          and the chip sits in a normal row like everything else. */}
      {(sourceDescriptor || readOnly || staleLibItems.size > 0) && (
        <OverlayMenuSection label="Document">
          {staleLibItems.size > 0 && (
            <StaleLibsRow
              items={staleLibItems}
              updating={staleUpdating}
              readOnly={readOnly}
              onUpdate={onUpdateStale}
              onDismiss={onDismissStale}
            />
          )}
          {sourceDescriptor && (
            <div className={`${overlayRowClass} cursor-default`}>
              <SourceChip descriptor={sourceDescriptor} tone="muted" />
            </div>
          )}
          {readOnly && (
            <div
              data-testid="view-only-pill"
              className={`${overlayRowClass} cursor-default`}
            >
              <EyeOff size={14} className="shrink-0 text-neutral-400 dark:text-white/50" />
              <span>View only</span>
              <span className="ml-auto text-[10px] text-neutral-400 dark:text-white/40">
                read-only
              </span>
            </div>
          )}
        </OverlayMenuSection>
      )}

      {hasComments && (
        <OverlayMenuSection label="Comments">
          <div
            data-testid="overlay-menu-comments"
            ref={setCommentsSlot}
            className="flex w-full flex-col items-start gap-2"
          />
        </OverlayMenuSection>
      )}

      <OverlayMenuSection label="View">
        {/* Viewer panels (viewer-panels): canvas-only stand-ins for the
            chrome-hidden wx panes — available to viewers and to editors
            in hide-UI mode alike. */}
        {effectiveChromeHidden && hasLayers && (
          <button
            data-testid="layers-panel-toggle"
            aria-pressed={layersOpen}
            className={overlayRowClass}
            title="Board layers — visibility and active layer"
            onClick={() => setLayersOpen(!layersOpen)}
          >
            <Layers size={14} className="shrink-0 text-neutral-400 dark:text-white/50" />
            <span>{layersOpen ? "Hide layers" : "Layers"}</span>
          </button>
        )}
        {effectiveChromeHidden && (tool === "pcbnew" || tool === "eeschema") && (
          <button
            data-testid="inspector-panel-toggle"
            aria-pressed={inspectorOpen}
            className={overlayRowClass}
            title="Properties of the selected items"
            onClick={() => setInspectorOpen(!inspectorOpen)}
          >
            <Crosshair size={14} className="shrink-0 text-neutral-400 dark:text-white/50" />
            <span>{inspectorOpen ? "Hide inspector" : "Inspector"}</span>
          </button>
        )}
        {canToggleChrome && !readOnly && (
          <button
            data-testid="chrome-toggle"
            aria-pressed={chromeHidden}
            className={overlayRowClass}
            title={`${chromeHidden ? "Show" : "Hide"} UI (${CHROME_HOTKEY_LABEL})`}
            onClick={onToggleChrome}
          >
            {chromeHidden ? (
              <PanelsTopLeft size={14} className="shrink-0 text-neutral-400 dark:text-white/50" />
            ) : (
              <EyeOff size={14} className="shrink-0 text-neutral-400 dark:text-white/50" />
            )}
            <span>{chromeHidden ? "Show UI" : "Hide UI"}</span>
            <kbd className="ml-auto rounded bg-black/10 px-1.5 py-0.5 text-[10px] font-medium text-neutral-500 dark:bg-white/10 dark:text-white/50">
              {CHROME_HOTKEY_LABEL}
            </kbd>
          </button>
        )}
        {/* Light/dark toggle (comments-ux 0002): flips the shell theme;
            the F4 effect in WasmTool re-themes the GAL canvas through the
            bridge. Available to viewers too — theming isn't editing. */}
        <button
          data-testid="overlay-theme-toggle"
          aria-pressed={theme === "dark"}
          className={overlayRowClass}
          title={`Switch to ${theme === "dark" ? "light" : "dark"} mode`}
          onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
        >
          {theme === "dark" ? (
            <Sun size={14} className="shrink-0 text-neutral-400 dark:text-white/50" />
          ) : (
            <Moon size={14} className="shrink-0 text-neutral-400 dark:text-white/50" />
          )}
          <span>{theme === "dark" ? "Light mode" : "Dark mode"}</span>
        </button>
      </OverlayMenuSection>
    </OverlayMenu>
  );
}
