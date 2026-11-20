/**
 * The session user's plan, for the two places the editor talks about Pro: the
 * PCBJam AI offer a Free account sees, and the "trial: N days left" strip above
 * the chat. A plain fetch of the backend's billing status (`GET /api/billing`),
 * read only when one of those is on screen; the GPL editor imports no closed
 * code. Starting the trial is the same call the web app's billing page makes.
 */
import { useEffect, useSyncExternalStore } from "react";
import { API_BASE_URL } from "@/lib/config";

export interface PlanStatus {
  pro: boolean;
  /** Where Pro comes from. "trial": the free trial is running. */
  source: "paid" | "granted" | "trial" | null;
  trial: {
    /** The length of a trial started now; 0 means trials are off. */
    days: number;
    /** This account's trial, running or over. */
    endsAt: string | null;
    /** The account may start its trial now. */
    eligible: boolean;
  };
  /** Pro's prices as this person sees them, formatted ("$10"). */
  prices: { month: string; year: string };
}

let status: PlanStatus | null = null;
let loading: Promise<void> | null = null;
const listeners = new Set<() => void>();

function adopt(body: unknown): void {
  const b = body as Partial<PlanStatus> | null;
  if (!b || typeof b.pro !== "boolean" || !b.trial || !b.prices) return;
  status = {
    pro: b.pro,
    source: b.source ?? null,
    trial: { days: Number(b.trial.days) || 0, endsAt: b.trial.endsAt ?? null, eligible: b.trial.eligible === true },
    prices: { month: String(b.prices.month), year: String(b.prices.year) },
  };
  for (const listener of listeners) listener();
}

async function load(): Promise<void> {
  try {
    const res = await fetch(`${API_BASE_URL}/api/billing`, { credentials: "include" });
    if (res.ok) adopt(await res.json());
  } catch {
    /* the offer shows without prices */
  }
}

/** Ask again (a trial just started, or the tab came back from the billing page). */
export function refreshPlan(): Promise<void> {
  loading = load();
  return loading;
}

/** The plan, fetched once per page when first wanted; null until it arrives. */
export function usePlan(enabled = true): PlanStatus | null {
  useEffect(() => {
    if (enabled && !loading) loading = load();
  }, [enabled]);
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => status,
  );
}

/**
 * Start the account's free trial. Resolves to null when it started, else to
 * the backend's reason ("You've already had a Pro trial.").
 */
export async function startProTrial(): Promise<string | null> {
  try {
    const res = await fetch(`${API_BASE_URL}/api/billing/trial`, {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    if (res.ok) return null;
    const body = (await res.json().catch(() => null)) as { message?: unknown } | null;
    return typeof body?.message === "string" && body.message ? body.message : "The trial didn't start. Try again.";
  } catch {
    return "The trial didn't start: the server didn't answer. Try again.";
  }
}

/** Whole days until `iso`, at least 1 while it is still ahead. */
export function daysLeft(iso: string, now = Date.now()): number {
  return Math.max(1, Math.ceil((Date.parse(iso) - now) / (24 * 60 * 60 * 1000)));
}

/** Test-only: forget the loaded plan. */
export function resetPlanForTest(): void {
  status = null;
  loading = null;
}
