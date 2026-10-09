import { mapLimit } from "@pcbjam/shared";
import * as React from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import {
  EXTENSION_TOOL,
  FILELESS_TOOLS,
  TOOL_LABELS,
  type Tool,
  projectPath,
  projectToolPath,
} from "@pcbjam/shared";
import {
  ArrowLeft,
  Download,
  ExternalLink,
  Loader2,
  Trash2,
} from "lucide-react";
import { fetchFileBytes, useProject, useSourceDescriptor } from "@/lib/api";
import { downloadBytes } from "@/lib/download";
import { localProjectStore } from "@/lib/project-source";
import { zipFiles } from "@/lib/zip";
import { Button, Tip } from "@pcbjam/ui";
import { SourceChip } from "@/components/SourceChip";
import { ToolGrid } from "@/components/ToolGrid";
import { FileTree } from "@/components/FileTree";
import { NewFileDialog } from "@/components/NewFileDialog";

function toolForPath(path: string): Tool | null {
  const dot = path.lastIndexOf(".");
  if (dot < 0) return null;
  return EXTENSION_TOOL[path.slice(dot).toLowerCase()] ?? null;
}

/**
 * Project-centric view (mirrors the closed app): an iconed tool launcher (same
 * cards as the home page) + the project's files as a navigable folder tree.
 * Opening a read-only GALLERY project auto-"moves it to local" — it's copied
 * into a writable browser-local project at the same slug, so the composite source
 * shadows the gallery and this view re-resolves as a local, editable project.
 */
export function ProjectView() {
  const { scope = "", name: slug = "" } = useParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { data, isLoading, error } = useProject(slug);
  const { data: descriptor } = useSourceDescriptor(slug);
  const isLocal = descriptor?.kind === "local";
  const isRemoteRo = descriptor?.kind === "remote-ro";
  const store = localProjectStore();
  const [busy, setBusy] = React.useState(false);
  const [newFileTool, setNewFileTool] = React.useState<Tool | null>(null);
  const [forkError, setForkError] = React.useState<string | null>(null);
  const forkStartedRef = React.useRef(false);

  // Auto "move to local": a read-only gallery project is copied into a writable
  // browser-local project at the SAME slug. The composite source then routes this
  // /p/:slug to the local copy (local wins), and invalidating the queries re-
  // resolves this view as local — no button, no URL change. Runs once.
  React.useEffect(() => {
    if (!isRemoteRo || !store || !data || forkStartedRef.current) return;
    forkStartedRef.current = true;
    void (async () => {
      try {
        if (!(await store.hasProject(slug))) {
          const files = await mapLimit(data.files, 8, async (f) => ({
            path: f.path,
            bytes: await fetchFileBytes(slug, f.path),
          }));
          await store.createProject(data.project.name, files, { slug });
        }
        await qc.invalidateQueries({ queryKey: ["local-projects"] });
        await qc.invalidateQueries({ queryKey: ["source-descriptor", slug] });
        await qc.invalidateQueries({ queryKey: ["project", slug] });
      } catch (e) {
        setForkError(e instanceof Error ? e.message : String(e));
      }
    })();
  }, [isRemoteRo, store, data, slug, qc]);

  const exportZip = async () => {
    if (!store) return;
    setBusy(true);
    try {
      downloadBytes(`${slug}.zip`, zipFiles(await store.readFiles(slug)));
    } finally {
      setBusy(false);
    }
  };

  const downloadOne = async (path: string) => {
    downloadBytes(path, await fetchFileBytes(slug, path));
  };

  const remove = async () => {
    if (!store || !data) return;
    if (!window.confirm(`Delete "${data.project.name}" from this browser? This can't be undone.`))
      return;
    await store.deleteProject(slug);
    await qc.invalidateQueries({ queryKey: ["local-projects"] });
    navigate("/");
  };

  // A tool launched from the grid: file-less tools (gerber/calculator + the
  // symbol/footprint editors, which load the full project lib set) open project-
  // scoped with a full reload; document tools create a templated file first.
  const launchTool = (tool: Tool) => {
    if (FILELESS_TOOLS.has(tool)) {
      window.location.assign(projectToolPath(scope, slug, tool));
    } else {
      setNewFileTool(tool);
    }
  };

  const renderFileActions = (path: string) => {
    const tool = toolForPath(path);
    return (
      <>
        {isLocal && (
          <Tip content="Download this file">
            <button
              className="inline-flex items-center gap-1 rounded-md border px-2.5 py-1.5 text-sm hover:bg-accent"
              onClick={() => void downloadOne(path)}
            >
              <Download size={14} />
            </button>
          </Tip>
        )}
        {tool && (
          <a
            className="inline-flex items-center gap-1 rounded-md border px-3 py-1.5 text-sm hover:bg-accent"
            href={projectPath(scope, slug, path)}
          >
            <ExternalLink size={14} /> Open in {TOOL_LABELS[tool]}
          </a>
        )}
      </>
    );
  };

  const movingToLocal = isRemoteRo && !!store && !forkError;

  return (
    <div className="container py-10">
      <Button asChild variant="ghost" size="sm" className="mb-4">
        <Link to="/">
          <ArrowLeft /> Home
        </Link>
      </Button>

      {isLoading && (
        <p className="flex items-center gap-2 text-muted-foreground">
          <Loader2 className="animate-spin" /> loading…
        </p>
      )}
      {error && <p className="text-destructive">{(error as Error).message}</p>}

      {data && (
        <>
          <div className="mb-6">
            <h1 className="flex flex-wrap items-center gap-3 text-2xl font-semibold tracking-tight">
              {data.project.name}
              {descriptor && <SourceChip descriptor={descriptor} />}
            </h1>
            <p className="text-sm text-muted-foreground">
              {data.project.scope}/projects/{data.project.slug}
            </p>
          </div>

          {movingToLocal ? (
            <p className="flex items-center gap-2 text-muted-foreground">
              <Loader2 className="animate-spin" /> Preparing your editable copy…
            </p>
          ) : (
            <>
              {forkError && (
                <p className="mb-4 text-sm text-destructive">
                  Couldn't prepare a local copy: {forkError}
                </p>
              )}

              {/* Tools — same iconed launcher as the home page. */}
              <section className="mb-8">
                <h2 className="mb-3 text-lg font-medium">Tools</h2>
                <ToolGrid onLaunch={launchTool} />
              </section>

              {/* Project-level actions (local projects). */}
              {isLocal && (
                <div className="mb-6 flex flex-wrap gap-3">
                  <Button variant="outline" size="sm" disabled={busy} onClick={() => void exportZip()}>
                    {busy ? <Loader2 className="animate-spin" size={15} /> : <Download size={15} />}
                    Download .zip
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="text-destructive hover:text-destructive"
                    onClick={() => void remove()}
                  >
                    <Trash2 size={15} /> Delete
                  </Button>
                </div>
              )}

              <h2 className="mb-3 text-lg font-medium">
                Files ({data.files.length})
              </h2>
              <FileTree
                files={data.files}
                renderActions={renderFileActions}
                emptyText="No files yet — use the Tools above to create one."
              />
            </>
          )}

          <NewFileDialog
            tool={newFileTool}
            onClose={() => setNewFileTool(null)}
            project={{ slug, existingPaths: data.files.map((f) => f.path) }}
          />
        </>
      )}
    </div>
  );
}
