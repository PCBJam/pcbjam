import * as React from "react";
import { ExternalLink, Loader2, Sparkles } from "lucide-react";
import { Button } from "@pcbjam/ui";
import { APP_URL } from "@/lib/config";
import { daysLeft, refreshPlan, startProTrial, usePlan } from "@/lib/plan";
import { whatsNew } from "@/lib/whats-new";
import { ProBadge, SidePanel } from "./SidePanel";

export const AI_OFFER_PANEL = "pcbjam:ai-offer-panel";

/** How often the panel asks for the chat once Pro is there, 4 seconds apart. */
const ARRIVAL_TRIES = 5;

const ASKS = ["Explain what this sheet does", "Find the datasheet for U4", "Tidy this block"];

/**
 * PCBJam AI for a Free account: where the chat would be, what it does and how
 * to get it. Drawn by the editor, not by the plugin, which a Free account
 * doesn't have. The offer is the account's own free trial while it may still
 * start one (no card; back on Free afterwards, nothing deleted), and the
 * billing page once the trial is used. `onStarted` runs once the account has
 * Pro: the caller loads the plugin and swaps this panel for the chat.
 */
export function AiOfferPanel({
  front,
  onFront,
  onStarted,
  onClose,
}: {
  front: boolean;
  onFront: () => void;
  onStarted: () => void;
  onClose: () => void;
}) {
  const plan = usePlan();
  const [starting, setStarting] = React.useState(false);
  const [started, setStarted] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const start = async () => {
    setStarting(true);
    setError(null);
    const refused = await startProTrial();
    void refreshPlan();
    setStarting(false);
    if (refused) setError(refused);
    else setStarted(true);
  };

  // Pro is theirs (the trial started here, or they came back from the billing page with it):
  // the caller loads the plugin and swaps this panel for the chat. Asked again a few times,
  // in case the first answer came before the plugin was handed out.
  const arriving = started || !!plan?.pro;
  const [tries, setTries] = React.useState(0);
  React.useEffect(() => {
    if (!arriving || tries >= ARRIVAL_TRIES) return;
    if (tries === 0) onStarted();
    const timer = window.setTimeout(() => {
      onStarted();
      setTries((n) => n + 1);
    }, 4000);
    return () => window.clearTimeout(timer);
  }, [arriving, tries, onStarted]);

  // Back from the billing page (it opens in another tab): the plan may have changed.
  React.useEffect(() => {
    const onFocus = () => {
      void refreshPlan();
      void whatsNew.refresh();
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, []);

  const billing = APP_URL ? `${APP_URL}/settings/billing` : null;
  const prices = plan ? `${plan.prices.month} a month or ${plan.prices.year} a year` : null;
  const trial = plan?.trial.eligible && plan.trial.days > 0 ? plan.trial : null;
  const muted = "text-neutral-500 dark:text-white/55";
  const box = "flex flex-col gap-2.5 rounded-lg bg-black/5 p-3 dark:bg-white/5";

  return (
    <SidePanel
      id={AI_OFFER_PANEL}
      title="PCBJam AI"
      testId="ai-offer-panel"
      front={front}
      onFront={onFront}
      icon={<Sparkles size={14} className="shrink-0 text-violet-500 dark:text-violet-300" />}
      badge={<ProBadge />}
      onClose={onClose}
    >
      <div className="flex flex-col gap-4 px-4 pb-4 pt-1 text-xs">
        <div className="flex flex-col gap-1.5">
          <h2 className="text-sm font-semibold leading-snug">An assistant that reads your design</h2>
          <p className="leading-relaxed text-neutral-700 dark:text-white/75">
            Ask about the open schematic or board, find datasheets, and let it draw and tidy circuits.
          </p>
        </div>

        {arriving && tries >= ARRIVAL_TRIES ? (
          <p role="status" data-testid="ai-offer-not-arrived">
            You have Pro now, but PCBJam AI did not open. Reload the page, then open it from the Session menu.
          </p>
        ) : arriving ? (
          <p className="flex items-center gap-2" role="status" data-testid="ai-offer-started">
            <Loader2 size={14} className="animate-spin" />
            {started ? "Your trial has started. Opening PCBJam AI…" : "You have Pro. Opening PCBJam AI…"}
          </p>
        ) : !plan ? (
          <p className={`flex items-center gap-2 ${muted}`}>
            <Loader2 size={14} className="animate-spin" /> Loading…
          </p>
        ) : trial ? (
          <>
            <div className="flex flex-col gap-1.5">
              <h3 className={`font-semibold ${muted}`}>Things you can ask</h3>
              <ul className="flex flex-col gap-1">
                {ASKS.map((ask) => (
                  <li key={ask} className="rounded-md px-2.5 py-1.5 ring-1 ring-inset ring-black/10 dark:ring-white/15">
                    {ask}
                  </li>
                ))}
              </ul>
            </div>
            <div className={box} data-testid="ai-offer-trial">
              <h3 className="text-[13px] font-semibold">PCBJam AI is part of Pro</h3>
              <Button onClick={() => void start()} disabled={starting} data-testid="ai-offer-start-trial">
                {starting && <Loader2 className="animate-spin" />} Start {trial.days}-day free trial
              </Button>
              <p className={muted}>
                No card. After {trial.days} days you are back on Free and nothing is deleted.
              </p>
              {prices && <p className={muted}>Pro is {prices}.</p>}
              {error && (
                <p role="alert" className="text-red-600 dark:text-red-400">
                  {error}
                </p>
              )}
              {billing && <BillingLink href={billing}>See what Pro includes</BillingLink>}
            </div>
          </>
        ) : (
          <div className={box} data-testid="ai-offer-upgrade">
            <h3 className="text-[13px] font-semibold">PCBJam AI is part of Pro</h3>
            {plan.trial.endsAt && <p>You have used your free trial.</p>}
            {billing && (
              <Button asChild>
                <a href={billing} target="_blank" rel="noopener noreferrer" data-testid="ai-offer-upgrade-link">
                  Upgrade to Pro <ExternalLink aria-hidden="true" />
                </a>
              </Button>
            )}
            {prices && (
              <p className={muted}>
                {prices[0]!.toUpperCase() + prices.slice(1)}. Cancel at any time on the billing page.
              </p>
            )}
          </div>
        )}
      </div>
    </SidePanel>
  );
}

function BillingLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="flex items-center gap-1.5 self-start text-sky-700 underline-offset-2 hover:underline dark:text-sky-300"
    >
      {children} <ExternalLink size={12} aria-hidden="true" />
    </a>
  );
}

/**
 * Above the chat while Pro comes from the free trial: how long it still runs,
 * and the way to keep Pro. Nothing for a paid or granted Pro.
 */
export function AiTrialStrip() {
  const plan = usePlan();
  if (!plan || plan.source !== "trial" || !plan.trial.endsAt) return null;
  const days = daysLeft(plan.trial.endsAt);
  return (
    <div
      data-testid="ai-trial-strip"
      className="flex shrink-0 items-center justify-between gap-3 border-b border-black/10 bg-black/5 px-3 py-1.5 text-xs dark:border-white/10 dark:bg-white/5"
    >
      <span>
        Pro trial: {days} {days === 1 ? "day" : "days"} left
      </span>
      {APP_URL && (
        <a
          href={`${APP_URL}/settings/billing`}
          target="_blank"
          rel="noopener noreferrer"
          className="font-medium text-sky-700 underline-offset-2 hover:underline dark:text-sky-300"
        >
          Upgrade
        </a>
      )}
    </div>
  );
}
