import { ExternalLink, Megaphone } from "lucide-react";
import { Button } from "@pcbjam/ui";
import { APP_URL } from "@/lib/config";
import { OPEN_AI_CHAT, releaseDay, type WhatsNewState } from "@/lib/whats-new";
import { ProBadge, SidePanel } from "./SidePanel";

export const WHATS_NEW_PANEL = "pcbjam:whats-new-panel";

/**
 * What's new in the editor: a release's highlights, from its release file,
 * docked on the right until the person moves it. A release without highlights
 * shows its title and the link. The full notes, and every older release, are a link away in the web
 * app. A highlight about PCBJam AI gets a button that opens it right here
 * (`canOpenAi`: the person has it, or is offered it).
 */
export function WhatsNewPanel({
  state,
  version,
  canOpenAi,
  front,
  onFront,
  onOpenAi,
  onClose,
}: {
  state: WhatsNewState;
  /** The release it was opened for (settled before the notes were marked seen); the newest without one. */
  version: string | null;
  canOpenAi: boolean;
  front: boolean;
  onFront: () => void;
  onOpenAi: () => void;
  onClose: () => void;
}) {
  const release = state.releases.find((r) => r.version === version) ?? state.releases[0];
  if (!release) return null;
  const muted = "text-neutral-500 dark:text-white/55";
  return (
    <SidePanel
      id={WHATS_NEW_PANEL}
      title="What's new"
      testId="whats-new-panel"
      home="right"
      beside
      front={front}
      onFront={onFront}
      icon={<Megaphone size={14} className="shrink-0 text-neutral-400 dark:text-white/50" />}
      badge={<span className={`font-normal ${muted}`}>{release.version}</span>}
      onClose={onClose}
    >
      <div className="flex flex-col gap-4 px-4 pb-4 pt-1 text-xs">
        <div className="flex flex-col gap-0.5">
          <h2 className="text-sm font-semibold leading-snug">{release.title}</h2>
          <p className={muted}>{releaseDay(release.date)}</p>
        </div>

        {release.highlights.length > 0 && (
          <ul className="flex flex-col gap-4">
            {release.highlights.map((h) => (
              <li key={h.id} className="flex flex-col gap-1.5" data-testid={`whats-new-panel-${h.id}`}>
                <div className="flex items-center gap-2">
                  <h3 className="text-[13px] font-semibold">{h.title}</h3>
                  {h.plan === "pro" && <ProBadge />}
                </div>
                <p className="leading-relaxed text-neutral-700 dark:text-white/75">{h.text}</p>
                {h.action === OPEN_AI_CHAT && canOpenAi && (
                  <Button size="xs" className="self-start" onClick={onOpenAi} data-testid="whats-new-open-ai">
                    Open PCBJam AI
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}

        {APP_URL && (
          <a
            href={`${APP_URL}/whats-new/${encodeURIComponent(release.version)}`}
            target="_blank"
            rel="noopener noreferrer"
            data-testid="whats-new-all"
            className="flex items-center gap-1.5 self-start border-t border-black/10 pt-3 text-sky-700 underline-offset-2 hover:underline dark:border-white/10 dark:text-sky-300"
          >
            All release notes <ExternalLink size={12} aria-hidden="true" />
          </a>
        )}
      </div>
    </SidePanel>
  );
}
