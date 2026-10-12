// Extracted from WasmTool.tsx (2026-08-25 split) — behavior unchanged.
import * as React from "react";
import { ChevronDown, ChevronUp } from "lucide-react";
import { Button } from "@pcbjam/ui";

/**
 * The editor's log console. z-40 (above the z-30 boot overlay and the z-35
 * fatal overlay): when a load fails, the log this panel holds is the only
 * account of WHY, so it must never end up underneath the thing reporting the
 * failure. Closed: a content-width tab pinned bottom-left (no right-0), so the
 * version badge and the app's bottom edge stay visible/clickable. Open: the
 * full-width footer panel. `panelRef` lets WasmTool detect log-text selections
 * for its Ctrl/Cmd+C interception.
 */
export const ConsolePanel = React.forwardRef<
  HTMLDivElement,
  {
    logs: string[];
    open: boolean;
    setOpen: (v: boolean) => void;
    /** Append a line to the log (used for the copy outcome). */
    append: (msg: string) => void;
  }
>(function ConsolePanel({ logs, open, setOpen, append }, ref) {
  return (
    <div
      ref={ref}
      className={open ? "absolute bottom-0 left-0 right-0 z-40" : "absolute bottom-0 left-0 z-40"}
    >
      {open ? (
        <>
          <div className="flex items-center bg-black/70">
            <Button
              variant="plain"
              size="text"
              className="px-3 py-1 font-mono text-xs text-white"
              onClick={() => setOpen(false)}
            >
              <ChevronDown size={14} /> console ({logs.length})
            </Button>
            <Button
              variant="plain"
              size="text"
              className="ml-auto px-3 py-1 font-mono text-xs text-white/70 hover:text-white"
              onClick={() => {
                void navigator.clipboard.writeText(logs.join("\n")).then(
                  () => append("[console] copied to clipboard"),
                  () => append("[console] clipboard copy failed"),
                );
              }}
            >
              copy
            </Button>
          </div>
          <pre className="max-h-64 select-text cursor-text overflow-auto bg-black/85 p-3 font-mono text-[11px] leading-tight text-green-300">
            {logs.join("\n")}
          </pre>
        </>
      ) : (
        <Button
          variant="plain"
          size="text"
          className="flex rounded-none bg-black/70 px-3 py-1 font-mono text-xs text-white"
          onClick={() => setOpen(true)}
        >
          <ChevronUp size={14} /> console ({logs.length})
        </Button>
      )}
    </div>
  );
});
