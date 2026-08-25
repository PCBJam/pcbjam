// Extracted from WasmTool.tsx (2026-08-25 split) — behavior unchanged.

/**
 * Terminal failure — z-35, ABOVE the boot overlay but below the console panel,
 * OUTSIDE the error boundary, and independent of `ready`: a post-boot runtime
 * death gets a proper blue screen instead of a blank page, with the console
 * panel forced open beneath it.
 */
export function FatalOverlay({ message }: { message: string }) {
  return (
    <div
      data-testid="fatal-overlay"
      className="absolute inset-0 z-[35] flex flex-col items-center justify-center gap-3 bg-[#1a1a2e] text-white"
    >
      <p className="font-mono text-4xl text-white/90">:(</p>
      <p className="font-mono text-sm text-white">
        The editor hit an unrecoverable error and stopped.
      </p>
      <p className="max-w-lg px-6 text-center font-mono text-xs text-blue-100/90">
        {message}
      </p>
      <p className="max-w-md px-6 text-center font-mono text-xs text-blue-200/60">
        The console below records what was loading when this happened —
        please copy it into a bug report.
      </p>
      <div className="flex gap-2">
        <button
          className="rounded border border-white/40 px-3 py-1 text-xs hover:bg-white/10"
          onClick={() => window.location.reload()}
        >
          Reload
        </button>
      </div>
    </div>
  );
}
