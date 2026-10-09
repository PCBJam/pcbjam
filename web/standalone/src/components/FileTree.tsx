import * as React from "react";
import { ChevronRight, CornerLeftUp, Folder } from "lucide-react";
import { formatBytes } from "@/lib/utils";
import { Button } from "@pcbjam/ui";

export interface TreeFile {
  path: string;
  size?: number;
}

/** Immediate children of `dir` ("" = root, else ends with "/"): subfolder names
 *  and the files that live directly in `dir` (not in a nested folder). */
function childrenOf(files: TreeFile[], dir: string) {
  const folders = new Map<string, number>(); // name -> descendant count
  const here: TreeFile[] = [];
  for (const f of files) {
    if (dir && !f.path.startsWith(dir)) continue;
    const rest = f.path.slice(dir.length);
    const slash = rest.indexOf("/");
    if (slash < 0) {
      here.push(f);
    } else {
      const name = rest.slice(0, slash);
      folders.set(name, (folders.get(name) ?? 0) + 1);
    }
  }
  return {
    folders: [...folders.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)),
    files: here.sort((a, b) => (a.path < b.path ? -1 : 1)),
  };
}

function baseName(path: string): string {
  const i = path.lastIndexOf("/");
  return i < 0 ? path : path.slice(i + 1);
}

/**
 * A navigable file list that understands directories: files are grouped into
 * folders (e.g. `.history/`, `.git/`) you click to descend into, with a
 * breadcrumb to climb back out. The per-file actions (open/download) are
 * supplied by the caller via `renderActions(path)` so the same tree serves both
 * the backend/gallery ProjectView and the local-folder LocalProjectView.
 */
export function FileTree({
  files,
  renderActions,
  emptyText = "No files.",
}: {
  files: TreeFile[];
  renderActions?: (path: string) => React.ReactNode;
  emptyText?: string;
}) {
  const [dir, setDir] = React.useState(""); // "" or "a/b/"
  // A folder we were in can vanish (deleted file) — fall back to root.
  React.useEffect(() => {
    if (dir && !files.some((f) => f.path.startsWith(dir))) setDir("");
  }, [dir, files]);

  const { folders, files: filesHere } = childrenOf(files, dir);
  const segs = dir ? dir.slice(0, -1).split("/") : [];
  const parent = segs.length > 1 ? segs.slice(0, -1).join("/") + "/" : "";

  return (
    <div>
      {/* Breadcrumb */}
      <div className="mb-2 flex flex-wrap items-center gap-1 text-sm text-muted-foreground">
        <Button
          type="button"
          variant="link"
          size="text"
          className="hover:text-foreground"
          onClick={() => setDir("")}
        >
          root
        </Button>
        {segs.map((s, i) => {
          const upto = segs.slice(0, i + 1).join("/") + "/";
          return (
            <React.Fragment key={upto}>
              <ChevronRight size={13} className="opacity-50" />
              <Button
                type="button"
                variant="link"
                size="text"
                className="font-mono hover:text-foreground"
                onClick={() => setDir(upto)}
              >
                {s}
              </Button>
            </React.Fragment>
          );
        })}
      </div>

      <div className="divide-y rounded-lg border">
        {dir && (
          <button
            type="button"
            className="flex w-full items-center gap-2 px-4 py-2.5 text-left text-sm text-muted-foreground hover:bg-accent"
            onClick={() => setDir(parent)}
          >
            <CornerLeftUp size={15} /> ..
          </button>
        )}

        {folders.map(([name, count]) => (
          <button
            type="button"
            key={name}
            className="flex w-full items-center justify-between gap-4 px-4 py-2.5 text-left hover:bg-accent"
            onClick={() => setDir(`${dir}${name}/`)}
          >
            <span className="flex min-w-0 items-center gap-2">
              <Folder size={15} className="shrink-0 text-muted-foreground" />
              <span className="truncate font-mono text-sm">{name}/</span>
            </span>
            <span className="flex shrink-0 items-center gap-2 text-xs text-muted-foreground">
              {count} item{count === 1 ? "" : "s"}
              <ChevronRight size={14} />
            </span>
          </button>
        ))}

        {filesHere.map((f) => (
          <div
            key={f.path}
            className="flex items-center justify-between gap-4 px-4 py-2.5"
          >
            <div className="min-w-0">
              <p className="truncate font-mono text-sm">{baseName(f.path)}</p>
              {f.size !== undefined && (
                <p className="text-xs text-muted-foreground">
                  {formatBytes(f.size)}
                </p>
              )}
            </div>
            {renderActions && (
              <div className="flex shrink-0 items-center gap-1">
                {renderActions(f.path)}
              </div>
            )}
          </div>
        ))}

        {folders.length === 0 && filesHere.length === 0 && (
          <div className="px-4 py-6 text-sm text-muted-foreground">{emptyText}</div>
        )}
      </div>
    </div>
  );
}
