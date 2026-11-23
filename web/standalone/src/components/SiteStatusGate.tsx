import { useEffect, useState } from "react";
import { SiteStatusBar, SiteStatusOverlay } from "@pcbjam/ui";
import type { SiteView } from "@pcbjam/shared/site-status";
import { APP_URL } from "@/lib/config";
import { siteStatus } from "@/lib/site-status";

function useSiteView(): SiteView {
  const [view, setView] = useState<SiteView>(() => siteStatus.getView());
  useEffect(() => {
    setView(siteStatus.getView());
    return siteStatus.subscribe(setView);
  }, []);
  return view;
}

/**
 * pcbjam-private admin 0009: the maintenance bar (top, above the editor), the
 * one-minute dialog and the full-screen maintenance / reload screens. The
 * wasm editor stays mounted underneath; while a screen shows, its sockets are
 * closed and the API refuses its requests.
 */
export function SiteStatusGate() {
  const view = useSiteView();
  const app = APP_URL?.replace(/\/$/, "") ?? null;
  return (
    <>
      {view.kind !== "ok" && (
        <div className="fixed inset-x-0 top-0 z-[2147482000]">
          <SiteStatusBar view={view} adminHref={app ? `${app}/admin/downtime` : undefined} />
        </div>
      )}
      <SiteStatusOverlay
        view={view}
        logo={
          <span className="inline-flex items-center gap-2.5 text-2xl font-semibold tracking-tight">
            <img src="/favicon.svg" alt="" className="h-8 w-auto" />
            PCBJam
          </span>
        }
        signInHref={app ? `${app}/login?maintenance=1&returnTo=%2Fadmin%2Fdowntime` : undefined}
        onCheck={() => siteStatus.refresh()}
        onReload={() => window.location.reload()}
      />
    </>
  );
}
