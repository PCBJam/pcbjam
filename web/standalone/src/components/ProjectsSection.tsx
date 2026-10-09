import * as React from "react";
import { Link } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { type Project, projectPath } from "@pcbjam/shared";
import { Download, Loader2, Pencil, Trash2 } from "lucide-react";
import { useLocalProjects, useProjects } from "@/lib/api";
import { PROJECT_SOURCE_KIND } from "@/lib/config";
import { downloadBytes } from "@/lib/download";
import { localProjectStore } from "@/lib/project-source";
import {
  SOURCE_DESCRIPTORS,
  type SourceDescriptor,
} from "@/lib/project-source-shared";
import { zipFiles } from "@/lib/zip";
import { Button, Tip } from "@pcbjam/ui";
import { SourceChip } from "@/components/SourceChip";

/**
 * The unified "Projects" list: browser-local projects (imported folders + saved
 * work) and the configured remote source (the CDN gallery, or a backend) in one
 * list, each ROW carrying its own source chip so the kind is explicit per
 * project rather than per section. Local rows are writable (export / rename /
 * delete); remote rows just open.
 */
export function ProjectsSection() {
  const localQ = useLocalProjects();
  const primaryQ = useProjects();
  const qc = useQueryClient();
  const store = localProjectStore();
  const [busy, setBusy] = React.useState<string | null>(null);

  const staticMode = PROJECT_SOURCE_KIND === "static";
  const remoteDescriptor: SourceDescriptor = staticMode
    ? SOURCE_DESCRIPTORS["remote-ro"]
    : SOURCE_DESCRIPTORS["remote-rw"];

  const local = localQ.data ?? [];
  const localSlugs = new Set(local.map((p) => p.slug));
  const remote = (primaryQ.data ?? []).filter((p) => !localSlugs.has(p.slug));

  const refresh = () => qc.invalidateQueries({ queryKey: ["local-projects"] });

  const exportZip = async (slug: string) => {
    if (!store) return;
    setBusy(slug);
    try {
      downloadBytes(`${slug}.zip`, zipFiles(await store.readFiles(slug)));
    } finally {
      setBusy(null);
    }
  };
  const rename = async (slug: string, current: string) => {
    if (!store) return;
    const name = window.prompt("Rename project", current)?.trim();
    if (!name || name === current) return;
    await store.renameProject(slug, name);
    void refresh();
  };
  const remove = async (slug: string, name: string) => {
    if (!store) return;
    if (!window.confirm(`Delete "${name}" from this browser? This can't be undone.`))
      return;
    await store.deleteProject(slug);
    void refresh();
  };

  const empty = local.length === 0 && remote.length === 0;

  return (
    <section className="mb-10">
      <h2 className="mb-3 text-lg font-medium">Projects</h2>

      {primaryQ.isLoading && empty && (
        <p className="mb-2 flex items-center gap-2 text-muted-foreground">
          <Loader2 className="animate-spin" /> loading…
        </p>
      )}

      <div className="divide-y rounded-lg border">
        {local.map((p) => (
          <ProjectRow key={p.id} project={p} descriptor={SOURCE_DESCRIPTORS.local}>
            <Tip content="Download .zip">
              <Button
                variant="ghost"
                size="sm"
                disabled={busy === p.slug}
                onClick={() => void exportZip(p.slug)}
              >
                {busy === p.slug ? (
                  <Loader2 className="animate-spin" size={15} />
                ) : (
                  <Download size={15} />
                )}
              </Button>
            </Tip>
            <Tip content="Rename">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => void rename(p.slug, p.name)}
              >
                <Pencil size={15} />
              </Button>
            </Tip>
            <Tip content="Delete">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => void remove(p.slug, p.name)}
              >
                <Trash2 size={15} />
              </Button>
            </Tip>
          </ProjectRow>
        ))}

        {remote.map((p) => (
          <ProjectRow key={p.id} project={p} descriptor={remoteDescriptor} />
        ))}

        {empty && !primaryQ.isLoading && (
          <div className="px-4 py-6 text-sm text-muted-foreground">
            {primaryQ.error
              ? staticMode
                ? `Couldn't load the example gallery (${(primaryQ.error as Error).message}). Open a local folder above to start.`
                : `No backend reachable (${(primaryQ.error as Error).message}). Open a local folder above, or configure VITE_API_BASE_URL.`
              : "No projects yet — open a local folder above to start. Files stay in this browser; export anytime with Download .zip."}
          </div>
        )}
      </div>
    </section>
  );
}

function ProjectRow({
  project,
  descriptor,
  children,
}: {
  project: Project;
  descriptor: SourceDescriptor;
  children?: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-3 px-4 py-3">
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <p className="truncate font-medium">{project.name}</p>
          <SourceChip descriptor={descriptor} />
        </div>
        <p className="text-xs text-muted-foreground">
          {project.scope}/projects/{project.slug}
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-1">
        <Button asChild variant="secondary" size="sm">
          <Link to={projectPath(project.scope, project.slug)}>Open</Link>
        </Button>
        {children}
      </div>
    </div>
  );
}
