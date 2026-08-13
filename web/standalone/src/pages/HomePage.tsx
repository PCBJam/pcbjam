import * as React from "react";
import { useNavigate } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { type Tool, libPath, projectPath } from "@pcbjam/shared";
import { ThemeToggle } from "@/components/ThemeToggle";
import { FolderOpen, Library, Loader2, Package } from "lucide-react";
import { useLibs } from "@/lib/api";
import {
  LOCAL_PROJECTS_ENABLED,
  PROJECT_SOURCE_KIND,
  currentScope,
} from "@/lib/config";
import { localFileLibsSource } from "@/wasm/libs/local-file-source";
import type { LibsSource } from "@/wasm/libs/source";
import { downloadBytes } from "@/lib/download";
import { importFileList, importFsaFolder } from "@/lib/import-folder";
import { localProjectStore } from "@/lib/project-source";
import { isDocumentTool } from "@/lib/new-file";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ToolGrid } from "@/components/ToolGrid";
import { ProjectsSection } from "@/components/ProjectsSection";
import { WaitlistForm } from "@/components/WaitlistForm";
import { NewFileDialog } from "@/components/NewFileDialog";
import { SAVE_COMMITTED, type SaveBytes } from "@/wasm/save-flow";
import { LocalProjectView, type LocalFile } from "@/components/LocalProjectView";
import { StorageUsageCard } from "@/components/StorageUsageCard";
import { WasmTool } from "@/components/WasmTool";

/** A KiCad project picked from the local filesystem (no backend involved). */
interface LocalProject {
  name: string;
  files: LocalFile[];
  fetchBytes: (relPath: string) => Promise<Uint8Array>;
  /**
   * Where editor saves land: write-back through File System Access handles
   * (folder picked via showDirectoryPicker), or a browser download per save
   * (webkitdirectory fallback — its FileList grants no write access).
   */
  saveBytes: SaveBytes;
}

/**
 * Build a LocalProject over File System Access handles (showDirectoryPicker,
 * Chromium): reads come from the live files, and editor saves are written
 * straight back to the user's folder on disk.
 */
async function buildFsaProject(root: FileSystemDirectoryHandle): Promise<LocalProject> {
  const handles = new Map<string, FileSystemFileHandle>();
  const files: LocalFile[] = [];
  async function walk(dir: FileSystemDirectoryHandle, prefix: string): Promise<void> {
    for await (const [name, handle] of dir.entries()) {
      if (handle.kind === "file") {
        const fh = handle as FileSystemFileHandle;
        handles.set(prefix + name, fh);
        files.push({ path: prefix + name, size: (await fh.getFile()).size });
      } else {
        await walk(handle as FileSystemDirectoryHandle, `${prefix}${name}/`);
      }
    }
  }
  await walk(root, "");
  return {
    name: root.name,
    files,
    fetchBytes: async (relPath) => {
      const handle = handles.get(relPath);
      if (!handle) throw new Error(`local file not found: ${relPath}`);
      return new Uint8Array(await (await handle.getFile()).arrayBuffer());
    },
    saveBytes: async (relPath, bytes) => {
      // Resolve (and create — the editor may save a brand-new file, e.g. a
      // .kicad_pro next to a board) the path under the picked root.
      const segs = relPath.split("/");
      const fileName = segs.pop();
      if (!fileName) throw new Error(`invalid save path: ${relPath}`);
      let dir = root;
      for (const seg of segs) dir = await dir.getDirectoryHandle(seg, { create: true });
      const handle =
        handles.get(relPath) ?? (await dir.getFileHandle(fileName, { create: true }));
      handles.set(relPath, handle);
      const writable = await handle.createWritable();
      await writable.write(bytes as unknown as FileSystemWriteChunkType);
      await writable.close();
      return SAVE_COMMITTED;
    },
  };
}

