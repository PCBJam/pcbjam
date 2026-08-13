import { useParams, useSearchParams } from "react-router-dom";
import { parseToolParam, toolForFile, type Tool } from "@pcbjam/shared";
import {
  createProjectFileIfMissing,
  fetchFileBytes,
  refreshFileRevision,
  uploadFileBytes,
  useProject,
  useSourceDescriptor,
} from "@/lib/api";
import { docSourceConfig } from "@/lib/config";
import { decodeRoutePath } from "@/lib/route-path";
import { resolveReadOnly } from "@/lib/read-only-mode";
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

  const { data, isLoading, error } = useProject(slug);
  const { data: sourceDescriptor } = useSourceDescriptor(slug);

  if (!tool) {
    return (
      <div className="container py-10 text-destructive">
        Unknown tool: {params.tool ?? splat}
      </div>
    );
  }

  if (isLoading) {
    return <div className="container py-10 text-muted-foreground">loading…</div>;
  }
  if (error || !data) {
    return (
      <div className="container py-10 text-destructive">
        {(error as Error)?.message ?? "project not found"}
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
  const readOnly = resolveReadOnly(data.access);

  // PreflightGate runs the device-capability check; on a fatal mismatch it blocks
  // here (before WasmTool mounts) so the expensive WASM asset fetch is skipped.
  // fetch/upload go through the active project source (api.ts): a backend
  // project uploads saves; the static gallery downloads them to local.
  return (
    <PreflightGate>
      <WasmTool
        tool={tool}
        slug={slug}
        scopeId={data.project.scopeId ?? "local"}
        projectId={data.project.id}
        files={data.files}
        targetPath={targetPath}
        fetchBytes={(relPath) => fetchFileBytes(slug, relPath)}
        saveBytes={
          readOnly
            ? undefined
            : async (relPath, bytes, signal) => {
                try {
                  const outcome = await uploadFileBytes(
                    slug,
                    relPath,
                    bytes,
                    signal,
                  );
                  if (outcome.kind === "unknown") {
                    // Observation is diagnostic only. It cannot rebase this
                    // in-memory model or authorize another write, and it must
                    // not delay the hook's absorbing safety block.
                    void refreshFileRevision(slug, relPath).catch(() => {});
                  }
                  return outcome;
                } catch (error) {
                  // The server can commit before a response is lost. Refresh
                  // only for diagnostics and a future remount; save-flow treats
                  // this unexpected exception as unknown and blocks this path.
                  if (!signal?.aborted) {
                    void refreshFileRevision(slug, relPath).catch(() => {});
                  }
                  throw error;
                }
              }
        }
        createFile={
          readOnly
            ? undefined
            : (relPath, bytes) => createProjectFileIfMissing(slug, relPath, bytes)
        }
        docSource={docSource}
        sourceDescriptor={sourceDescriptor}
        readOnly={readOnly}
      />
    </PreflightGate>
  );
}
