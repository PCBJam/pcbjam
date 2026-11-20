/**
 * What's new: the release notes the backend bundles, which of them this person
 * hasn't seen, the "new" dots, and whether PCBJam AI is theirs, offered to
 * them (part of Pro, they are on Free), or not available.
 *
 * Like session-identity.ts this is a plain fetch of a small documented shape
 * (`GET /api/whats-new`): the GPL editor must not import the closed contract.
 * The backend's `whatsNew` feature decides whether the editor asks at all, so a
 * backend without the endpoint is never called. Everything here is decoration:
 * a failed call leaves the editor as it was.
 */
import { useEffect, useSyncExternalStore } from "react";
import { API_BASE_URL } from "@/lib/config";

/** A highlight's `action` that opens PCBJam AI; also the name of that row's "new" dot. */
export const OPEN_AI_CHAT = "open-ai-chat";

export interface WhatsNewHighlight {
  id: string;
  title: string;
  text: string;
  /** "pro": the feature is part of the Pro plan. */
  plan: string | null;
  action: string | null;
}

export interface WhatsNewRelease {
  version: string;
  /** The release day, `YYYY-MM-DD`. */
  date: string;
  title: string;
  /** A big release: with highlights to show, its notes open once by themselves. */
  modal: boolean;
  unread: boolean;
  highlights: WhatsNewHighlight[];
}

export interface WhatsNewState {
  /** Newest first. */
  releases: WhatsNewRelease[];
  /** The newest unread release's version, or null. */
  unread: string | null;
  /** "Don't show this after updates": nothing opens by itself. The row and the dots stay. */
  muted: boolean;
  /** Actions whose row still carries a "new" dot. */
  fresh: string[];
  ai: "none" | "open" | "offer";
}

/**
 * The release that announces itself: unread, a big one (`modal: true`), with
 * highlights this person can see. A release without highlights is notes only:
 * nothing to show, so nothing opens. None for a person who switched this off.
 */
export function announcedRelease(s: WhatsNewState | null): WhatsNewRelease | null {
  if (!s || s.muted) return null;
  return s.releases.find((r) => r.unread && r.modal && r.highlights.length > 0) ?? null;
}

/**
 * The release the panel shows when the person opens it: the newest unread one
 * with highlights, so a later release of notes only doesn't hide them; else
 * the newest.
 */
export function featuredRelease(s: WhatsNewState | null): WhatsNewRelease | null {
  if (!s) return null;
  return s.releases.find((r) => r.unread && r.highlights.length > 0) ?? s.releases[0] ?? null;
}

let state: WhatsNewState | null = null;
let loading: Promise<void> | null = null;
const listeners = new Set<() => void>();

function set(next: WhatsNewState | null): void {
  state = next;
  for (const listener of listeners) listener();
}

function adopt(body: unknown): void {
  const b = body as Partial<WhatsNewState> | null;
  if (!b || !Array.isArray(b.releases) || !Array.isArray(b.fresh)) return;
  set({
    releases: b.releases,
    unread: typeof b.unread === "string" ? b.unread : null,
    muted: b.muted === true,
    fresh: b.fresh.filter((a) => typeof a === "string"),
    ai: b.ai === "open" || b.ai === "offer" ? b.ai : "none",
  });
}

async function request(path = "", body?: unknown): Promise<void> {
  try {
    const res = await fetch(`${API_BASE_URL}/api/whats-new${path}`, {
      method: body === undefined ? "GET" : "POST",
      credentials: "include",
      headers: body === undefined ? undefined : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (res.ok) adopt(await res.json());
  } catch {
    /* offline, or a backend without the endpoint: nothing is new */
  }
}

export const whatsNew = {
  get: (): WhatsNewState | null => state,
  /** Ask the backend again (after a trial started: PCBJam AI is theirs now). */
  refresh: (): Promise<void> => request(),
  /** The notes were shown: nothing is unread. Shows at once; the backend remembers. */
  markSeen(): void {
    const version = state?.unread;
    if (!state || !version) return;
    set({ ...state, unread: null, releases: state.releases.map((r) => ({ ...r, unread: false })) });
    void request("/seen", { version });
  },
  /** A highlighted feature was opened: its dot goes, for good. */
  markTried(action: string): void {
    if (!state?.fresh.includes(action)) return;
    set({ ...state, fresh: state.fresh.filter((a) => a !== action) });
    void request("/tried", { action });
  },
};

/** The state, loaded once per page when `enabled`; null until then and for a session without it. */
export function useWhatsNew(enabled: boolean): WhatsNewState | null {
  useEffect(() => {
    if (enabled && !loading) loading = request();
  }, [enabled]);
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => state,
  );
}

/** "19 Nov 2026" for a release day, whatever the reader's time zone. */
export function releaseDay(date: string): string {
  const d = new Date(`${date}T12:00:00Z`);
  if (Number.isNaN(d.getTime())) return date;
  const month = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][d.getUTCMonth()];
  return `${d.getUTCDate()} ${month} ${d.getUTCFullYear()}`;
}

/** Test-only: forget the loaded state. */
export function resetWhatsNewForTest(): void {
  state = null;
  loading = null;
}
