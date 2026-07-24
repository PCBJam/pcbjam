import { Eye } from "lucide-react";
import type { PresencePeer } from "@/wasm/collab/presence";
import type { FollowTarget } from "@/wasm/collab/follow-user";
import { overlayRowClass } from "@/components/OverlayMenu";

/**
 * "Who else is in this file" (collab-presence 0001/0003), as a readable LIST.
 *
 * This used to be a facepile — overlapping 20px circles showing one initial
 * each. That is a fine density trade in a cramped toolbar, but it lives in the
 * overlay menu now (0010), which is 288px wide: there is room for names, and a
 * row of colored initials told you neither who was here nor that clicking one
 * followed them. One row per person instead: color dot, name, where they are,
 * and an explicit follow affordance.
 *
 * For eeschema (per-sheet rooms) peers on a DIFFERENT sheet are dimmed, say
 * which sheet they're on, and are not followable — following someone you cannot
 * see would just teleport you.
 *
 * Follow-user (0008): clicking a same-sheet peer follows their viewport; the
 * followed peer's row stays highlighted with a "Stop" action, so the state and
 * its exit live on the same row (the parent no longer renders a separate
 * "Following…" banner).
 */
const MAX_ROWS = 6;

function sheetLabel(sheetPath?: string): string {
  if (!sheetPath) return "";
  const base = sheetPath.split("/").pop() ?? sheetPath;
  return base.replace(/\.kicad_sch$/, "");
}

export function PresenceRoster({
  peers,
  activeSheetPath,
  following,
  onFollow,
}: {
  peers: PresencePeer[];
  /** eeschema: the sheet THIS client is on — peers elsewhere render dimmed. */
  activeSheetPath?: string;
  /** 0008: the followed client, when a follow is active. */
  following?: FollowTarget | null;
  /** 0008: toggle following a peer (null = stop). Absent = follow UI off. */
  onFollow?: (target: FollowTarget | null) => void;
}) {
  if (!peers.length) return null;

  const sameSheet = (p: PresencePeer) =>
    (p.sheetPath ?? undefined) === (activeSheetPath ?? undefined);
  // Same-sheet peers first, then elsewhere (dimmed) — stable within each group.
  const ordered = [...peers].sort(
    (a, b) => Number(sameSheet(b)) - Number(sameSheet(a)),
  );
  const shown = ordered.slice(0, MAX_ROWS);

  const followable = (p: PresencePeer) => !!onFollow && sameSheet(p);
  const isFollowed = (p: PresencePeer) => following?.clientId === p.clientId;

  const toggleFollow = (p: PresencePeer) => {
    if (!onFollow) return;
    onFollow(
      isFollowed(p)
        ? null
        : { clientId: p.clientId, userId: p.user.id, name: p.user.name },
    );
  };

  return (
    <div data-testid="presence-roster" className="flex w-full flex-col">
      {shown.map((p) => {
        const here = sameSheet(p);
        const followed = isFollowed(p);
        const elsewhere = sheetLabel(p.sheetPath) || "another sheet";
        return (
          <button
            key={p.user.id}
            type="button"
            data-presence-user={p.user.id}
            data-presence-elsewhere={here ? undefined : "1"}
            data-presence-following={followed ? "1" : undefined}
            disabled={!followable(p)}
            onClick={() => toggleFollow(p)}
            title={
              here
                ? onFollow
                  ? followed
                    ? `${p.user.name} — click to stop following`
                    : `${p.user.name} — click to follow their view`
                  : p.user.name
                : `${p.user.name} — on ${elsewhere}`
            }
            className={`${overlayRowClass} ${
              followed ? "bg-black/10 dark:bg-white/10" : ""
            } ${here ? "" : "cursor-default opacity-50 hover:bg-transparent"}`}
          >
            <span
              aria-hidden
              className="h-2.5 w-2.5 shrink-0 rounded-full ring-1 ring-inset ring-black/40"
              style={{ backgroundColor: p.user.color }}
            />
            <span className="truncate">{p.user.name}</span>
            {!here && (
              <span className="ml-auto shrink-0 truncate text-[10px] text-neutral-400 dark:text-white/40">
                on {elsewhere}
              </span>
            )}
            {here && followed && (
              <span className="ml-auto flex shrink-0 items-center gap-1 text-[10px] font-medium text-neutral-600 dark:text-white/70">
                <Eye size={12} /> Stop
              </span>
            )}
            {here && !followed && followable(p) && (
              <span className="ml-auto shrink-0 text-[10px] text-neutral-400 dark:text-white/35">
                Follow
              </span>
            )}
          </button>
        );
      })}
      {peers.length > MAX_ROWS && (
        <span className="px-2 py-1 text-[10px] text-neutral-400 dark:text-white/40">
          +{peers.length - MAX_ROWS} more
        </span>
      )}
    </div>
  );
}
