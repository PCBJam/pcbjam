import { useEffect, useMemo } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useParams, useSearchParams } from "react-router-dom";
import { parseToolParam, toolForFile, type Tool } from "@pcbjam/shared";
import { Loader2 } from "lucide-react";
import {
  createProjectFileIfMissing,
  fetchFileBytes,
  observedFileRevision,
  rememberFileBaseRevision,
  rememberFileObservedRevision,
  uploadFileBytes,
  useProjectBoot,
  useSourceDescriptor,
} from "@/lib/api";
import { narrowBootForViewer } from "@/lib/boot-payload";
import { API_BASE_URL, currentScope, docSourceConfig } from "@/lib/config";
import { withCopyParam } from "@/lib/copy-context";
import {
  copyForcesReadOnly,
  copyNotReady,
  isConnectedCopy,
  refBadgeText,
  startGitTouchLoop,
} from "@/lib/git-view";
import { configureGitProvenance, refreshChangedPaths } from "@/lib/git-provenance";
import { decodeRoutePath } from "@/lib/route-path";
import { isMobileMode } from "@/lib/mobile-mode";
import { rememberMobileMode } from "@/lib/mobile-mode-choice";
import {
  canChooseMode,
  resolveCommentAccess,
  resolveReadOnly,
} from "@/lib/read-only-mode";
import { MobileModeGate } from "@/components/MobileModeGate";
import { WasmTool } from "@/components/WasmTool";
import { PreflightGate } from "@/preflight/PreflightGate";