/** Build a LocalProject from a webkitdirectory FileList, stripping the top folder. */
function buildLocalProject(fileList: FileList): LocalProject {
  const map = new Map<string, File>();
  const first = fileList[0];
  const topPrefix =
    first?.webkitRelativePath?.includes("/")
      ? first.webkitRelativePath.split("/")[0] + "/"
      : "";
  for (const f of Array.from(fileList)) {
    const rel = f.webkitRelativePath || f.name;
    map.set(rel.startsWith(topPrefix) ? rel.slice(topPrefix.length) : rel, f);
  }
  const files: LocalFile[] = [...map.entries()].map(([path, f]) => ({
    path,
    size: f.size,
  }));
  return {
    name: topPrefix ? topPrefix.slice(0, -1) : "local",
    files,
    fetchBytes: async (relPath) => {
      const f = map.get(relPath);
      if (!f) throw new Error(`local file not found: ${relPath}`);
      return new Uint8Array(await f.arrayBuffer());
    },
    // A webkitdirectory FileList is read-only — saves become downloads.
    saveBytes: async (relPath, bytes) => {
      downloadBytes(relPath, bytes);
      return SAVE_COMMITTED;
    },
  };
}

export function HomePage() {
  // Static (no-backend) demo mode: projects come from a read-only CDN gallery,
  // there are no backend libraries, and editor saves download to local.
  const staticMode = PROJECT_SOURCE_KIND === "static";
  // When on, loaded folders import into a browser-local (IDB) project with its
  // own URL instead of the in-page File System Access write-back flow.
  const localEnabled = LOCAL_PROJECTS_ENABLED;
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const symbolLibs = useLibs("symbol");
  const footprintLibs = useLibs("footprint");
  const inputRef = React.useRef<HTMLInputElement>(null);
  const [local, setLocal] = React.useState<LocalProject | null>(null);
  const [launched, setLaunched] = React.useState<{ tool: Tool; target?: string } | null>(
    null,
  );
  // A tool launched straight from the home page — no local folder, no backend
  // project. File-less editors browse backend libraries; document editors
  // (schematic/PCB/drawing sheet) boot to a blank document (KiCad-launcher style).
  // `libsSource`, when set, scopes the editor to ONE library (a backend lib, or a
  // local lib file); omitted ⇒ the editor's configured default source.
  const [launchedTool, setLaunchedTool] = React.useState<{
    tool: Tool;
    libsSource?: LibsSource | null;
  } | null>(null);
  // A document tool launched from the grid with the local store on → ask for a
  // name + project (new-file dialog) instead of booting a throwaway blank doc.
  const [newFileTool, setNewFileTool] = React.useState<Tool | null>(null);

  // <input webkitdirectory> is non-standard; set it imperatively.
  React.useEffect(() => {
    if (inputRef.current) inputRef.current.setAttribute("webkitdirectory", "");
  }, []);

  // Import a picked folder into the browser-local store as a new editable
  // project, then open it at its own /p/:slug URL. The original disk files are
  // untouched (this is a copy); edits persist to IDB, export via Download .zip.
  const importToLocal = async (imported: { name: string; files: { path: string; bytes: Uint8Array }[] }) => {
    const store = localProjectStore();
    if (!store) return;
    const project = await store.createProject(imported.name, imported.files);
    await queryClient.invalidateQueries({ queryKey: ["local-projects"] });
    navigate(projectPath(project.scope, project.slug));
  };

  // Tool launched from the home page: no project, no files. File-less editors
  // read libraries from the backend (libsSourceConfig) and persist through the
  // lib write bridge; document editors open a blank document. Either way there's
  // no project fetch/save plumbing to wire.
  if (launchedTool) {
    return (
      <WasmTool
        tool={launchedTool.tool}
        slug="local"
        scopeId="local"
        projectId="local"
        files={[]}
        libsSource={launchedTool.libsSource}
        fetchBytes={async (p) => {
          throw new Error(`no project file to fetch: ${p}`);
        }}
      />
    );
  }

  // Once launched over a local folder, the WASM runtime is process-global and
  // one-shot for this page load — render the editor full-screen and nothing else.
  if (local && launched) {
    return (
      <WasmTool
        tool={launched.tool}
        slug="local"
        scopeId="local"
        projectId="local"
        files={local.files}
        targetPath={launched.target}
        fetchBytes={local.fetchBytes}
        saveBytes={local.saveBytes}
      />
    );
  }

  // Folder picked but no tool launched yet: the local twin of ProjectView.
  if (local) {
    return (
      <LocalProjectView
        name={local.name}
        files={local.files}
        onOpen={(tool, path) => setLaunched({ tool, target: path })}
        onOpenLib={(tool, path) => {
          void (async () => {
            const bytes = await local.fetchBytes(path);
            const text = new TextDecoder().decode(bytes);
            const id = (path.split("/").pop() ?? path).replace(
              /\.(kicad_sym|kicad_mod)$/i,
              "",
            );
            const kind = tool === "footprint_editor" ? "footprint" : "symbol";
            setLaunchedTool({
              tool,
              libsSource: localFileLibsSource(id, text, kind),
            });
          })();
        }}
        onBack={() => setLocal(null)}
      />
    );
  }

  return (
    <div className="container max-w-3xl py-10">
      <h1 className="flex items-center gap-2.5 text-2xl font-semibold tracking-tight">
        PCBJam
        <span className="rounded-full border border-amber-500/50 bg-amber-500/10 px-2.5 py-0.5 text-xs font-medium text-amber-600 dark:text-amber-400">
          Early-access alpha
        </span>
        <ThemeToggle className="ml-auto" />
      </h1>
      <p className="mb-8 text-sm text-muted-foreground">
        {staticMode
          ? "Edit KiCad files in your browser — open an example below or your own local folder. Nothing is uploaded; Save downloads to your machine."
          : "Open KiCad files in the browser — from a backend, or straight from a local folder."}
      </p>

      {/* --- Local folder --- */}
      <section className="mb-10 rounded-lg border p-5">
        <h2 className="mb-1 flex items-center gap-2 text-lg font-medium">
          <FolderOpen size={18} /> Open a local folder
        </h2>
        <p className="mb-4 text-sm text-muted-foreground">
          {localEnabled
            ? "No upload — a copy is imported into this browser as an editable project (your original files aren't touched). Save persists here; export anytime with Download .zip."
            : "No upload — files stay in your browser. Pick a folder containing a KiCad project."}
        </p>
        {window.showDirectoryPicker ? (
          <Button
            variant="outline"
            onClick={() => {
              void (async () => {
                let root: FileSystemDirectoryHandle;
                try {
                  // Import only needs read; the write-back flow needs readwrite.
                  root = await window.showDirectoryPicker!({
                    mode: localEnabled ? "read" : "readwrite",
                  });
                } catch {
                  return; // user cancelled the picker / denied access
                }
                if (localEnabled) await importToLocal(await importFsaFolder(root));
                else setLocal(await buildFsaProject(root));
              })();
            }}
          >
            <FolderOpen size={16} /> Choose folder
          </Button>
        ) : (
          // No File System Access API (Firefox/Safari): folder input. With the
          // local store on, the files are imported into IDB; otherwise it's a
          // read-only session where editor saves arrive as browser downloads.
          <input
            ref={inputRef}
            type="file"
            multiple
            className="block text-sm"
            onChange={(e) => {
              const fl = e.target.files;
              if (!fl || fl.length === 0) return;
              if (localEnabled) {
                void (async () => importToLocal(await importFileList(fl)))();
              } else {
                setLocal(buildLocalProject(fl));
              }
            }}
          />
        )}
      </section>

      {/* --- Projects (browser-local + the gallery/backend, one list with
              a per-row source chip) --- */}
      <ProjectsSection />

      {/* --- Waitlist signup (sits between projects and tools) --- */}
      <WaitlistForm />

      {/* --- Tools (KiCad-style launcher for the standalone tools) --- */}
      <section className="mb-10">
        <h2 className="mb-3 text-lg font-medium">Tools</h2>
        <ToolGrid
          onLaunch={(tool) =>
            localEnabled && isDocumentTool(tool)
              ? setNewFileTool(tool)
              : setLaunchedTool({ tool })
          }
        />
      </section>

      <NewFileDialog tool={newFileTool} onClose={() => setNewFileTool(null)} />

      {/* --- Libraries (the configured source: the read-only CDN/R2 set in the
              demo, or a backend's libs). Each lib opens scoped in its editor. --- */}
      <section>
        <h2 className="mb-3 text-lg font-medium">Libraries</h2>
        <div className="space-y-3">
          <LibGroup
            icon={<Library size={16} />}
            label="Symbols"
            query={symbolLibs}
            tool="symbol_editor"
          />
          <LibGroup
            icon={<Package size={16} />}
            label="Footprints"
            query={footprintLibs}
            tool="footprint_editor"
          />
        </div>
      </section>

      {/* --- Browser storage: per-kind cache sizes + delete-3D-cache. --- */}
      <div className="mt-10">
        <StorageUsageCard />
      </div>
    </div>
  );
}

