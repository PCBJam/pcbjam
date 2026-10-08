import {
  EXTENSION_TOOL,
  LIB_EXTENSION_TOOL,
  TOOL_LABELS,
  type Tool,
} from "@pcbjam/shared";
import { ArrowLeft, ExternalLink, FolderOpen, Library } from "lucide-react";
import { Button } from "@pcbjam/ui";
import { ToolGrid } from "@/components/ToolGrid";
import { FileTree } from "@/components/FileTree";

export interface LocalFile {
  path: string;
  size?: number;
}

function ext(path: string): string {
  const dot = path.lastIndexOf(".");
  return dot < 0 ? "" : path.slice(dot).toLowerCase();
}

function toolForPath(path: string): Tool | null {
  return EXTENSION_TOOL[ext(path)] ?? null;
}

/** A library file (.kicad_sym / .kicad_mod) → the editor that opens it scoped. */
function libToolForPath(path: string): Tool | null {
  return LIB_EXTENSION_TOOL[ext(path)] ?? null;
}

/**
 * The local-folder twin of ProjectView: the same iconed tool launcher + a
 * navigable folder tree of the picked folder's files. Unlike backend projects
 * this CANNOT navigate (the folder handles / File objects live in this page's JS
 * memory and don't survive a reload), so opening is a callback that swaps this
 * view for the editor in-place — and "Back" only works until a tool has launched
 * (the WASM runtime is one-shot per page load).
 */
export function LocalProjectView({
  name,
  files,
  onOpen,
  onOpenLib,
  onBack,
}: {
  name: string;
  files: LocalFile[];
  /** Launch a tool; `path` is undefined for file-less / blank-document launches. */
  onOpen: (tool: Tool, path?: string) => void;
  /** Open a local library FILE (.kicad_sym/.kicad_mod) scoped in its editor. */
  onOpenLib: (tool: Tool, path: string) => void;
  onBack: () => void;
}) {
  const renderActions = (path: string) => {
    const tool = toolForPath(path);
    const libTool = tool ? null : libToolForPath(path);
    return (
      <>
        {tool && (
          <button
            className="inline-flex items-center gap-1 rounded-md border px-3 py-1.5 text-sm hover:bg-accent"
            onClick={() => onOpen(tool, path)}
          >
            <ExternalLink size={14} /> Open in {TOOL_LABELS[tool]}
          </button>
        )}
        {libTool && (
          <button
            className="inline-flex items-center gap-1 rounded-md border px-3 py-1.5 text-sm hover:bg-accent"
            onClick={() => onOpenLib(libTool, path)}
          >
            <Library size={14} /> Open in {TOOL_LABELS[libTool]}
          </button>
        )}
      </>
    );
  };

  return (
    <div className="container py-10">
      <Button variant="ghost" size="sm" className="mb-4" onClick={onBack}>
        <ArrowLeft /> Back
      </Button>

      <div className="mb-6">
        <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
          <FolderOpen size={22} /> {name}
        </h1>
        <p className="text-sm text-muted-foreground">
          local folder — files stay in your browser
        </p>
      </div>

      {/* Tools — same iconed launcher as the home page. */}
      <section className="mb-8">
        <h2 className="mb-3 text-lg font-medium">Tools</h2>
        <ToolGrid onLaunch={(tool) => onOpen(tool)} />
      </section>

      <h2 className="mb-3 text-lg font-medium">Files ({files.length})</h2>
      <FileTree
        files={files}
        renderActions={renderActions}
        emptyText="No files in this folder."
      />
    </div>
  );
}
