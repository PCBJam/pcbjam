import * as React from "react";
import { X } from "lucide-react";
import { Button } from "@pcbjam/ui";
import { BlockingDialog } from "./BlockingDialog";
import { probeCapabilities, type CapabilityReport } from "./capabilities";
import { isMobileMode } from "@/lib/mobile-mode";

/**
 * Wraps the tool boot with a device-capability check (feature 0001). On mount it
 * runs `probeCapabilities()` exactly once and decides:
 *
 *   - no issues   → render `children` immediately (boot proceeds).
 *   - warnings    → render `children` + a dismissible advisory banner overlay.
 *   - any fatal   → render a blocking dialog INSTEAD of `children` (so the
 *                   expensive WASM asset fetch is short-circuited), with a
 *                   "Try anyway" override that then renders `children`.
 *
 * The override decision (user): warn but allow proceeding in every case.
 */

const DISMISS_PREFIX = "pcbjam:preflight:dismissed:";

/** Dismissal is keyed to the exact set of warning codes seen, so a new kind of
 * warning still shows even after the user dismissed a previous one. */
function dismissKey(report: CapabilityReport): string {
  const codes = report.warnings.map((w) => w.code).sort();
  return DISMISS_PREFIX + codes.join(",");
}

function readDismissed(key: string): boolean {
  try {
    return localStorage.getItem(key) === "1";
  } catch {
    return false;
  }
}

export function PreflightGate({ children }: { children: React.ReactNode }) {
  // Probe once; capabilities don't change within a page load. In mobile mode
  // (features/mobile) the warnings inherent to BEING mobile are noise — the
  // user is deliberately here — so drop them; real fatals still block.
  const [report] = React.useState<CapabilityReport>(() => {
    const r = probeCapabilities();
    if (!isMobileMode()) return r;
    return {
      ...r,
      warnings: r.warnings.filter(
        (w) => w.code !== "mobile" && w.code !== "small-screen",
      ),
    };
  });
  const [override, setOverride] = React.useState(false);
  const key = dismissKey(report);
  const [bannerHidden, setBannerHidden] = React.useState(() => readDismissed(key));

  const hasFatal = report.fatal.length > 0;
  const hasWarnings = report.warnings.length > 0;

  // Fatal + not yet overridden: block before children mount (no asset fetch).
  if (hasFatal && !override) {
    return (
      <BlockingDialog
        title="This device can't run the editor"
        description="We detected one or more requirements that aren't met. You can try anyway, but the editor will most likely fail to start."
        reasons={report.fatal.map((f) => ({ title: f.title, detail: f.detail }))}
        primary={{ label: "Try anyway", variant: "destructive", onClick: () => setOverride(true) }}
      />
    );
  }

  const showBanner = hasWarnings && !bannerHidden;

  return (
    <>
      {showBanner && (
        <PreflightBanner
          report={report}
          onDismiss={() => setBannerHidden(true)}
          onDontShowAgain={() => {
            try {
              localStorage.setItem(key, "1");
            } catch {
              /* private mode / storage disabled — dismiss for this session only */
            }
            setBannerHidden(true);
          }}
        />
      )}
      {children}
    </>
  );
}

function PreflightBanner({
  report,
  onDismiss,
  onDontShowAgain,
}: {
  report: CapabilityReport;
  onDismiss: () => void;
  onDontShowAgain: () => void;
}) {
  return (
    <div className="pointer-events-auto fixed inset-x-0 top-0 z-30 border-b border-amber-500/40 bg-amber-950/90 px-4 py-3 text-amber-100 shadow-lg backdrop-blur">
      <div className="mx-auto flex max-w-3xl items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold">
            This device may struggle to run the editor
          </div>
          <ul className="mt-1 list-disc space-y-0.5 pl-5 text-xs text-amber-200/90">
            {report.warnings.map((w) => (
              <li key={w.code}>
                <span className="font-medium">{w.title}:</span> {w.detail}
              </li>
            ))}
          </ul>
          <div className="mt-2 flex gap-2">
            <Button size="sm" variant="secondary" onClick={onDontShowAgain}>
              Don't show again
            </Button>
          </div>
        </div>
        <button
          type="button"
          aria-label="Dismiss"
          onClick={onDismiss}
          className="rounded-sm opacity-70 transition-opacity hover:opacity-100"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}