/**
 * One library group (Symbols / Footprints): each lib is a deep-link to
 * `/l/<libId>/<tool>` (LibToolPage), which boots the editor scoped to that one
 * library. A full navigation (anchor) gives Emscripten a clean page. The full
 * KiCad set is hundreds of libs, so past a threshold we add a name filter and
 * scroll the chip list.
 */
function LibGroup({
  icon,
  label,
  query,
  tool,
}: {
  icon: React.ReactNode;
  label: string;
  query: ReturnType<typeof useLibs>;
  tool: Tool;
}) {
  const { data: libs, isLoading, error } = query;
  const [filter, setFilter] = React.useState("");
  const showFilter = (libs?.length ?? 0) > 12;
  const needle = filter.trim().toLowerCase();
  const shown = needle
    ? (libs ?? []).filter((l) => l.name.toLowerCase().includes(needle))
    : libs ?? [];

  return (
    <div className="rounded-lg border p-4">
      <h3 className="mb-2 flex items-center gap-2 text-sm font-medium">
        {icon} {label}
        {libs && libs.length > 0 && (
          <span className="text-xs font-normal text-muted-foreground">
            {libs.length}
          </span>
        )}
      </h3>
      {isLoading && (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="animate-spin" size={14} /> loading…
        </p>
      )}
      {error && (
        <p className="text-sm text-muted-foreground">
          Couldn't load libraries.
        </p>
      )}
      {libs && libs.length === 0 && !isLoading && (
        <p className="text-sm text-muted-foreground">
          No {label.toLowerCase()} libraries.
        </p>
      )}
      {libs && libs.length > 0 && (
        <>
          {showFilter && (
            <Input
              type="search"
              value={filter}
              placeholder={`Filter ${libs.length} ${label.toLowerCase()}…`}
              onChange={(e) => setFilter(e.target.value)}
              className="mb-2 h-8"
            />
          )}
          <div className="flex max-h-72 flex-wrap gap-2 overflow-y-auto">
            {shown.map((lib) => (
              <a
                key={lib.id}
                href={`${libPath(currentScope(), lib.id)}?tool=${tool}`}
                title={lib.description ?? undefined}
                className="inline-flex h-fit items-center gap-1.5 rounded-md border px-2.5 py-1 text-sm hover:bg-accent"
              >
                {lib.name}
                {lib.itemCount !== undefined && (
                  <span className="text-xs text-muted-foreground">
                    {lib.itemCount}
                  </span>
                )}
              </a>
            ))}
            {shown.length === 0 && (
              <p className="text-sm text-muted-foreground">No matches.</p>
            )}
          </div>
        </>
      )}
    </div>
  );
}
