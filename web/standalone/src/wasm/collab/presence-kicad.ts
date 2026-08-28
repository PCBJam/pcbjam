import { symbolUuidFromFootprintPath } from "@pcbjam/shared";
import { clog } from "./debug";
import { publishLocalSelection } from "./local-selection";
import type { PresenceHandle, PresencePeer } from "./presence";
import type { CrossAppHandle } from "./cross-app";
import { contestedReleases, remoteLocks, type LockClient } from "./lock-tiebreak";

/**
 * Wire the C++ presence bridge (collab-presence 0002) to the awareness layer:
 *
 *   C++ → awareness: `window.kicadCollab.onSelection/onCursor` (this tab's
 *   selection uuids + world-coord cursor, emitted by the wasm input hooks)
 *   publish into the room via the presence handle's setters.
 *
 *   awareness → C++: on every peers change, push a full remote snapshot to
 *   `Module.kicadCollabSetRemote` — the wasm side clears + redraws its
 *   VIEW_OVERLAY from it (idempotent), so no delta bookkeeping is needed.
 *   Pushes are trailing-throttled: N peers × 20 cursor updates/s must not
 *   cross the JS↔wasm boundary per event.
 *
 *   `onViewport` (world↔screen transform) feeds an optional callback for the
 *   DOM layers (comment pins, 0005); the roster doesn't need it.
 */

export interface PresenceKicadModule {
  kicadCollabPresenceStart(): void;
  kicadCollabSetRemote(json: string): void;
  kicadCollabGetViewport(): string;
  kicadCollabGetSelection(): string;
  /** 0006 (pcbnew builds): `{uuids, fpPaths}` — uuids plus the selected
   *  footprints' schematic paths. Absent on older wasm. */
  kicadCollabGetSelectionFull?(): string;
  /** 0007: tiebreak release — the local client lost an overlapping hold;
   *  the wasm side cancels an in-flight move and unselects exactly these. */
  kicadCollabReleaseSelection?(uuidsJson: string, holder: string): void;
  /** 0008: fit a leader's world rect (center + half-extents, IU) into this
   *  canvas — contain semantics. Absent on older wasm builds. */
  kicadCollabFitViewport?(cx: number, cy: number, halfW: number, halfH: number): void;
  /** Findings Y-4: cursor-only update `{cursors:[{id, cursor}]}` for peers
   *  already known from the last full snapshot — the wasm side repaints only
   *  the cursor overlays, not every selection outline. Absent on older wasm. */
  kicadCollabSetRemoteCursors?(json: string): void;
}

export interface PresenceKicadWindow {
  kicadCollab?: {
    onSelection?: (uuidsJson: string) => void;
    onCursor?: (x: number, y: number, active: number) => void;
    onViewport?: (cx: number, cy: number, scale: number, w: number, h: number) => void;
  };
}

/** The GAL viewport transform: world center (IU), pixels-per-IU scale, px size. */
export interface ViewportState {
  cx: number;
  cy: number;
  scale: number;
  w: number;
  h: number;
}

/** True when the loaded wasm exposes the presence bridge (0002 exports). */
export function hasPresenceBridge(mod: unknown): mod is PresenceKicadModule {
  const m = mod as Partial<PresenceKicadModule> | undefined;
  return (
    typeof m?.kicadCollabPresenceStart === "function" &&
    typeof m?.kicadCollabSetRemote === "function"
  );
}

const PUSH_THROTTLE_MS = 30;

// Viewport publishes ride awareness at their own (slower) trailing cadence —
// a smooth pan fires onViewport per frame and peers only need follow-rate.
const VIEWPORT_PUBLISH_MS = 100;

/** The follow-user world rect for a GAL transform: half-extents = half the
 *  canvas in world units (scale = px per IU). Null while the frame is not up
 *  (zero-sized canvas / no scale yet). */
export function viewportRect(
  vp: ViewportState,
): { cx: number; cy: number; halfW: number; halfH: number } | null {
  if (!(vp.scale > 0) || !(vp.w > 0) || !(vp.h > 0)) return null;
  return { cx: vp.cx, cy: vp.cy, halfW: vp.w / 2 / vp.scale, halfH: vp.h / 2 / vp.scale };
}

/**
 * Parse a C++ selection emit (0006): pcbnew emits `{uuids, fpPaths}` (paths =
 * the selected footprints' `GetPath()` strings), eeschema and older builds a
 * bare uuid array. Returns null on a malformed payload (callers then keep the
 * last published selection, the pre-0006 behavior).
 */
