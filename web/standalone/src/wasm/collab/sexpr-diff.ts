/**
 * `sexprDiff` — a minimal, uuid-keyed STRUCTURAL comparator for KiCad s-expr text
 * (README §B; shared by the live drift check 0003 and the round-trip tests 0004).
 *
 * It is deliberately NOT a domain parser — a full KiCad parse could itself be a
 * source of false positives. It does only four things:
 *
 *   1. Tokenize the s-expr text into a tree of nested lists + atoms (balanced
 *      parens, quoted strings with escapes, bare atoms). No KiCad semantics.
 *   2. Index "item" nodes by uuid: any list node with a direct `(uuid "X")` child
 *      is an item keyed by `X`. Nested items are collected too.
 *   3. Compare canonical parsed structure with ORDER PRESERVED by default. The
 *      two item sets must have the same uuid keys, and every shared item's
 *      anonymous content must match exactly. Callers may opt into one audited
 *      writer-normalization class: UUID-bearing sibling items may reorder.
 *   4. Emit `{ equal, added, removed, changed }` for readable failures.
 *
 * IMPORTANT — compare like-for-like. This is only false-positive-free when both
 * inputs are produced by the SAME tool serializer (e.g. 0004 saves the live model
 * AND a model rebuilt from the Y.Doc, both through the tool's own writer). Feeding
 * a saved file against decomposed-scalar Y.Doc fields would need a per-type
 * field↔token map — exactly the trap this comparator avoids by construction.
 *
 * The exception never covers anonymous repeated heads or positional atoms, so
 * `(at 1 2)` → `(at 2 1)` and `(pts (xy A) (xy B))` → the reverse are drift.
 *
 * No imports — usable from standalone app code (`@/wasm/collab/sexpr-diff`) and
 * from the Playwright specs (relative import) alike.
 */

/** Parsed node: a `string` is an atom (quoted strings keep their quotes, so a
 *  string value is distinct from the same bare token); an array is a list. */
export type SNode = string | SNode[];

export interface SexprChange {
  uuid: string;
  /** Best-effort location: the head keyword of the differing child, or "·atom"
   *  for a differing positional scalar. */
  path: string;
  /** The differing child as serialized on side A (the base/original), or null
   *  if absent on A. */
  a: string | null;
  /** The differing child as serialized on side B (the new), or null if absent. */
  b: string | null;
}

export interface SexprDiffResult {
  equal: boolean;
  /** uuids present in B but not A. */
  added: string[];
  /** uuids present in A but not B. */
  removed: string[];
  /** per-property differences for uuids present in both. */
  changed: SexprChange[];
}

export interface SexprDiffOptions {
  /** Head keywords whose list nodes are dropped before comparing, at any depth —
   *  for known-volatile serializer output (e.g. "generator_version"). Declared
   *  explicitly so drift is never hidden silently. */
  ignoreTokens?: string[];
  /** Explicit writer-normalized order classes. Exact order is the default. */
  ignoreOrderClasses?: readonly SexprOrderClass[];
}

export type SexprOrderClass = "uuid-item-siblings";

/**
 * KiCad may reorder independently identified sibling objects while saving. A
 * real board reopen moved one track block while preserving all 533 UUID item
 * nodes and every anonymous field. Keep this opt-in and centralized: widening
 * it requires new writer evidence and a focused counterexample test.
 */
export const KICAD_WRITER_NORMALIZED_SEXPR_ORDER: readonly SexprOrderClass[] =
  Object.freeze(["uuid-item-siblings"] as const);

// ── Parser ──────────────────────────────────────────────────────────────────

/** Parse s-expr text into a flat list of top-level forms (usually one). Throws
 *  on unbalanced parens or an unterminated string. */