export function ToolPage() {
  const params = useParams();
  const [search] = useSearchParams();
  const slug = params.name ?? "";
  // Two shapes render here: a fileless tool boot (`…/-/:tool`) sets params.tool;
  // a file route (`…/*`) sets the splat — the tool is inferred from its extension
  // unless `?tool=` overrides it.
  // Router leaves the splat percent-encoded (named params are decoded) — see
  // decodeRoutePath. Everything downstream wants the decoded path.
  const rawSplat = params["*"] || undefined;
  const splat = rawSplat ? decodeRoutePath(rawSplat) : undefined;
  const tool: Tool | null = params.tool
    ? parseToolParam(params.tool)
    : (parseToolParam(search.get("tool")) ?? (splat ? toolForFile(splat) : null));
  const targetPath = params.tool ? undefined : splat;

  // Boot-endpoint first (one composed round-trip); getProject fallback inside.
  const { data: bootData, isLoading, error } = useProjectBoot(slug);
  const data = bootData?.data;
  const { data: sourceDescriptor } = useSourceDescriptor(slug);
  // Listing rows by path, handed to fetchFileBytes so the remote source can
  // serve unchanged files from the local body cache (project-file-cache.ts).
  const filesByPath = useMemo(
    () => new Map((data?.files ?? []).map((f) => [f.path, f])),
    [data],
  );
  // git-integration 0005: a copy still being checked out never boots the
  // editor — poll the boot until it is ready (or failed).
  const qc = useQueryClient();
  const pending = copyNotReady(data?.copy);
  useEffect(() => {
    if (pending !== "materializing") return;
    const t = setInterval(() => void qc.invalidateQueries({ queryKey: ["project-boot", slug] }), 2000);
    return () => clearInterval(t);
  }, [pending, qc, slug]);
  // Activity-driven remote checks (R-§9): while this tab is visible, tell
  // the backend someone is looking at the connected project.
  const connected = isConnectedCopy(data?.copy);
  useEffect(() => {
    if (!connected) return;
    const url = withCopyParam(
      `${API_BASE_URL.replace(/\/$/, "")}/api/scopes/${encodeURIComponent(currentScope())}/projects/${encodeURIComponent(slug)}/git/touch`,
    );
    return startGitTouchLoop(() =>
      Promise.all([
        fetch(url, {
          method: "POST",
          credentials: "include",
          headers: { "content-type": "application/json" },
          body: "{}",
        }),
        // Peers' room edits send no file hint; re-read the uncommitted list
        // on the same visible-only cadence (0006 dirtyAtWrite).
        refreshChangedPaths(),
      ]),
    );
  }, [connected, slug]);
  // Thread provenance against this copy (git-integration 0006): ancestry
  // labels and dirtyAtWrite, bound to the connected copy of this tab.
  const provenanceCopyId = connected && data?.copy?.status !== "materializing" ? data?.copy?.id ?? null : null;
  useEffect(() => {
    if (!provenanceCopyId) return;
    configureGitProvenance({ apiBase: API_BASE_URL, scope: currentScope(), project: slug, copyId: provenanceCopyId });
    void refreshChangedPaths();
    return () => configureGitProvenance(null);
  }, [provenanceCopyId, slug]);

  if (!tool) {
    return (
      <div className="container py-10 text-destructive">
        Unknown tool: {params.tool ?? splat}
      </div>
    );
  }

  if (isLoading) {
    // Same look as WasmTool's boot overlay so the boot-request wait, the
    // download screen and the editor read as ONE continuous load (no white
    // flash between them).
    return (
      <div className="fixed inset-0 flex flex-col items-center justify-center gap-3 bg-[#1a1a2e] text-white">
        <Loader2 className="animate-spin" size={32} />
        <p className="font-mono text-sm text-white/80">Loading project…</p>
      </div>
    );
  }
  if (error || !data) {
    return (
      <div className="container py-10 text-destructive">
        {(error as Error)?.message ?? "project not found"}
      </div>
    );
  }

  if (pending) {
    return (
      <div
        className="fixed inset-0 flex flex-col items-center justify-center gap-3 bg-[#1a1a2e] text-white"
        data-testid="git-checking-out"
      >
        {pending === "materializing" ? (
          <>
            <Loader2 className="animate-spin" size={32} />
            <p className="font-mono text-sm text-white/80">Checking out {data.copy?.label ?? "working copy"}…</p>
          </>
        ) : (
          <p className="font-mono text-sm text-red-300">
            This working copy could not be checked out. Pick another copy on the project page.
          </p>
        )}
      </div>
    );
  }

  // Env-selected document source (same /p/ URLs either way): with "ydoc" the collab
  // room is the live source of truth (materialized client-side on load), with "api" the
  // REST file is. EITHER WAY a save is uploaded to the backend — the backend owns the
  // project FILE LIST, so an editor-created file (e.g. a hierarchical SUBSHEET added via
  // "Add Sheet") must be registered there or it's missing on reload and the parent's
  // (sheet … child.kicad_sch) reference fails to load. In ydoc mode the room still wins
  // on reload when it holds newer state; the upload is the registration + fallback copy.
  const docSource = docSourceConfig();

  // Read-only viewer (read-only-viewer): the server's `access` capability
  // (or `?readonly=1`) turns this session into a pure viewer — no save
  // upload (absent saveBytes ⇒ MEMFS-only saves), and WasmTool disables
  // every other outbound writer + locks the wasm frame.
  // Resolved from the router's search params (not window.location) so the
  // MobileModeGate's `?mode=` write re-renders us with the new answer.
  const modeWin = { location: { search: `?${search.toString()}` } };
  // A repository view (git-integration 0005: Inspect / View latest) is an
  // immutable pinned copy — always a viewer, whatever the caller's role.
  const pinnedView = copyForcesReadOnly(data.copy);
  const readOnly = pinnedView || resolveReadOnly(data.access, modeWin);
  // Comment capability (comments-ux 0003): writers comment into the ydoc,
  // commenters through the REST comment-op route, readers only look. On a
  // view, a writer still comments — threads are project-scoped (C-D1) — but
  // through the comment-op route, like a commenter.
  const resolvedComments = resolveCommentAccess(data.access, readOnly, modeWin);
  const commentAccess =
    pinnedView && resolvedComments === "none" && (data.access === undefined || data.access === "write")
      ? "comment"
      : resolvedComments;
  const badge = refBadgeText(data.copy);
  // A read-only session boots with the VIEWER's catalog (3D-model origins
  // only). The server already does this for readers/commenters; a writer who
  // locked themselves (mobile 0002) got the full catalog in the payload, so
  // narrow it here BEFORE the lib source is seeded — no symbol/footprint
  // bundle downloads for a phone that only views or comments.
  const boot = bootData?.boot
    ? readOnly
      ? narrowBootForViewer(bootData.boot)
      : bootData.boot
    : null;
  // Mobile 0002: a writer on a phone/tablet can re-choose the session mode —
  // forget the device choice and reload without one, so the gate asks again
  // (a mode switch needs a fresh boot: the lock/writers are set up at boot).
  const onChangeMobileMode =
    isMobileMode() && canChooseMode(data.access)
      ? () => {
          rememberMobileMode(null);
          const url = new URL(window.location.href);
          url.searchParams.delete("mode");
          url.searchParams.delete("readonly");
          window.location.assign(url.toString());
        }
      : undefined;

  // PreflightGate runs the device-capability check; on a fatal mismatch it blocks
  // here (before WasmTool mounts) so the expensive WASM asset fetch is skipped.
  // fetch/upload go through the active project source (api.ts): a backend
  // project uploads saves; the static gallery downloads them to local.
  return (
    <MobileModeGate access={data.access} tool={tool}>
    <PreflightGate>
      <WasmTool
        tool={tool}
        slug={slug}
        scopeId={data.project.scopeId ?? "local"}
        projectId={data.project.id}
        files={data.files}
        targetPath={targetPath}
        fetchBytes={(relPath) =>
          fetchFileBytes(slug, relPath, filesByPath.get(relPath))
        }
        onStagedRevision={(relPath, revision) =>
          rememberFileBaseRevision(slug, relPath, revision)
        }
        observedRevision={(relPath) => observedFileRevision(slug, relPath)}
        rememberObservedRevision={(relPath, revision) =>
          rememberFileObservedRevision(slug, relPath, revision)
        }
        saveBytes={
          readOnly
            ? undefined
            : (relPath, bytes, signal) =>
                uploadFileBytes(slug, relPath, bytes, signal)
        }
        createFile={
          readOnly
            ? undefined
            : (relPath, bytes) => createProjectFileIfMissing(slug, relPath, bytes)
        }
        docSource={docSource}
        sourceDescriptor={sourceDescriptor}
        readOnly={readOnly}
        commentAccess={commentAccess}
        onChangeMobileMode={onChangeMobileMode}
        boot={boot}
      />
      {badge && (
        <div
          className="pointer-events-none fixed left-1/2 top-1 z-50 -translate-x-1/2 rounded-full bg-sky-900/90 px-3 py-0.5 font-mono text-xs text-white"
          data-testid="git-ref-badge"
        >
          {badge} · read-only
        </div>
      )}
    </PreflightGate>
    </MobileModeGate>
  );
}
