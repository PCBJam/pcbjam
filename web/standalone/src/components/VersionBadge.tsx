import { ExternalLink, Github } from "lucide-react";
import { APP_GIT_SHA, APP_TAG, LANDING_URL, REPO_URL } from "@/lib/config";

/**
 * Small bottom-right overlay showing this build's version + a link to the
 * source. The standalone is GPLv3, so the tag links to the exact commit
 * (corresponding-source pointer — the repo commit pins the kicad + wxwidgets
 * submodule revisions) when known, else the tag's release page, else the repo
 * root. Mounted app-wide (App.tsx) so it shows on the home page AND inside the
 * loaded editor. `fixed` keeps it viewport-anchored on every route; z-20 sits
 * under the editor's boot overlay (z-30) so it's hidden until the tool is up.
 */
/** Display form of a build tag: any embedded full commit hash shortens to the
 *  GitHub-style 7 chars ("staging-<40 hex>" → "staging-abc1234"); release tags
 *  ("2.7.7") pass through untouched. Display only — links keep the full sha. */
export function shortBuildTag(tag: string): string {
  return tag.replace(/\b[0-9a-f]{12,40}\b/i, (h) => h.slice(0, 7));
}

export function VersionBadge() {
  const tag = shortBuildTag(APP_TAG ?? "dev");
  const versionUrl = APP_GIT_SHA
    ? `${REPO_URL}/commit/${APP_GIT_SHA}`
    : APP_TAG
      ? `${REPO_URL}/releases/tag/${APP_TAG}`
      : REPO_URL;
  const versionTitle = APP_GIT_SHA
    ? `commit ${APP_GIT_SHA.slice(0, 12)} — GPL corresponding source`
    : APP_TAG
      ? `release ${APP_TAG}`
      : "source repository";

  return (
    <div className="fixed bottom-3 right-3 z-20 flex items-center gap-2 rounded bg-black/70 px-2.5 py-1 font-mono text-[11px] text-white/80 shadow">
      <a
        href={versionUrl}
        target="_blank"
        rel="noreferrer"
        title={versionTitle}
        className="hover:text-white"
      >
        pcbjam {tag}
      </a>
      <span className="text-white/30">·</span>
      <a
        href={REPO_URL}
        target="_blank"
        rel="noreferrer"
        title="Source on GitHub"
        className="inline-flex items-center gap-1 hover:text-white"
      >
        <Github size={12} /> source
      </a>
      <span className="text-white/30">·</span>
      <a
        href={LANDING_URL}
        target="_blank"
        rel="noreferrer"
        title="PCBJam — product page"
        className="inline-flex items-center gap-1 hover:text-white"
      >
        pcbjam.com <ExternalLink size={11} />
      </a>
    </div>
  );
}