export function parseSexpr(src: string): SNode[] {
  let i = 0;
  const n = src.length;
  const isWs = (c: string | undefined) =>
    c === " " || c === "\t" || c === "\n" || c === "\r" || c === "\f";

  const skipWs = () => {
    while (i < n && isWs(src[i])) i++;
  };

  const parseString = (): string => {
    const start = i;
    i++; // opening quote
    while (i < n) {
      const c = src[i];
      if (c === "\\") {
        i += 2; // escape — skip the next char too
        continue;
      }
      if (c === '"') {
        i++;
        return src.slice(start, i); // keep surrounding quotes
      }
      i++;
    }
    throw new Error("sexprDiff: unterminated string");
  };

  const parseAtom = (): string => {
    const start = i;
    while (i < n && !isWs(src[i]) && src[i] !== "(" && src[i] !== ")" && src[i] !== '"') i++;
    return src.slice(start, i);
  };

  const parseList = (): SNode[] => {
    i++; // consume '('
    const list: SNode[] = [];
    for (;;) {
      skipWs();
      if (i >= n) throw new Error("sexprDiff: unbalanced parens (EOF inside list)");
      const c = src[i];
      if (c === ")") {
        i++;
        return list;
      }
      if (c === "(") list.push(parseList());
      else if (c === '"') list.push(parseString());
      else list.push(parseAtom());
    }
  };

  const forms: SNode[] = [];
  for (;;) {
    skipWs();
    if (i >= n) break;
    if (src[i] === ")") throw new Error("sexprDiff: unbalanced parens (stray ')')");
    if (src[i] === "(") forms.push(parseList());
    else if (src[i] === '"') forms.push(parseString());
    else forms.push(parseAtom());
  }
  return forms;
}

// ── uuid indexing ─────────────────────────────────────────────────────────────

function stripQuotes(atom: string): string {
  return atom.length >= 2 && atom.startsWith('"') && atom.endsWith('"')
    ? atom.slice(1, -1)
    : atom;
}

/** The uuid of a list node, from its direct `(uuid "X")` child, or null. */
function directUuid(node: SNode[]): string | null {
  for (const c of node) {
    if (Array.isArray(c) && c[0] === "uuid" && typeof c[1] === "string") {
      return stripQuotes(c[1]);
    }
  }
  return null;
}

/** Collect every list node that has a direct uuid child, keyed by uuid. */
function collectItems(node: SNode, out: Map<string, SNode[]>): void {
  if (!Array.isArray(node)) return;
  const id = directUuid(node);
  if (id !== null && !out.has(id)) out.set(id, node);
  for (const c of node) collectItems(c, out);
}

// ── Canonicalization (order-insensitive multiset) ──────────────────────────────

function isIgnored(node: SNode, ignore: Set<string>): boolean {
  return Array.isArray(node) && typeof node[0] === "string" && ignore.has(node[0]);
}

type CanonicalNode =
  | { atom: string }
  | { item: string }
  | { list: CanonicalNode[]; unorderedItems?: string[] };

interface CanonicalContext {
  ignore: Set<string>;
  commonItems: Set<string>;
  unorderedUuidSiblings: boolean;
}

/**
 * Normalize without losing order. A direct UUID-bearing child becomes a
 * reference marker: its body is checked under its own UUID, while this marker
 * proves membership/parentage and, unless opted out, sibling order.
 */
function normalizeNode(node: SNode, ctx: CanonicalContext): CanonicalNode {
  if (!Array.isArray(node)) return { atom: node };
  const ordered: CanonicalNode[] = [];
  const unorderedItems: string[] = [];
  for (const child of node) {
    if (isIgnored(child, ctx.ignore)) continue;
    if (Array.isArray(child)) {
      const id = directUuid(child);
      if (id !== null) {
        // Membership differences are already represented by added/removed.
        // Omitting non-common markers also preserves callers' explicit ability
        // to filter a known writer-omitted UUID without a duplicate parent diff.
        if (!ctx.commonItems.has(id)) continue;
        if (ctx.unorderedUuidSiblings) unorderedItems.push(id);
        else ordered.push({ item: id });
        continue;
      }
    }
    ordered.push(normalizeNode(child, ctx));
  }
  return unorderedItems.length === 0
    ? { list: ordered }
    : { list: ordered, unorderedItems: unorderedItems.sort() };
}

