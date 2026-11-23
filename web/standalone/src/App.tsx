import { useEffect } from "react";
import { Route, Routes, useLocation } from "react-router-dom";
import { VersionBadge } from "@/components/VersionBadge";
import { SiteStatusGate } from "@/components/SiteStatusGate";
import { useChromeHidden } from "@/lib/chrome-visibility";
import { APP_URL } from "@/lib/config";
import { redirectTargetFor } from "@/lib/redirect";
import { HomePage } from "@/pages/HomePage";
import { LibToolPage } from "@/pages/LibToolPage";
import { ProjectView } from "@/pages/ProjectView";
import { ToolPage } from "@/pages/ToolPage";

export default function App() {
  const chromeHidden = useChromeHidden();
  // Non-editor redirect (standalone-hardening 0006): on a deploy with a
  // companion mgmt app, every surface the editor doesn't own bounces there
  // before any route renders. Covers in-SPA navigations too (useLocation).
  const location = useLocation();
  const target = redirectTargetFor(APP_URL, location.pathname, location.search);
  useEffect(() => {
    if (target) window.location.replace(target);
  }, [target]);
  if (target) return null;
  return (
    <>
      <Routes>
        <Route path="/" element={<HomePage />} />
        {/* scope/kind/name grammar (see @pcbjam/shared routes.ts). The tool is
            inferred from the file (or lib kind); `-/:tool` boots a fileless tool. */}
        <Route path="/:scope/projects/:name" element={<ProjectView />} />
        <Route path="/:scope/projects/:name/-/:tool" element={<ToolPage />} />
        <Route path="/:scope/projects/:name/*" element={<ToolPage />} />
        <Route path="/:scope/libs/:name" element={<LibToolPage />} />
      </Routes>
      {/* Version + source link, bottom-right on every route (home + editor).
          Keys off the Figma-like hide-UI toggle (hidden is the mobile default). */}
      {!chromeHidden && <VersionBadge />}
      {/* Maintenance window / reload required (pcbjam-private admin 0009). */}
      <SiteStatusGate />
    </>
  );
}
