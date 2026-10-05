/**
 * Session identity (collab-presence 0009 A): the authenticated user behind the
 * session cookie, read once from the backend's `/api/me`. The GPL editor must
 * not import the closed contract (GPL no-link rule), so this is a plain fetch
 * of a tiny documented shape: `{ user: { slug, name, email } | null }` — the
 * slug doubles as the personal scope, name/email are for display. Backends
 * without the endpoint (example backend, demo/static) simply yield null and
 * the pre-auth slug fallback in config.ts stays in effect.
 *
 * The same payload carries `features`: the backend's per-caller feature
 * toggles (`{ plugins: true, tutorials: false, … }`). The editor only reads
 * them to decide what to show (the plugin and tutorial menus); the backend
 * re-checks every call. No payload or no entry reads as off.
 */
import { useSyncExternalStore } from "react";

export type SessionIdentity = {
  slug: string;
  name: string;
  /** Undefined for backends that don't return one (example/demo/static). */
  email?: string;
};

let identity: SessionIdentity | null = null;
let pending: Promise<SessionIdentity | null> | null = null;
let features: Readonly<Record<string, boolean>> = {};
const featureListeners = new Set<() => void>();

/** The resolved session user; null before load and for anonymous sessions. */
export function sessionIdentity(): SessionIdentity | null {
  return identity;
}

/**
 * Fetch the session user (once per page; concurrent callers share the flight).
 * Kicked off at tool boot in parallel with the WASM download and awaited
 * before presence/comments bind, so the await is effectively free.
 */
export function loadSessionIdentity(
  apiBase: string,
): Promise<SessionIdentity | null> {
  if (!pending) {
    pending = fetch(`${apiBase}/api/me`, { credentials: "include" })
      .then((r) => (r.ok ? r.json() : null))
      .then((body: unknown) => {
        adoptMePayload(body);
        return identity;
      })
      .catch(() => null);
  }
  return pending;
}

/**
 * Seed the identity from an already-fetched `/api/me`-shaped payload (the boot
 * endpoint's `me` — load-path-rework 0001 §6), making `loadSessionIdentity`'s
 * own fetch a no-op resolved flight. Must run BEFORE it is first called.
 */
export function seedSessionIdentity(me: unknown): void {
  adoptMePayload(me);
  pending = Promise.resolve(identity);
}

/** Whether the backend turned the named feature on for this session. */
export function sessionFeature(name: string): boolean {
  return features[name] === true;
}

/** `sessionFeature`, re-rendering once the identity payload arrives. */
export function useSessionFeature(name: string): boolean {
  return useSyncExternalStore(
    (listener) => {
      featureListeners.add(listener);
      return () => featureListeners.delete(listener);
    },
    () => features[name] === true,
  );
}

function adoptFeatures(body: unknown): void {
  const map = (body as { features?: unknown } | null)?.features;
  if (!map || typeof map !== "object") return;
  features = Object.fromEntries(
    Object.entries(map as Record<string, unknown>).map(([k, v]) => [k, v === true]),
  );
  for (const listener of featureListeners) listener();
}

function adoptMePayload(body: unknown): void {
  adoptFeatures(body);
  const u = (
    body as {
      user?: { slug?: unknown; name?: unknown; email?: unknown } | null;
    } | null
  )?.user;
  if (u && typeof u.slug === "string" && u.slug) {
    const email = typeof u.email === "string" && u.email ? u.email : undefined;
    identity = {
      slug: u.slug,
      name: (typeof u.name === "string" && u.name) || email || u.slug,
      email,
    };
  }
}

/** Test-only: forget the cached identity + in-flight fetch. */
export function resetSessionIdentityForTest(): void {
  identity = null;
  pending = null;
  features = {};
}
