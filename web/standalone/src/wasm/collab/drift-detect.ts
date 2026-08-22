/**
 * Drift detection (ysync): periodically compare what the WASM editor would
 * actually serialize on save against what the Y.Doc represents, and report any
 * divergence so it can be tracked down later.
 *
 * Cadence (deliberately infrequent): a check runs every N Y.Doc updates and once
 * more at session end (`beforeunload`). There is NO periodic timer — an editor
 * left open for hours must never flood the backend; missing the occasional drift
 * is acceptable (another session reports it).
 *
 * The "true WASM representation" comes from the per-tool `kicadSave*` embind fns,
 * which serialize the current model to a scratch MEMFS path using the same writer
 * File→Save uses but WITHOUT firing `kicadCollab.onSave` — so a drift check never
 * looks like a user save (no upload, no peer-tab dirty flag).
 */
import {
  compareSlots,
  type DriftReportBody,
  driftDocDelta,
  fileToDoc,
  isEmptyKicadDelta,
  KICAD_WRITER_NORMALIZED_ITEM_REFERENCE_ORDER,
  type Tool,
  ydocSexprVersion,
  yToDoc,
} from "@pcbjam/shared";
import * as Y from "yjs";
import { reportDrift, reportDriftBeacon } from "@/lib/api";
import { memfsFilePath } from "../constants";

/** The embind serialize fn per collab-capable tool (see module header). */
const SAVE_FN = {
  pcbnew: "kicadSaveBoard",
  eeschema: "kicadSaveSchematic",
  pl_editor: "kicadSaveDrawingSheet",
} as const satisfies Partial<Record<Tool, string>>;

type CollabTool = keyof typeof SAVE_FN;

interface DriftModule {
  kicadSaveBoard?(path: string): void;
  kicadSaveSchematic?(path: string): void;
  kicadSaveDrawingSheet?(path: string): void;
}

export interface DriftDetectOptions {
  doc: Y.Doc;
  mod: DriftModule;
  win: { FS?: EmscriptenFS };
  tool: Tool;
  slug: string;
  targetPath: string;
  /** Run a drift check every N Y.Doc updates (default 50). No periodic timer. */
  everyN?: number;
  log?: (m: string) => void;
}

const DEFAULT_EVERY_N = 50;

/** Reports per session cap — a real reconciler bug must not flood the backend. */
const MAX_REPORTS_PER_SESSION = 20;

/**
 * djb2 over the drift-defining JSON — dedupe key, not a security hash.
 *
 * `diff.reordered` remains for report compatibility. `layoutReordered` is the
 * one audited UUID-item-reference normalization and is excluded on purpose, so
 * writer churn cannot defeat the "report a stable divergence once" rule.
 */
function driftKey(body: DriftReportBody): string {
  const { reordered: _reordered, ...diff } = body.diff;
  const canon = JSON.stringify({
    diff,
    layoutChanged: body.layoutChanged,
    metaChanged: body.metaChanged,
  });
  let h = 5381;
  for (let i = 0; i < canon.length; i++) {
    h = ((h << 5) + h + canon.charCodeAt(i)) | 0;
  }
  return h.toString(36);
}

function isCollabTool(tool: Tool): tool is CollabTool {
  return tool in SAVE_FN;
}

export interface DriftDetector {
  stop(): void;
}

/**
 * Start drift detection for one collaboratively-edited document. Returns a handle
 * whose `stop()` detaches the Y.Doc observer and the unload listener. A no-op
 * detector is returned for tools without a serialize fn (so callers need no
 * special-casing).
 */
