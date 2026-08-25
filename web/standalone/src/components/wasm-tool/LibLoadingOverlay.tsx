// Extracted from WasmTool.tsx (2026-08-25 split) — behavior unchanged.
import { Loader2 } from "lucide-react";
import type { LibLoadingState } from "./useLibNotices";

/**
 * Eager library load overlay — the first chooser/editor open hydrates the
 * whole library set from IDB into wasm (tens of seconds on the full CDN set)
 * with the main thread blocked. Cover the (frozen) editor so it reads as
 * "loading, just slow" rather than a hang. Shown post-boot; before `ready`
 * the boot overlay already covers it.
 */
export function LibLoadingOverlay({ libLoading }: { libLoading: LibLoadingState }) {
  return (
    <div className="absolute inset-0 z-30 flex flex-col items-center justify-center gap-3 bg-[#1a1a2e]/95 text-white">
      <Loader2 className="animate-spin" size={32} />
      <p className="font-mono text-sm text-white/80">
        {libLoading.kind === "library"
          ? "Loading libraries…"
          : `Loading ${libLoading.kind} libraries…`}
      </p>
      {libLoading.total > 0 && (
        <div className="w-64 max-w-[70vw]">
          <div className="h-1.5 overflow-hidden rounded-full bg-white/15">
            <div
              className="h-full rounded-full bg-emerald-400 transition-[width] duration-200 ease-out"
              style={{
                width: `${Math.min(100, Math.round((libLoading.done / libLoading.total) * 100))}%`,
              }}
            />
          </div>
          {/* Space-pad `done` to `total`'s width so the centered line
              doesn't shift as the count gains a digit. */}
          <p className="mt-1 whitespace-pre text-center font-mono text-[11px] text-white/50">
            {String(Math.min(libLoading.done, libLoading.total)).padStart(
              String(libLoading.total).length,
              " ",
            )}{" "}
            / {libLoading.total} libraries
          </p>
        </div>
      )}
      <p className="max-w-sm px-6 text-center font-mono text-xs text-white/40">
        Moving the library set into the editor. The first open can take a
        moment — it's cached after this.
      </p>
    </div>
  );
}