export function parseSelectionEmit(
  json: string,
): { uuids: string[]; fpPaths?: string[] } | null {
  try {
    const v: unknown = JSON.parse(json);
    if (Array.isArray(v)) {
      return { uuids: v.filter((u): u is string => typeof u === "string") };
    }
    if (v && typeof v === "object") {
      const o = v as { uuids?: unknown; fpPaths?: unknown };
      return {
        uuids: Array.isArray(o.uuids)
          ? o.uuids.filter((u): u is string => typeof u === "string")
          : [],
        ...(Array.isArray(o.fpPaths)
          ? { fpPaths: o.fpPaths.filter((p): p is string => typeof p === "string") }
          : {}),
      };
    }
  } catch {
    /* malformed */
  }
  return null;
}

/**
 * The cross-app highlight targets a peer's state maps to in THIS editor
 * (0006): a pcbnew peer's footprint paths become symbol uuids (eeschema
 * resolves them directly); an eeschema peer's selection uuids ARE the symbol
 * uuids (pcbnew suffix-matches them against footprint paths). Tools without
 * a counterpart map to nothing.
 */
export function xselFromPeerState(state: {
  tool: string;
  selection: string[];
  selectionPaths?: string[];
}): string[] {
  if (state.tool === "pcbnew") {
    return (state.selectionPaths ?? [])
      .map(symbolUuidFromFootprintPath)
      .filter((u): u is string => u !== null);
  }
  if (state.tool === "eeschema") return state.selection;
  return [];
}

const TOOL_TAG: Record<string, string> = { pcbnew: "pcb", eeschema: "sch" };

