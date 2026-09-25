import { shortSha } from "@pcbjam/shared";

/**
 * Thread provenance against the current copy (git-integration 0006,
 * design-comments §6.2): the "introduced at" commit H related to this
 * copy's head W by Git ancestry — asked of the backend
 * (`GET …/git/ancestry?copy=&shas=`), batched and cached per session — and
 * the `dirtyAtWrite` decision for new threads. Everything is optional: a
 * backend without Git never answers, and the popover shows no label.
 */

export type AncestryRelation = "same" | "before" | "after" | "divergent" | "unknown";

const LABELS: Record<AncestryRelation, string> = {
  same: "same revision",
  before: "before this copy",
  after: "after this copy",
  divergent: "divergent",
  unknown: "unknown",
};

export function ancestryLabel(rel: AncestryRelation | null | undefined): string | null {
  return rel ? LABELS[rel] : null;
}

/** Normalize a server answer (a label per sha) defensively. */
export function parseAncestry(body: unknown): Record<string, AncestryRelation> {
  const raw =
    body && typeof body === "object"
      ? ((body as { labels?: unknown }).labels ??
        (body as { relations?: unknown }).relations ??
        (body as { ancestry?: unknown }).ancestry ??
        body)
      : null;
  const out: Record<string, AncestryRelation> = {};
  if (!raw || typeof raw !== "object") return out;
  for (const [sha, v] of Object.entries(raw as Record<string, unknown>)) {
    const rel = typeof v === "string" ? v : (v as { relation?: unknown } | null)?.relation;
    if (rel === "same" || rel === "before" || rel === "after" || rel === "divergent" || rel === "unknown") {
      out[sha] = rel;
    }
  }
  return out;
}

/**
 * The popover line for a thread's provenance. `dirtyAtWrite` says the anchor
 * may not be in H at all (C-N2): "written on uncommitted changes based at H".
 */
export function provenanceText(
  prov: { headCommit?: string; dirtyAtWrite?: boolean } | null | undefined,
  rel: AncestryRelation | null | undefined,
): string | null {
  if (!prov?.headCommit) return null;
  const sha = shortSha(prov.headCommit);
  const base = prov.dirtyAtWrite ? `written on uncommitted changes based at ${sha}` : `introduced at ${sha}`;
  const label = ancestryLabel(rel);
  return label ? `${base} (${label})` : base;
}

// --- ancestry cache --------------------------------------------------------------

export interface AncestryStore {
  /** The cached relation, requesting it (batched) when unknown to the cache. */
  get(sha: string): AncestryRelation | null;
  subscribe(cb: () => void): () => void;
  /** Forget everything (the copy's head moved: a new generation). */
  reset(): void;
}

export function createAncestryStore(
  fetchRelations: (shas: string[]) => Promise<Record<string, AncestryRelation>>,
  schedule: (fn: () => void) => void = (fn) => queueMicrotask(fn),
): AncestryStore {
  const known = new Map<string, AncestryRelation>();
  const pending = new Set<string>();
  const inflight = new Set<string>();
  const subs = new Set<() => void>();
  let epoch = 0;
  let scheduled = false;
  const notify = () => subs.forEach((cb) => cb());
  const flush = () => {
    scheduled = false;
    const shas = [...pending].filter((s) => !inflight.has(s) && !known.has(s));
    pending.clear();
    if (!shas.length) return;
    shas.forEach((s) => inflight.add(s));
    const at = epoch;
    void fetchRelations(shas)
      .then((rels) => {
        if (at !== epoch) return;
        for (const s of shas) known.set(s, rels[s] ?? "unknown");
        notify();
      })
      .catch(() => undefined)
      .finally(() => shas.forEach((s) => inflight.delete(s)));
  };
  return {
    get(sha) {
      const hit = known.get(sha);
      if (hit) return hit;
      if (!inflight.has(sha)) {
        pending.add(sha);
        if (!scheduled) {
          scheduled = true;
          schedule(flush);
        }
      }
      return null;
    },
    subscribe(cb) {
      subs.add(cb);
      return () => subs.delete(cb);
    },
    reset() {
      epoch += 1;
      known.clear();
      pending.clear();
      inflight.clear();
      notify();
    },
  };
}

// --- session wiring ------------------------------------------------------------------

interface GitSession {
  apiBase: string;
  scope: string;
  project: string;
  copyId: string;
}

let session: GitSession | null = null;
let store: AncestryStore | null = null;
let changedPaths = new Set<string>();
const editedInSession = new Set<string>();

function projectUrl(s: GitSession, rest: string): string {
  return `${s.apiBase.replace(/\/$/, "")}/api/scopes/${encodeURIComponent(s.scope)}/projects/${encodeURIComponent(s.project)}/git/${rest}`;
}

/** Bind provenance helpers to a connected copy (boot); null unbinds. */
export function configureGitProvenance(next: GitSession | null): void {
  session = next;
  store = next
    ? createAncestryStore(async (shas) => {
        const q = new URLSearchParams({ copy: next.copyId, shas: shas.join(",") });
        const res = await fetch(`${projectUrl(next, "ancestry")}?${q}`, { credentials: "include" });
        if (!res.ok) throw new Error(`ancestry ${res.status}`);
        return parseAncestry(await res.json());
      })
    : null;
  changedPaths = new Set();
  editedInSession.clear();
}

export function ancestryStore(): AncestryStore | null {
  return store;
}

/** Re-read the copy's uncommitted files (boot, and on every files hint). */
export async function refreshChangedPaths(): Promise<void> {
  const s = session;
  if (!s) return;
  try {
    const res = await fetch(`${projectUrl(s, "changes")}?copy=${encodeURIComponent(s.copyId)}`, {
      credentials: "include",
    });
    if (!res.ok) return;
    const body = (await res.json()) as { entries?: Array<{ path?: unknown }> };
    if (session !== s) return;
    changedPaths = new Set((body.entries ?? []).map((f) => f.path).filter((p): p is string => typeof p === "string"));
  } catch {
    /* keep the last list */
  }
}

export function setChangedPaths(paths: Iterable<string>): void {
  changedPaths = new Set(paths);
}

/** A local edit landed in `path` during this session. */
export function markEditedInSession(path: string): void {
  editedInSession.add(path);
}

/**
 * `dirtyAtWrite` for a new thread on `path` (design-comments C-N2): the file
 * has uncommitted changes in this copy (known from the changes list) or was
 * edited in this session. Unknown on a copy-less backend → undefined.
 */
export function dirtyAtWrite(path: string | undefined): boolean | undefined {
  if (!session || !path) return undefined;
  return changedPaths.has(path) || editedInSession.has(path);
}
