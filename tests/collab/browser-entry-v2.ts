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
  KICAD_WRITER_NORMALIZED_ITEM_REFERENCE_ORDER,
  kicadItemsMap,
  syncLayoutToY,
  upsertDocToY,
  yToDoc,
} from "@pcbjam/shared";
import {
  attachKicadCollab,
  connectKicadDoc,
  type KicadCollabHandle,
  type KicadItemsModule,
  type KicadItemsWindow,
} from "../../web/standalone/src/wasm/collab/index";
import {
  NATIVE_PROJECTION_FAILED_EVENT,
  type NativeProjectionFailure,
} from "../../web/standalone/src/wasm/collab/kicad-binding";
import { nativeSnapshotThroughY } from "../../web/standalone/src/wasm/collab/wire-y-roundtrip";

const projectionFailures: NativeProjectionFailure[] = [];
window.addEventListener(NATIVE_PROJECTION_FAILED_EVENT, (event) => {
  projectionFailures.push((event as CustomEvent<NativeProjectionFailure>).detail);
});

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

/**
 * Build two genuinely concurrent edits from the live room's current state,
 * merge them off-line, then deliver the already-merged update to the bound
 * room. This is test-only plumbing for conflict-domain E2E coverage: native
 * sees one late remote projection, while the Yjs history still contains two
 * independent clients creating the same root UUID.
 */
function applyConcurrentRootCreations(leftText: string, rightText: string): string {
  const live = handle().doc;
  const baseUpdate = Y.encodeStateAsUpdate(live);
  const baseVector = Y.encodeStateVector(live);
  const replicas: Y.Doc[] = [];

  const author = (clientID: number, text: string): Uint8Array => {
    const replica = new Y.Doc();
    replicas.push(replica);
    Y.applyUpdate(replica, baseUpdate);
    replica.clientID = clientID;
    upsertDocToY(fileToDoc(text), replica, `e2e-writer-${clientID}`);
    return Y.encodeStateAsUpdate(replica, baseVector);
  };

  const merged = new Y.Doc();
  replicas.push(merged);
  try {
    const left = author(900_002, leftText);
    const right = author(900_001, rightText);
    Y.applyUpdate(merged, baseUpdate);
    Y.applyUpdate(merged, left);
    Y.applyUpdate(merged, right);

    const rendered = docToFile(yToDoc(merged));
    const liveVector = Y.encodeStateVector(live);
    Y.applyUpdate(live, Y.encodeStateAsUpdate(merged, liveVector), "e2e-concurrent-root-merge");
    return rendered;
  } finally {
    for (const replica of replicas) replica.destroy();
  }
}

/**
 * Test-only remote-author helper for the part of a KiCad document that the
 * native item bridge cannot hot-apply. The non-local origin is deliberate: it
 * must cross the production structural-projection guard, not the local
 * `layout-save` accounting path.
 */
function applyRemoteLayout(fileText: string): boolean {
  return syncLayoutToY(fileToDoc(fileText), handle().doc, "e2e-remote-layout");
}

/** Feed bytes produced by a completed real native save through production save accounting. */
function applySavedLayout(fileText: string): boolean {
  return handle().binding.syncLayoutFromNative(fileToDoc(fileText));
}

/** Apply a later complete remote snapshot without replacing the live Y.Doc. */
function applyRemoteDoc(fileText: string): void {
  upsertDocToY(fileToDoc(fileText), handle().doc, "e2e-remote-doc");
}

/**
 * Test-only raw-peer corruption. This deliberately bypasses every authenticated
 * writer API so the production binding must contain an unmaterializable Y state
 * without letting its observer throw through the provider transaction.
 */
function corruptAuthoritativeItemBody(uuid: string): void {
  const doc = handle().doc;
  const item = kicadItemsMap(doc).get(uuid);
  if (!item) throw new Error(`cannot corrupt missing authoritative item ${uuid}`);
  doc.transact(() => item.set("body", "not-a-slot-tree"), "e2e-malformed-authority");
}

/** Terminal projection failures observed from the production window event. */
function observedProjectionFailures(): NativeProjectionFailure[] {
  return projectionFailures.map((failure) => ({ ...failure }));
}

/** Canonical parsed slots for one non-item root head (for native-save oracles). */
function layoutHead(fileText: string, head: string): string {
  return JSON.stringify(
    fileToDoc(fileText).layout.filter((slot) => "k" in slot && slot.k === head),
  );
}

export interface DriftSummary {
  added: string[];
  updated: string[];
  removed: string[];
  /** Compatibility field; production item comparison is exact. */
  reordered: string[];
  layoutChanged: boolean;
  /** Audited UUID item-reference layout churn; anonymous layout order is drift. */
  layoutReordered: boolean;
  metaChanged: boolean;
}

/**
 * The drift-detect convergence oracle, replicating computeDrift's core
 * (web/standalone/src/wasm/collab/drift-detect.ts) from @pcbjam/shared
 * primitives only — drift-detect itself pulls `@/lib/api`, so it can't be
 * bundled here. Serializes the live model via the tool's save fn, diffs it
 * against the room doc with the PRODUCTION comparator (driftDocDelta +
 * compareSlots). Item bodies are exact; only UUID item-reference order in the
 * layout can land in layoutReordered and stay out of a report. Null means
 * editor ≡ doc under that explicit writer-normalization policy.
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
  const layoutRelation = compareSlots(
    ydocDoc.layout,
    wasmDoc.layout,
    KICAD_WRITER_NORMALIZED_ITEM_REFERENCE_ORDER,
  );
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
      applyConcurrentRootCreations: typeof applyConcurrentRootCreations;
      applyRemoteLayout: typeof applyRemoteLayout;
      applySavedLayout: typeof applySavedLayout;
      applyRemoteDoc: typeof applyRemoteDoc;
      corruptAuthoritativeItemBody: typeof corruptAuthoritativeItemBody;
      projectionFailures: typeof observedProjectionFailures;
      layoutHead: typeof layoutHead;
      nativeWireThroughY: typeof nativeSnapshotThroughY;
      driftReport: typeof driftReport;
    };
  }
}

window.KicadCollabV2 = {
  start,
  renderActiveDoc,
  singleSeedRender,
  applyConcurrentRootCreations,
  applyRemoteLayout,
  applySavedLayout,
  applyRemoteDoc,
  corruptAuthoritativeItemBody,
  projectionFailures: observedProjectionFailures,
  layoutHead,
  nativeWireThroughY: nativeSnapshotThroughY,
  driftReport,
};
