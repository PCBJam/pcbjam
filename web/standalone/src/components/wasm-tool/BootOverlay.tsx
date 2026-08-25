// Extracted from WasmTool.tsx (2026-08-25 split) — behavior unchanged.
import { Loader2 } from "lucide-react";
import { setAutoDownloadEnabled } from "@/wasm/wasm-assets";
import { DownloadConsent, DownloadProgress, libSyncLabel, type ConsentInfo } from "./DownloadConsent";

/**
 * Boot overlay — covers the big WASM download/compile freeze until the tool
 * has booted + opened: the error state, the download-consent card, or the
 * spinner with download / staging / lib warm-up progress and the "taking
 * too long" hint.
 */
export function BootOverlay({
  status,
  consent,
  onConsentAccept,
  progress,
  fileSync,
  libSync,
  warmBoot,
  slow,
}: {
  status: string;
  consent: ConsentInfo | null;
  /** The consent card's OK — resolves the boot's gate. */
  onConsentAccept: () => void;
  progress: { loaded: number; total: number } | null;
  fileSync: { done: number; total: number } | null;
  libSync: { kind: string; done: number; total: number } | null;
  warmBoot: boolean;
  slow: boolean;
}) {
  return (
    <div className="absolute inset-0 z-30 flex flex-col items-center justify-center gap-3 bg-[#1a1a2e] text-white">
      {status.startsWith("Error") ? (
        <>
          <p className="max-w-md px-6 text-center font-mono text-sm text-red-300">
            {status}
          </p>
          <button
            className="rounded border border-white/30 px-3 py-1 text-xs hover:bg-white/10"
            onClick={() => window.location.reload()}
          >
            Reload
          </button>
        </>
      ) : consent ? (
        <DownloadConsent
          info={consent}
          onAccept={(always) => {
            if (always) setAutoDownloadEnabled(true);
            onConsentAccept();
          }}
        />
      ) : (
        <>
          <Loader2 className="animate-spin" size={32} />
          <p className="font-mono text-sm text-white/80">
            {status || "Loading…"}
          </p>
          <DownloadProgress progress={progress} />
          {/* The parallel fan-out's other progress: project files staging
              into MEMFS, and the lib warm-up. The lib line says "checking"
              on purpose — the walk visits every lib but downloads only new
              or changed ones, so a bare 15/155 next to the consent dialog's
              MB figures would read as 155 big downloads. */}
          {fileSync && fileSync.total > 0 && (
            <p className="whitespace-pre font-mono text-xs text-white/50">
              Project files — {String(fileSync.done).padStart(String(fileSync.total).length, " ")}/{fileSync.total}
            </p>
          )}
          {libSync && (
            <p className="whitespace-pre font-mono text-xs text-white/50">
              {libSyncLabel(libSync)}
            </p>
          )}
          <p className="font-mono text-xs text-white/40">
            {warmBoot
              ? "Loading from your browser's cache — no download needed."
              : "Downloading the editor — it's cached for future visits."}
          </p>
          {slow && (
            <>
              <p className="max-w-sm px-6 text-center font-mono text-xs text-amber-300/90">
                This is taking longer than usual — a slow connection, or
                something may be wrong. You can keep waiting, or reload.
              </p>
              <button
                className="rounded border border-white/30 px-3 py-1 text-xs hover:bg-white/10"
                onClick={() => window.location.reload()}
              >
                Reload
              </button>
            </>
          )}
        </>
      )}
    </div>
  );
}