function canonical(node: SNode, ctx: CanonicalContext): string {
  return JSON.stringify(normalizeNode(node, ctx));
}

function canonicalForms(forms: SNode[], ctx: CanonicalContext): string {
  return JSON.stringify(
    forms.filter((node) => !isIgnored(node, ctx.ignore)).map((node) => normalizeNode(node, ctx)),
  );
}

function renderNode(node: SNode): string {
  return Array.isArray(node) ? `(${node.map(renderNode).join(" ")})` : node;
}

function nodeHead(node: SNode | undefined): string {
  return Array.isArray(node) && typeof node[0] === "string" ? node[0] : "·atom";
}

/** Per-property changes between two item nodes sharing a uuid. */
function diffItem(
  uuid: string,
  a: SNode[],
  b: SNode[],
  ctx: CanonicalContext,
): SexprChange[] {
  const as = a.filter((node) => !isIgnored(node, ctx.ignore));
  const bs = b.filter((node) => !isIgnored(node, ctx.ignore));
  const out: SexprChange[] = [];
  const max = Math.max(as.length, bs.length);
  for (let index = 0; index < max; index++) {
    const left = as[index];
    const right = bs[index];
    if (
      left !== undefined &&
      right !== undefined &&
      canonical(left, ctx) === canonical(right, ctx)
    ) {
      continue;
    }
    out.push({
      uuid,
      path: nodeHead(left ?? right),
      a: left === undefined ? null : renderNode(left),
      b: right === undefined ? null : renderNode(right),
    });
  }
  return out;
}

// ── Public API ─────────────────────────────────────────────────────────────────

/**
 * Structurally compare two s-expr texts by uuid-keyed items.
 *
 * @param a base / original text (e.g. the as-loaded model save)
 * @param b new text (e.g. the rebuilt-from-Y.Doc model save)
 */
export function sexprDiff(a: string, b: string, opts: SexprDiffOptions = {}): SexprDiffResult {
  const ignore = new Set(opts.ignoreTokens ?? []);
  const formsA = parseSexpr(a);
  const formsB = parseSexpr(b);
  const itemsA = new Map<string, SNode[]>();
  const itemsB = new Map<string, SNode[]>();
  collectItems(formsA, itemsA);
  collectItems(formsB, itemsB);

  const commonItems = new Set([...itemsA.keys()].filter((id) => itemsB.has(id)));
  const orderClasses = new Set(opts.ignoreOrderClasses ?? []);
  const ctx: CanonicalContext = {
    ignore,
    commonItems,
    unorderedUuidSiblings: orderClasses.has("uuid-item-siblings"),
  };

  const removed: string[] = [];
  const added: string[] = [];
  const changed: SexprChange[] = [];

  for (const id of itemsA.keys()) if (!itemsB.has(id)) removed.push(id);
  for (const id of itemsB.keys()) if (!itemsA.has(id)) added.push(id);

  for (const [id, na] of itemsA) {
    const nb = itemsB.get(id);
    if (!nb) continue;
    if (canonical(na, ctx) !== canonical(nb, ctx)) {
      changed.push(...diffItem(id, na, nb, ctx));
    }
  }

  // UUID item bodies are represented by identity markers in this skeleton, so
  // this independently checks root metadata, ownership and ordering without
  // duplicating every nested item-body change under its parent.
  if (canonicalForms(formsA, ctx) !== canonicalForms(formsB, ctx)) {
    changed.push({
      uuid: "·document",
      path: "·document",
      a: formsA.map(renderNode).join(" "),
      b: formsB.map(renderNode).join(" "),
    });
  }

  const equal = added.length === 0 && removed.length === 0 && changed.length === 0;
  return { equal, added: added.sort(), removed: removed.sort(), changed };
}