export function bindKicadPresence(opts: {
  mod: PresenceKicadModule;
  win: PresenceKicadWindow;
  presence: PresenceHandle;
  /** 0006: the project presence room — cross-app selection in/out. */
  crossApp?: CrossAppHandle;
  onViewport?: (vp: ViewportState) => void;
}): { destroy(): void } {
  const { mod, win, presence, crossApp } = opts;

  // The local selection as last emitted by C++ — the tiebreak (0007) compares
  // it against every other client's published selection.
  let ownSelection: string[] = [];

  // C++ → awareness ------------------------------------------------------------
  win.kicadCollab = {
    ...win.kicadCollab,
    onSelection: (uuidsJson) => {
      const parsed = parseSelectionEmit(uuidsJson);
      if (!parsed) return; // malformed emit — keep the last published selection
      ownSelection = parsed.uuids;
      presence.setSelection(parsed.uuids);
      crossApp?.setSelection(parsed.uuids, parsed.fpPaths);
      // Local mirror (viewer-panels): the SelectionInspector renders from it.
      publishLocalSelection(parsed);
    },
    onCursor: (x, y, active) => {
      presence.setCursor(active ? { x, y } : null);
    },
    onViewport: (cx, cy, scale, w, h) => {
      const vp = { cx, cy, scale, w, h };
      opts.onViewport?.(vp);
      scheduleViewportPublish(vp);
    },
  };

  // Follow-user (0008): publish the visible world rect, trailing-throttled.
  let vpTimer: ReturnType<typeof setTimeout> | undefined;
  let vpLatest: ViewportState | undefined;
  const scheduleViewportPublish = (vp: ViewportState) => {
    vpLatest = vp;
    if (vpTimer) return;
    vpTimer = setTimeout(() => {
      vpTimer = undefined;
      // Guarded: pre-0008 handle implementations (and their test fakes) don't
      // have setViewport yet.
      if (vpLatest && typeof presence.setViewport === "function") {
        presence.setViewport(viewportRect(vpLatest));
      }
    }, VIEWPORT_PUBLISH_MS);
  };

  // Seed the published viewport (pushes only happen on input events after
  // this) — same pull the comment layer uses.
  try {
    const vp = JSON.parse(mod.kicadCollabGetViewport() || "null") as ViewportState | null;
    if (vp && vp.w > 0) scheduleViewportPublish(vp);
  } catch {
    /* frame not up yet — the first input push seeds it */
  }

  // Seed: the tab may attach with a selection already made (e.g. rebind). The
  // Full variant (pcbnew 0006) also carries footprint paths for cross-app.
  try {
    const seed = parseSelectionEmit(
      (mod.kicadCollabGetSelectionFull?.() ?? mod.kicadCollabGetSelection()) || "[]",
    );
    if (seed?.uuids.length) {
      ownSelection = seed.uuids;
      presence.setSelection(seed.uuids);
      crossApp?.setSelection(seed.uuids, seed.fpPaths);
      publishLocalSelection(seed);
    }
  } catch {
    /* bridge present but frame not up yet — the first emit will seed */
  }

  // awareness → C++ ------------------------------------------------------------
  // The last full snapshot's "shape" signature (everything except cursors):
  // while it is unchanged, awareness changes are cursor ticks and go through
  // the cheap cursor-only entry point (findings Y-4 — a select-all peer's
  // 20 Hz cursor must not re-resolve + redraw 3000 outlines per tick).
  let lastShapeSig = "";
  const pushRemote = () => {
    const peers = presence.peers();
    const snapshot: {
      peers: Array<{
        id: string;
        name: string;
        color: string;
        cursor: { x: number; y: number } | null;
        selection: string[];
        xsel?: string[];
      }>;
      locks?: Array<{ uuid: string; name: string }>;
    } = {
      peers: peers.map((p: PresencePeer) => ({
        id: p.user.id,
        name: p.user.name,
        color: p.user.color,
        cursor: finiteCursor(p.cursor),
        selection: p.selection,
      })),
    };
    // Soft-locks (0007): every OTHER client's held uuids (own user's other
    // tabs included — presence.clients(), not the user-deduped peers()),
    // minus what we hold and win. Losing overlaps trigger a release.
    const self = { ...presence.self(), selection: ownSelection };
    const lockClients: LockClient[] = presence.clients().map((c) => ({
      userId: c.user.id,
      clientId: c.clientId,
      name: c.user.name,
      selection: c.selection,
    }));
    snapshot.locks = remoteLocks(self, lockClients);
    const release = contestedReleases(self, lockClients);
    if (release && mod.kicadCollabReleaseSelection) {
      clog("presence-kicad: lost selection tiebreak to", release.holder, "—", release.uuids);
      mod.kicadCollabReleaseSelection(JSON.stringify(release.uuids), release.holder);
    }
    // Cross-app peers (0006): rendered as ghost outlines on the mapped items.
    // One entry per awareness CLIENT (own other tabs included — that's the
    // single-user cross-probe), tagged with the source editor.
    for (const p of crossApp?.peers() ?? []) {
      const xsel = xselFromPeerState(p.state);
      if (!xsel.length) continue;
      snapshot.peers.push({
        id: `${p.state.user.id}#x${p.clientId}`,
        name: `${p.state.user.name} · ${TOOL_TAG[p.state.tool] ?? p.state.tool}`,
        color: p.state.user.color,
        cursor: null,
        selection: [],
        xsel,
      });
    }
    const shapeSig = JSON.stringify({
      peers: snapshot.peers.map((p) => [p.id, p.name, p.color, p.selection, p.xsel ?? null]),
      locks: snapshot.locks,
    });
    if (shapeSig === lastShapeSig && mod.kicadCollabSetRemoteCursors) {
      mod.kicadCollabSetRemoteCursors(
        JSON.stringify({ cursors: snapshot.peers.map((p) => ({ id: p.id, cursor: p.cursor })) }),
      );
      return;
    }
    lastShapeSig = shapeSig;
    mod.kicadCollabSetRemote(JSON.stringify(snapshot));
  };

  let pushTimer: ReturnType<typeof setTimeout> | undefined;
  const schedulePush = () => {
    if (pushTimer) return;
    pushTimer = setTimeout(() => {
      pushTimer = undefined;
      pushRemote();
    }, PUSH_THROTTLE_MS);
  };

  const unsubscribe = presence.subscribe(schedulePush);
  const unsubscribeCross = crossApp?.subscribe(schedulePush);

  mod.kicadCollabPresenceStart();
  pushRemote();
  clog("presence-kicad: bridge bound (cursor/selection emit + remote overlay)");

  return {
    destroy() {
      unsubscribe();
      unsubscribeCross?.();
      if (pushTimer) clearTimeout(pushTimer);
      pushTimer = undefined;
      if (vpTimer) clearTimeout(vpTimer);
      vpTimer = undefined;
      if (win.kicadCollab) {
        delete win.kicadCollab.onSelection;
        delete win.kicadCollab.onCursor;
        delete win.kicadCollab.onViewport;
      }
      // Clear the remote overlay so a dead session leaves no ghost cursors.
      try {
        mod.kicadCollabSetRemote(JSON.stringify({ peers: [] }));
      } catch {
        /* wasm may already be gone on page teardown */
      }
    },
  };
}

/** Findings W-4: a non-finite peer cursor would serialize as JSON null and
 *  throw inside kicadCollabSetRemote / SetRemoteCursors — treat it as absent. */
function finiteCursor(c: { x: number; y: number } | null | undefined): { x: number; y: number } | null {
  return c && Number.isFinite(c.x) && Number.isFinite(c.y) ? c : null;
}
