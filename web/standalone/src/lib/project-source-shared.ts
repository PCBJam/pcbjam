/**
 * Shared vocabulary for the pluggable PROJECT SOURCES (lib/project-source.ts) and
 * the local IndexedDB store (lib/idb-project-store.ts). Kept in its own module so
 * both can import the descriptor types + the deterministic-uuid helper without a
 * runtime import cycle.
 *
 * A source has one of three KINDS, surfaced in the UI so the user always knows
 * where their edits go:
 *   - "remote-rw" — a backend the editor reads AND writes (Cloud; saves upload).
 *   - "remote-ro" — the curated CDN gallery (Demo); editing auto-forks a local copy.
 *   - "local"     — this browser's IndexedDB (Local); saves persist, export by zip.
 */
export type SourceKind = "remote-rw" | "remote-ro" | "local";

export interface SourceDescriptor {
  kind: SourceKind;
  /** Whether editor saves persist back to this source. */
  writable: boolean;
  /** Short chip label, e.g. "Local (this browser)". */
  label: string;
  /** One-line explanation of what saving does, for tooltips/help text. */
  description: string;
}

export const SOURCE_DESCRIPTORS: Record<SourceKind, SourceDescriptor> = {
  "remote-rw": {
    kind: "remote-rw",
    writable: true,
    label: "Cloud",
    description: "Stored on the backend - your saves are uploaded there.",
  },
  "remote-ro": {
    kind: "remote-ro",
    // Not directly writable, but editing transparently forks a local copy, so
    // the UI never shows a scary "read-only" — it's just a Demo you can edit.
    writable: false,
    label: "Demo",
    description:
      "A demo project - open it and your edits become a local copy you can save and export.",
  },
  local: {
    kind: "local",
    writable: true,
    label: "Local",
    description:
      "Stored in this browser - saves persist here across visits. Export with Download .zip.",
  },
};

/**
 * Stable v4-format UUID from a seed (cyrb128). The contract ids are UUIDs and the
 * editor uses project.id for the (broadcast-only here) collab room name, so a
 * deterministic id keeps that stable across reloads/tabs for the same slug.
 */
export function deterministicUuid(seed: string): string {
  let h1 = 1779033703,
    h2 = 3144134277,
    h3 = 1013904242,
    h4 = 2773480762;
  for (let i = 0; i < seed.length; i++) {
    const k = seed.charCodeAt(i);
    h1 = h2 ^ Math.imul(h1 ^ k, 597399067);
    h2 = h3 ^ Math.imul(h2 ^ k, 2869860233);
    h3 = h4 ^ Math.imul(h3 ^ k, 951274213);
    h4 = h1 ^ Math.imul(h4 ^ k, 2716044179);
  }
  h1 = Math.imul(h3 ^ (h1 >>> 18), 597399067);
  h2 = Math.imul(h4 ^ (h2 >>> 22), 2869860233);
  h3 = Math.imul(h1 ^ (h3 >>> 17), 951274213);
  h4 = Math.imul(h2 ^ (h4 >>> 19), 2716044179);
  const hex = (n: number) => (n >>> 0).toString(16).padStart(8, "0");
  const h = hex(h1) + hex(h2) + hex(h3) + hex(h4);
  const variant = ((parseInt(h.charAt(16), 16) & 0x3) | 0x8).toString(16);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}
