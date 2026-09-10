import type { Collaborator } from "@pcbjam/shared";
import { client } from "./contract-client";
import { currentScope } from "./config";

/**
 * Mention-autocomplete roster (comments-ux 0001 E): the scope's collaborators
 * from the backend's display-only `listCollaborators` route — fetched lazily
 * on the first `@` keystroke, cached for the session. Backends without a
 * members model (example/demo/static/@local) 404 or reject → null, and the
 * caller falls back to presence peers ∪ existing comment authors.
 */

let inflight: Promise<Collaborator[] | null> | null = null;
let inflightKey: string | null = null;
let resolved: Collaborator[] | null = null;

/**
 * `project` (comments-ux 0003): scope the roster to one project — the
 * team's members plus that project's commenters, each with a role — which is
 * also the variant a commenter (non-member) may call. Without it the route
 * is members-only.
 */
export function collaborators(project?: string): Promise<Collaborator[] | null> {
  const key = project ?? "";
  if (!inflight || inflightKey !== key) {
    inflightKey = key;
    inflight = client
      .listCollaborators({
        params: { scope: currentScope() },
        query: project ? { project } : {},
      })
      .then((r) => {
        resolved = r.status === 200 ? r.body : null;
        return resolved;
      })
      .catch(() => null);
  }
  return inflight;
}

/** The already-fetched roster, for synchronous render paths (mention
 *  highlighting of hand-typed `@slug`s); null before the first fetch lands. */
export function cachedCollaborators(): Collaborator[] | null {
  return resolved;
}

/** Test hook: forget the session cache. */
export function resetCollaboratorsCache(): void {
  inflight = null;
  inflightKey = null;
  resolved = null;
}

/** Dedupe/merge candidate lists (first occurrence of a slug wins). */
export function mergeCandidates(...lists: Collaborator[][]): Collaborator[] {
  const seen = new Set<string>();
  const out: Collaborator[] = [];
  for (const list of lists) {
    for (const c of list) {
      if (!c.slug || seen.has(c.slug)) continue;
      seen.add(c.slug);
      out.push(c);
    }
  }
  return out;
}

/** Filter + rank candidates for a typed `@` query (prefix > substring). */
export function filterCandidates(candidates: Collaborator[], query: string): Collaborator[] {
  const q = query.toLowerCase();
  if (!q) return candidates;
  const starts = (c: Collaborator) =>
    c.slug.toLowerCase().startsWith(q) || c.name.toLowerCase().startsWith(q);
  const contains = (c: Collaborator) =>
    c.slug.toLowerCase().includes(q) || c.name.toLowerCase().includes(q);
  return [...candidates.filter(starts), ...candidates.filter((c) => !starts(c) && contains(c))];
}
