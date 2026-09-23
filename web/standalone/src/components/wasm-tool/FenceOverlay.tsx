/**
 * Generation fence (git-integration 0004 §E): the working copy this tab was
 * booted on was updated underneath it (its base changed), so the gateway
 * refused this session's generation. Nothing this tab does can reach the
 * server any more — saves are refused locally, rooms are dead, no reconnect —
 * and the only way on is a reload, which boots the new generation. The wasm
 * editor keeps running below so unsent work stays visible (and copyable /
 * exportable) until the user decides.
 *
 * Non-dismissable on purpose: dismissing would only hide the fact that the
 * next Ctrl+S silently goes nowhere.
 */
export const FENCE_TITLE = "This working copy was updated.";
export const FENCE_BODY = "Reload to continue; unsent edits stay in this tab.";
/** The save-flow status line while fenced (also the not-committed outcome). */
export const FENCE_SAVE_MESSAGE =
  "Save skipped: this working copy was updated — reload to continue";

export function FenceOverlay() {
  return (
    <div
      data-testid="fence-overlay"
      role="alertdialog"
      aria-labelledby="fence-title"
      className="absolute inset-x-0 top-0 z-[36] flex justify-center px-4 pt-4"
    >
      <div className="pointer-events-auto flex max-w-xl flex-col gap-2 rounded-lg border border-amber-400/60 bg-[#1a1a2e]/95 px-4 py-3 text-white shadow-lg">
        <p id="fence-title" className="font-mono text-sm font-semibold text-amber-200">
          {FENCE_TITLE}
        </p>
        <p className="font-mono text-xs text-white/80">{FENCE_BODY}</p>
        <div className="flex gap-2">
          <button
            data-testid="fence-reload"
            className="rounded border border-white/40 px-3 py-1 text-xs hover:bg-white/10"
            onClick={() => window.location.reload()}
          >
            Reload
          </button>
        </div>
      </div>
    </div>
  );
}