export function startDriftDetection(opts: DriftDetectOptions): DriftDetector {
  const log = opts.log ?? (() => {});
  if (!isCollabTool(opts.tool)) return { stop() {} };

  const saveName = SAVE_FN[opts.tool];
  const rawSave = opts.mod[saveName];
  if (typeof rawSave !== "function") {
    log(`[drift] ${saveName} unavailable on this build — drift detection off`);
    return { stop() {} };
  }
  // Bind to a non-optional type so the nested computeDrift closure can invoke it.
  const save = rawSave as (path: string) => void;

  const everyN = opts.everyN && opts.everyN > 0 ? opts.everyN : DEFAULT_EVERY_N;
  const scratchPath = `${memfsFilePath(opts.slug, opts.targetPath)}.drift`;

  let changes = 0;
  let inFlight = false;
  let stopped = false;
  // Session dedupe + cap (0003 §throttle): a stable divergence recomputes to
  // the same diff every N edits — report it once, not forever. Tracked at
  // compute time (fire-and-forget sends may still fail; the server dedupes
  // against its latest stored row too, so a lost report is acceptable).
  let lastKey: string | null = null;
  let reported = 0;

  // Synchronous on purpose: serialize the live model, diff it against the Y.Doc,
  // and return the report body (or null when there's no drift, the drift is
  // unchanged since the last report, or the session cap is spent). Being fully
  // synchronous is what lets the session-end check finish during page unload.
  function computeDrift(): DriftReportBody | null {
    // Defer while collab apply work is in flight (0008 finding #10b): a save
    // on the bare embind stack during a parked apply coroutine mis-dispatches
    // (table index OOB). The next Y-update trigger retries.
    const busy = (opts.mod as { kicadCollabBusy?: () => boolean }).kicadCollabBusy;
    if (busy?.()) return null;
    save(scratchPath);
    let text: unknown;
    try {
      text = opts.win.FS?.readFile(scratchPath, { encoding: "utf8" });
    } finally {
      try {
        opts.win.FS?.unlink(scratchPath);
      } catch {
        /* scratch cleanup is best-effort */
      }
    }
    if (typeof text !== "string") return null;

    const wasmDoc = fileToDoc(text);
    const ydocDoc = yToDoc(opts.doc);
    // Item content is exact. The only ignored order class is the explicit,
    // writer-audited UUID-bearing layout-item normalization.
    const diff = driftDocDelta(ydocDoc, wasmDoc);
    // driftDocDelta covers items only; flag layout/preamble divergence separately.
    const layoutRelation = compareSlots(
      ydocDoc.layout,
      wasmDoc.layout,
      KICAD_WRITER_NORMALIZED_ITEM_REFERENCE_ORDER,
    );
    const layoutChanged = layoutRelation === "different";
    const layoutReordered = layoutRelation === "reordered";
    const metaChanged = ydocDoc.root !== wasmDoc.root;
    if (isEmptyKicadDelta(diff) && !layoutChanged && !metaChanged) return null;

    const body: DriftReportBody = {
      docPath: opts.targetPath,
      wasmDoc,
      ydocDoc,
      diff,
      layoutChanged,
      layoutReordered,
      metaChanged,
      // The docs above are version-blind (yToDoc normalizes v1/v2) — this is
      // the only signal of which storage encoding the Y.Doc actually used.
      sexprVersion: ydocSexprVersion(opts.doc),
    };
    const key = driftKey(body);
    if (key === lastKey) return null;
    if (reported >= MAX_REPORTS_PER_SESSION) return null;
    lastKey = key;
    reported++;
    return body;
  }

  async function checkOnce(): Promise<void> {
    if (stopped || inFlight) return;
    inFlight = true;
    try {
      const body = computeDrift();
      if (body) {
        log(
          `[drift] ${opts.targetPath}: +${body.diff.added.length} ~${body.diff.updated.length} -${body.diff.removed.length}` +
            `${body.diff.reordered.length ? ` (${body.diff.reordered.length} reordered, not drift)` : ""}` +
            `${body.layoutChanged ? " layout" : ""}${body.layoutReordered ? " layout-reordered" : ""}` +
            `${body.metaChanged ? " meta" : ""}`,
        );
        await reportDrift(opts.slug, body);
      }
    } catch (e) {
      log(`[drift] check failed: ${String(e)}`);
    } finally {
      inFlight = false;
    }
  }

  const onUpdate = (): void => {
    if (stopped) return;
    if (++changes >= everyN) {
      changes = 0;
      void checkOnce();
    }
  };
  opts.doc.on("update", onUpdate);

  const onBeforeUnload = (): void => {
    try {
      const body = computeDrift();
      if (body) reportDriftBeacon(opts.slug, body);
    } catch {
      /* best-effort at page close */
    }
  };
  window.addEventListener("beforeunload", onBeforeUnload);

  log(`[drift] on for ${opts.targetPath} (every ${everyN} edits + at session end)`);
  return {
    stop(): void {
      stopped = true;
      opts.doc.off("update", onUpdate);
      window.removeEventListener("beforeunload", onBeforeUnload);
    },
  };
}
