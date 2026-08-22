// Browser bundle entry for the V2 "items" collab e2e — the PRODUCTION stack
// (ysync 0008): startKicadCollab → connectKicadDoc + bindKicadCollab over
// moduleItemsBridge, Y keys kdoc_*, C++ exports kicadCollabSnapshotItems /
// kicadCollabApplyItems / window.kicadCollab.onItems.
//
// The sibling browser-entry.ts drives the LEGACY scalar wire (startCollab /
// onDelta), which is DEAD in production — nothing registers onDelta; WasmTool
// binds onItems only (ysync-review miss 11). New collab e2e must load THIS
// bundle; the legacy one stays only until the scalar wire is deleted.
//
// Build: npm run build:collab  (tests/)  → tests/apps/kicad/collab-bundle-v2.js
//
// IMPORTANT (build.mjs): yjs is aliased to ONE physical copy. web/standalone and
// web/pcbjam-shared are separate pnpm workspaces, so without the alias the
// bundle carries two yjs instances (the legacy bundle demonstrably does) — and
// the v2 path breaks on that (Y types are instanceof-checked singletons; same
// reason the standalone vitest config sets `dedupe: ["yjs"]`).
import * as Y from "yjs";
import {
  compareSlots,
  docToFile,
  docToY,
  driftDocDelta,
  fileToDoc,
  isEmptyKicadDelta,
  yToDoc,
} from "@pcbjam/shared";
import {
  attachKicadCollab,
  connectKicadDoc,
  type KicadCollabHandle,
  type KicadItemsModule,
  type KicadItemsWindow,
} from "../../web/standalone/src/wasm/collab/index";
import { nativeSnapshotThroughY } from "../../web/standalone/src/wasm/collab/wire-y-roundtrip";

interface StartOpts {
  room: string;
  /** BroadcastChannel settle window before the seed-vs-adopt decision. */
  settleMs?: number;
  /**
   * Full file text; when set and the room is EMPTY, the Y.Doc is file-seeded
   * from fileToDoc(seedText) — the production first-tab path (and the branch
   * bug 01 lives in). Omit to exercise the editor-snapshot / adopt branches.
   */
  seedText?: string;
  /**
   * The ydoc-load path: the editor opened exactly this doc's content, so seed
   * only baselines the wasm differ instead of running the adopt apply.
   */
  editorMatchesDoc?: boolean;
}

/** Start the v2 stack; the handle lands on window.__collabV2 for in-page asserts. */
async function start(
  mod: KicadItemsModule,
  win: KicadItemsWindow,
  opts: StartOpts,
): Promise<void> {
  // startKicadCollab's body, split so editorMatchesDoc is reachable (the
  // production WasmTool uses the same connect + attach pair for ydoc mode).
  const session = await connectKicadDoc({
    provider: { kind: "broadcastchannel", settleMs: opts.settleMs ?? 400 },
    room: opts.room,
  });
  const h = attachKicadCollab(mod, win, session, {
    seedDoc: opts.seedText ? fileToDoc(opts.seedText) : undefined,
    editorMatchesDoc: opts.editorMatchesDoc,
  });
  (window as unknown as { __collabV2?: KicadCollabHandle }).__collabV2 = h;
}

function handle(): KicadCollabHandle {
  const h = (window as unknown as { __collabV2?: KicadCollabHandle }).__collabV2;
  if (!h) throw new Error("KicadCollabV2: start() has not completed");
  return h;
}

/** docToFile of the live room doc — THROWS if the doc stopped materializing. */
function renderActiveDoc(): string {
  return docToFile(yToDoc(handle().doc));
}

/** What ONE seeder would materialize — the bug-06 reference rendering. */
function singleSeedRender(seedText: string): string {
  const ydoc = new Y.Doc();
  try {
    docToY(fileToDoc(seedText), ydoc);
    return docToFile(yToDoc(ydoc));
  } finally {
    ydoc.destroy();
  }
}

export interface DriftSummary {
  added: string[];
  updated: string[];
  removed: string[];
  /** Order-only item churn — surfaced for triage, NOT drift (kicad-delta.ts). */
  reordered: string[];
  layoutChanged: boolean;
  /** Order-only layout churn — likewise not report-worthy on its own. */
  layoutReordered: boolean;
  metaChanged: boolean;
}

/**
 * The drift-detect convergence oracle, replicating computeDrift's core
 * (web/standalone/src/wasm/collab/drift-detect.ts) from @pcbjam/shared
 * primitives only — drift-detect itself pulls `@/lib/api`, so it can't be
 * bundled here. Serializes the live model via the tool's save fn, diffs it
 * against the room doc with the PRODUCTION comparator (driftDocDelta +
 * compareSlots — order-only churn goes to reordered/layoutReordered and does
 * not make a report, matching ysync 0010); null means editor ≡ doc.
 */
function driftReport(saveFn: string, scratchPath: string): DriftSummary | null {
  const w = window as unknown as {
    Module: Record<string, (p: string) => void>;
    FS: {
      readFile(p: string, o: { encoding: "utf8" }): string;
      unlink(p: string): void;
    };
  };
  w.Module[saveFn]!(scratchPath);
  let text: string;
  try {
    text = w.FS.readFile(scratchPath, { encoding: "utf8" });
  } finally {
    try {
      w.FS.unlink(scratchPath);
    } catch {
      /* scratch cleanup is best-effort */
    }
  }
  const wasmDoc = fileToDoc(text);
  const ydocDoc = yToDoc(handle().doc);
  const diff = driftDocDelta(ydocDoc, wasmDoc);
  const layoutRelation = compareSlots(ydocDoc.layout, wasmDoc.layout);
  const layoutChanged = layoutRelation === "different";
  const metaChanged = ydocDoc.root !== wasmDoc.root;
  // layoutReordered deliberately outside the gate — same as computeDrift.
  if (isEmptyKicadDelta(diff) && !layoutChanged && !metaChanged) return null;
  return {
    added: diff.added.map((i) => i.uuid),
    updated: diff.updated.map((i) => i.uuid),
    removed: diff.removed,
    reordered: diff.reordered.map((i) => i.uuid),
    layoutChanged,
    layoutReordered: layoutRelation === "reordered",
    metaChanged,
  };
}

declare global {
  interface Window {
    KicadCollabV2?: {
      start: typeof start;
      renderActiveDoc: typeof renderActiveDoc;
      singleSeedRender: typeof singleSeedRender;
      nativeWireThroughY: typeof nativeSnapshotThroughY;
      driftReport: typeof driftReport;
    };
  }
}

window.KicadCollabV2 = {
  start,
  renderActiveDoc,
  singleSeedRender,
  nativeWireThroughY: nativeSnapshotThroughY,
  driftReport,
};
