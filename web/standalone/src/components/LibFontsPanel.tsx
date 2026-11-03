import * as React from "react";
import { ChevronDown, ChevronRight, Loader2, Type, X } from "lucide-react";
import {
  fontFacesLabel,
  fontFacesLicense,
  fontRefusalReason,
  planFontUpload,
  type FontUploadPlan,
} from "@pcbjam/shared";
import { useDraggablePanel } from "@/components/useDraggablePanel";
import { libFontPath, type LibFont, type LibFontsProvider } from "@/wasm/lib-fonts";
import { Button, Checkbox, Combobox, Tip } from "@pcbjam/ui";
import { overlayIconClass } from "@/components/OverlayMenu";

/**
 * Team fonts (fonts 0002): the fonts KiCad's font lists offer from the team's libraries,
 * and an upload into one of those libraries without leaving the editor. The same checks
 * as the library page's font section (pcbjam-private apps/web LibFontsSection): files
 * are sorted against the library first (new, same, replaced), the uploader confirms they
 * may share them, and the item route reads each file and refuses fonts whose license
 * forbids it. An uploaded font is written to MEMFS at once, so KiCad draws it without
 * downloading what this browser already has; the list refresh puts it in the Font list.
 *
 * Same draggable-panel conventions as ImportItemPanel (header = drag handle,
 * collapse-to-header, position persisted).
 */

const PANEL_POS_KEY = "pcbjam:lib-fonts-panel-pos";
const PANEL_W = 320; // w-80
const PANEL_HEADER_H = 36;
/** Uploads in flight at once, as on the library page. */
const PARALLEL = 4;

/** A team library a font can be uploaded into. */
interface Target {
  id: string;
  name: string;
  isPublic: boolean;
}

interface LibRow {
  id: string;
  name: string;
  scope?: string;
  type: string;
  visibility?: string;
  kindCounts?: Record<string, number>;
}

