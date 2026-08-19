import * as React from "react";
import {
  LOCAL_SCOPE,
  TOOL_LABELS,
  type Tool,
  projectPath,
} from "@pcbjam/shared";
import { Loader2 } from "lucide-react";
import { uploadFileBytes } from "@/lib/api";
import { currentScope } from "@/lib/config";
import { localProjectStore } from "@/lib/project-source";
import { useLocalProjects } from "@/lib/api";
import {
  defaultFileName,
  defaultKicadPro,
  newFileTemplate,
  withExtension,
} from "@/lib/new-file";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

/**
 * Create-a-new-file dialog for a document editor (mirrors the closed app's
 * NewFileDialog). Writes a minimal valid template into the target project, then
 * navigates to open it by path — so every Save persists straight back, with none
 * of the "save into the right folder" footgun of a blank editor.
 *
 * Two modes:
 *  - `project` set  → create into that existing project (file name only).
 *  - `project` unset → home mode: pick an existing browser-local project or
 *    create a new one (name + file name).
 */
const NEW = "__new__";

export function NewFileDialog({
  tool,
  onClose,
  project,
}: {
  tool: Tool | null;
  onClose: () => void;
  project?: { slug: string; existingPaths: string[] };
}) {
  const localQ = useLocalProjects();
  const store = localProjectStore();
  const [fileName, setFileName] = React.useState("");
  const [target, setTarget] = React.useState<string>(NEW);
  const [projectName, setProjectName] = React.useState("Untitled");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (tool) {
      setFileName(defaultFileName(tool));
      setProjectName("Untitled");
      setTarget(project ? project.slug : NEW);
      setError(null);
      setBusy(false);
    }
  }, [tool, project]);

  if (!tool) return null;
  const homeMode = !project;

  const submit = async () => {
    const trimmed = fileName.trim();
    if (!trimmed) {
      setError("Enter a file name.");
      return;
    }
    const finalName = withExtension(tool, trimmed);
    if (project && project.existingPaths.includes(finalName)) {
      setError(`"${finalName}" already exists in this project.`);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const bytes = new TextEncoder().encode(
        newFileTemplate(tool, crypto.randomUUID()),
      );
      const files = [{ path: finalName, bytes }];
      // A board/schematic is a project root: create its `<stem>.kicad_pro`
      // sibling with it (project-sync 0001) so KiCad opens a real project and
      // project-scoped settings (netclasses, ERC/DRC exclusions) can persist.
      const proName = finalName.replace(/\.kicad_(pcb|sch)$/, ".kicad_pro");
      if (
        proName !== finalName &&
        !(project?.existingPaths ?? []).includes(proName)
      ) {
        files.push({
          path: proName,
          bytes: new TextEncoder().encode(defaultKicadPro(proName)),
        });
      }
      let slug: string;
      if (homeMode && target === NEW) {
        if (!store) throw new Error("local project store unavailable");
        const created = await store.createProject(
          projectName.trim() || "Untitled",
          files,
        );
        slug = created.slug;
      } else {
        slug = project ? project.slug : target;
        for (const f of files) {
          const outcome = await uploadFileBytes(slug, f.path, f.bytes);
          if (outcome.kind !== "committed") {
            throw new Error(
              outcome.message ?? `upload did not commit: ${f.path}`,
            );
          }
        }
      }
      // Full navigation so Emscripten boots into a clean page opening the file.
      // A home-created project is browser-local (@local scope); an in-project new
      // file keeps the current scope. The tool is inferred from the file's ext.
      const scope = homeMode ? LOCAL_SCOPE : currentScope();
      window.location.assign(projectPath(scope, slug, finalName));
    } catch (e) {
      setBusy(false);
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New {TOOL_LABELS[tool]} file</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          {homeMode && (
            <div>
              <Label htmlFor="newfile-project">Project</Label>
              <select
                id="newfile-project"
                className="mt-1 h-9 w-full rounded-md border bg-transparent px-3 text-sm"
                value={target}
                disabled={busy}
                onChange={(e) => setTarget(e.target.value)}
              >
                <option value={NEW}>New project…</option>
                {(localQ.data ?? []).map((p) => (
                  <option key={p.slug} value={p.slug}>
                    {p.name}
                  </option>
                ))}
              </select>
            </div>
          )}
          {homeMode && target === NEW && (
            <div>
              <Label htmlFor="newfile-projectname">Project name</Label>
              <Input
                id="newfile-projectname"
                value={projectName}
                disabled={busy}
                onChange={(e) => setProjectName(e.target.value)}
              />
            </div>
          )}
          <div>
            <Label htmlFor="newfile-name">File name</Label>
            <Input
              id="newfile-name"
              value={fileName}
              autoFocus
              disabled={busy}
              onChange={(e) => setFileName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void submit();
              }}
            />
            <p className="mt-1 text-xs text-muted-foreground">
              Created in the project, then opened in the editor — saves persist
              back to it.
            </p>
          </div>
          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>
        <DialogFooter>
          <Button onClick={() => void submit()} disabled={busy}>
            {busy && <Loader2 className="mr-1 animate-spin" />} Create &amp; open
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