function megabytes(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  return mb < 0.1 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`;
}

/** The scope's own team libraries, those holding fonts first. */
async function loadTargets(apiBase: string, scope: string): Promise<Target[]> {
  const res = await fetch(`${apiBase}/api/scopes/${encodeURIComponent(scope)}/libs?kind=font`, { credentials: "include" });
  if (!res.ok) throw new Error(`libraries ${res.status}`);
  const rows = (await res.json()) as LibRow[];
  return rows
    .filter((l) => l.type === "org" && l.scope === scope)
    .sort((a, b) => Number((b.kindCounts?.font ?? 0) > 0) - Number((a.kindCounts?.font ?? 0) > 0) || a.name.localeCompare(b.name))
    .map((l) => ({ id: l.id, name: l.name, isPublic: l.visibility === "public" }));
}

/** Write an uploaded font where the editor looks for it (best-effort: the library has it). */
function stageFont(font: Pick<LibFont, "libId" | "name">, bytes: Uint8Array): void {
  const fs = (window as ToolWindow).FS as Pick<EmscriptenFS, "mkdirTree" | "writeFile"> | undefined;
  if (!fs || typeof fs.writeFile !== "function") return;
  const path = libFontPath(font);
  try {
    fs.mkdirTree(path.slice(0, path.lastIndexOf("/")));
    fs.writeFile(path, bytes);
  } catch {
    // read from the library when a document uses it
  }
}

export function LibFontsPanel({
  provider,
  scope,
  apiBase,
  canUpload,
  onClose,
}: {
  provider: LibFontsProvider;
  /** The project's team (scope slug). */
  scope: string;
  apiBase: string;
  /** Members; view-only sessions see the list only. */
  canUpload: boolean;
  onClose: () => void;
}) {
  const rootRef = React.useRef<HTMLDivElement | null>(null);
  const inputRef = React.useRef<HTMLInputElement | null>(null);
  const drag = useDraggablePanel({ storageKey: PANEL_POS_KEY, handleWidth: PANEL_W, handleHeight: PANEL_HEADER_H });
  const [collapsed, setCollapsed] = React.useState(false);
  const [fonts, setFonts] = React.useState<readonly LibFont[]>(() => provider.fonts());
  const [targets, setTargets] = React.useState<Target[] | null>(null);
  const [targetsError, setTargetsError] = React.useState(false);
  const [targetId, setTargetId] = React.useState("");
  const [picked, setPicked] = React.useState<File[] | null>(null);
  const [plan, setPlan] = React.useState<FontUploadPlan<File> | null>(null);
  const [mayShare, setMayShare] = React.useState(false);
  const [replace, setReplace] = React.useState(false);
  const [dragOver, setDragOver] = React.useState(false);
  const [progress, setProgress] = React.useState<{ done: number; total: number } | null>(null);
  const [result, setResult] = React.useState<{ added: number; same: number; refused: FontUploadPlan["refused"] } | null>(null);

  // The list as KiCad has it, re-read on open (a font may have been added elsewhere).
  React.useEffect(() => {
    const update = () => setFonts(provider.fonts());
    const off = provider.subscribe(update);
    update();
    void provider.refresh();
    return off;
  }, [provider]);

  React.useEffect(() => {
    if (!canUpload) return;
    let live = true;
    loadTargets(apiBase, scope)
      .then((list) => {
        if (!live) return;
        setTargets(list);
        setTargetId((id) => id || list[0]?.id || "");
      })
      .catch(() => live && setTargetsError(true));
    return () => {
      live = false;
    };
  }, [apiBase, scope, canUpload]);

  const target = targets?.find((t) => t.id === targetId) ?? null;
  const sorted = React.useMemo(
    () =>
      [...fonts].sort(
        (a, b) => fontFacesLabel(a.faces, a.name).family.localeCompare(fontFacesLabel(b.faces, b.name).family) || a.name.localeCompare(b.name),
      ),
    [fonts],
  );

  const makePlan = async (files: File[], libId: string) => {
    const existing = fonts.filter((f) => f.libId === libId).map((f) => ({ name: f.name, sha256: f.sha256 }));
    const next = await planFontUpload(files, existing);
    if (next.add.length === 0 && next.replace.length === 0) {
      setPicked(null);
      setPlan(null);
      setResult({ added: 0, same: next.same.length, refused: next.refused });
      return;
    }
    setPlan(next);
  };

  const pick = async (list: FileList | File[]) => {
    if (!target) return;
    const files = Array.from(list);
    setResult(null);
    setMayShare(false);
    setReplace(false);
    setPicked(files);
    await makePlan(files, target.id);
  };

  // Another library: the same picked files, sorted against that library.
  const chooseTarget = (id: string) => {
    setTargetId(id);
    setMayShare(false);
    if (picked) void makePlan(picked, id);
  };

  const cancel = () => {
    setPlan(null);
    setPicked(null);
  };

  const upload = async () => {
    if (!plan || !target) return;
    const queue = [...plan.add, ...(replace ? plan.replace : [])];
    const refused = [...plan.refused];
    let added = 0;
    setProgress({ done: 0, total: queue.length });
    setPlan(null);
    setPicked(null);
    let next = 0;
    const worker = async () => {
      while (next < queue.length) {
        const p = queue[next++]!;
        const bytes = new Uint8Array(await p.file.arrayBuffer());
        const url = `${apiBase}/api/scopes/${encodeURIComponent(scope)}/libs/${encodeURIComponent(target.id)}/items/font/${encodeURIComponent(p.name)}`;
        const res = await fetch(url, {
          method: "PUT",
          credentials: "include",
          headers: { "Content-Type": "application/octet-stream" },
          body: bytes,
        }).catch(() => null);
        if (res?.ok) {
          added += 1;
          stageFont({ libId: target.id, name: p.name }, bytes);
        } else {
          const msg = res ? ((await res.json().catch(() => null)) as { message?: string } | null)?.message : null;
          refused.push({ name: p.name, reason: fontRefusalReason(p.name, msg, res?.status) });
        }
        setProgress((s) => (s ? { ...s, done: s.done + 1 } : s));
      }
    };
    try {
      await Promise.all(Array.from({ length: Math.min(PARALLEL, queue.length) }, worker));
      await provider.refresh();
    } finally {
      setProgress(null);
      setResult({ added, same: plan.same.length + (replace ? 0 : plan.replace.length), refused });
    }
  };

  const busy = progress !== null;
  const style: React.CSSProperties = drag.pos ? { left: drag.pos.x, top: drag.pos.y } : { right: 12, top: 120 };
  const muted = "text-neutral-500 dark:text-white/50";

  return (
    <div
      ref={rootRef}
      data-testid="lib-fonts-panel"
      className="absolute z-40 flex max-h-[70vh] w-80 flex-col overflow-hidden rounded-xl bg-white/95 text-neutral-900 shadow-2xl ring-1 ring-inset ring-black/10 backdrop-blur-sm dark:bg-neutral-950/90 dark:text-white dark:ring-white/15"
      style={style}
    >
      <Tip content="Team fonts - drag to move">
        <div
          className="flex shrink-0 cursor-grab select-none items-center gap-2 px-3 py-2 text-xs font-semibold active:cursor-grabbing"
          style={{ touchAction: "none" }}
          onPointerDown={(e) => drag.onPointerDown(e, rootRef.current!.getBoundingClientRect())}
          onPointerMove={(e) => void drag.onPointerMove(e)}
          onPointerUp={() => void drag.onPointerUp()}
        >
          <Tip content={collapsed ? "Expand" : "Collapse to header"}>
            <Button
              aria-expanded={!collapsed}
              onPointerDown={(e) => e.stopPropagation()}
              onClick={() => setCollapsed(!collapsed)}
              variant="plain"
              size="icon-xs"
              className={overlayIconClass}
            >
              {collapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
            </Button>
          </Tip>
          <Type size={14} className="text-neutral-400 dark:text-white/50" />
          <span>Team fonts</span>
          {fonts.length > 0 && <span className={`font-normal ${muted}`}>{fonts.length}</span>}
          <span className="ml-auto" onPointerDown={(e) => e.stopPropagation()}>
            <Tip content="Close">
              <Button data-testid="lib-fonts-panel-close" onClick={onClose} variant="plain" size="icon-xs" className={overlayIconClass}>
                <X size={14} />
              </Button>
            </Tip>
          </span>
        </div>
      </Tip>

      {!collapsed && (
        <div className="flex min-h-0 flex-col gap-2 overflow-y-auto px-3 pb-3 text-xs">
          <p className={muted}>
            {canUpload
              ? "Your team's fonts are in KiCad's Font lists (Text Properties). A font downloads only when a document uses it."
              : "Fonts from the public libraries this project's team uses. They are in KiCad's Font lists."}
          </p>

          {canUpload && targets && targets.length > 1 && (
            <label className="flex items-center gap-2">
              <span className={muted}>Library</span>
              <Combobox
                data-testid="lib-fonts-panel-target"
                className="h-7 min-w-0 flex-1 px-2 text-xs"
                contentClassName="z-50"
                value={targetId}
                onValueChange={chooseTarget}
                searchPlaceholder="Search libraries…"
                emptyText="No library matches."
                disabled={busy}
                options={targets.map((t) => ({ value: t.id, label: t.name, hint: t.isPublic ? "public" : undefined }))}
              />
            </label>
          )}

          {canUpload && target && !plan && (
            <div
              data-testid="lib-fonts-panel-dropzone"
              className={`flex cursor-pointer flex-col items-center justify-center gap-1 rounded-lg border border-dashed px-3 py-3 text-center ${
                dragOver ? "border-sky-500 bg-sky-500/10" : "border-neutral-300 hover:bg-black/5 dark:border-white/20 dark:hover:bg-white/5"
              } ${busy ? "pointer-events-none opacity-60" : ""}`}
              onClick={() => inputRef.current?.click()}
              onDragOver={(e) => {
                e.preventDefault();
                setDragOver(true);
              }}
              onDragLeave={() => setDragOver(false)}
              onDrop={(e) => {
                e.preventDefault();
                setDragOver(false);
                if (e.dataTransfer.files.length) void pick(e.dataTransfer.files);
              }}
            >
              <span className="font-medium">
                {progress ? (
                  <span className="flex items-center gap-1.5">
                    <Loader2 size={12} className="animate-spin" /> Uploading {progress.done} of {progress.total}…
                  </span>
                ) : (
                  "Upload fonts"
                )}
              </span>
              <span className={muted}>
                .ttf, .otf or .ttc into <span className="font-medium">{target.name}</span>
              </span>
              <input
                ref={inputRef}
                data-testid="lib-fonts-panel-input"
                type="file"
                multiple
                accept=".ttf,.otf,.ttc,.otc"
                className="hidden"
                onChange={(e) => {
                  if (e.target.files?.length) void pick(e.target.files);
                  e.target.value = "";
                }}
              />
            </div>
          )}

          {canUpload && targets?.length === 0 && (
            <p className={muted}>Create a team library on the Libraries page to upload fonts.</p>
          )}
          {canUpload && targetsError && <p className="text-red-600 dark:text-red-400">Couldn't read the team's libraries.</p>}

          {plan && target && (
            <div data-testid="lib-fonts-panel-confirm" className="flex flex-col gap-2 rounded-lg bg-black/5 p-2 dark:bg-white/5">
              <p className="font-medium">
                Add {plan.add.length} font{plan.add.length === 1 ? "" : "s"} to {target.name}?
              </p>
              {plan.same.length > 0 && (
                <p className={muted}>
                  {plan.same.length} {plan.same.length === 1 ? "is" : "are"} already there and will be skipped.
                </p>
              )}
              {plan.replace.length > 0 && (
                <label className="flex items-start gap-2">
                  <Checkbox checked={replace} onCheckedChange={(v) => setReplace(v === true)} data-testid="lib-fonts-panel-replace" className="mt-0.5" />
                  <span>
                    Replace {plan.replace.length} font{plan.replace.length === 1 ? "" : "s"} of the same name (
                    {plan.replace.slice(0, 3).map((p) => p.name).join(", ")}
                    {plan.replace.length > 3 ? ", ..." : ""})
                  </span>
                </label>
              )}
              <label className="flex items-start gap-2">
                <Checkbox checked={mayShare} onCheckedChange={(v) => setMayShare(v === true)} data-testid="lib-fonts-panel-may-share" className="mt-0.5" />
                <span>
                  {target.isPublic
                    ? `Anyone may have these fonts: ${target.name} is public, so anyone can download them. Only fonts that state a free license are taken.`
                    : "I may share these fonts with my team. Every member gets a copy, as if the fonts were installed on their computers."}
                </span>
              </label>
              <div className="flex gap-2">
                <Button
                  size="xs"
                  data-testid="lib-fonts-panel-upload"
                  disabled={!mayShare || (plan.add.length === 0 && !replace)}
                  onClick={() => void upload()}
                >
                  Upload
                </Button>
                <Button size="xs" variant="ghost" onClick={cancel}>
                  Cancel
                </Button>
              </div>
            </div>
          )}

          {result && (
            <div data-testid="lib-fonts-panel-result">
              <p>
                {result.added > 0
                  ? `Added ${result.added} font${result.added === 1 ? "" : "s"}. Pick ${result.added === 1 ? "it" : "them"} in Text Properties > Font.`
                  : "No fonts added."}
                {result.same > 0 ? ` ${result.same} skipped (already there).` : ""}
              </p>
              {result.refused.length > 0 && (
                <ul className="mt-1 list-disc pl-4 text-red-600 dark:text-red-400">
                  {result.refused.slice(0, 10).map((r) => (
                    <li key={r.name} data-testid={`lib-fonts-panel-refused-${r.name}`}>
                      <span className="font-mono">{r.name}</span>: {r.reason}
                    </li>
                  ))}
                  {result.refused.length > 10 && <li>...and {result.refused.length - 10} more</li>}
                </ul>
              )}
            </div>
          )}

          {sorted.length === 0 ? (
            <p className={muted}>No team fonts yet.</p>
          ) : (
            <ul data-testid="lib-fonts-panel-list" className="flex flex-col divide-y divide-black/5 dark:divide-white/10">
              {sorted.map((f) => {
                const { family, styles } = fontFacesLabel(f.faces, f.name);
                const base = f.name.slice(f.name.lastIndexOf("/") + 1);
                return (
                  <li key={`${f.libId}/${f.name}`} className="py-1.5" data-testid={`lib-fonts-panel-font-${f.name}`}>
                    <p className="truncate">
                      <span className="font-medium">{family}</span>
                      {styles && <span className={muted}> {styles}</span>}
                    </p>
                    <Tip content={`${f.name} in ${f.libName}`}>
                      <p className={`truncate ${muted}`}>
                        <span className="font-mono">{base}</span> - {megabytes(f.size)} - {f.libName}
                      </p>
                    </Tip>
                    <p className={`truncate ${muted}`}>{fontFacesLicense(f.faces) ?? "License not stated in the font"}</p>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
