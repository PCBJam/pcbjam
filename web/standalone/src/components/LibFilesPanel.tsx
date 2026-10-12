import * as React from "react";
import { Check, ChevronDown, ChevronRight, Copy, FolderOpen, Upload } from "lucide-react";
import { libVarRef } from "@pcbjam/shared";
import type { Tool } from "@pcbjam/shared";
import type { LibInfo, LibsSource } from "@/wasm/libs/source";
import { ensureModelInMemfs, forgetLibModel, LIB_ROOTS_DIR } from "@/wasm/libs/models-bridge";

/**
 * Library files (libs 0020 E.3/F): the lib-scoped editors' way to put a 3D
 * model (footprint editor) or a datasheet (symbol editor) into the team
 * library. The file is pushed into the library like any item, then staged
 * under the library's path-variable root in MEMFS, so KiCad's own pickers
 * (3D model "Add", datasheet field) find it at once. The panel shows the
 * `${<NICK>_DIR}` ref to use, which desktop KiCad resolves too once the
 * variable points at the library folder.
 */

type FileKind = "model3d" | "doc";

const ACCEPT: Record<FileKind, string> = {
  model3d: ".step,.stp,.wrl,.wrz",
  doc: ".pdf,.html,.htm,.txt,.png,.jpg,.jpeg",
};

/** Same cap as the runner's library bodies (lib-bodies.ts). */
const MAX_BYTES = 32 * 1024 * 1024;

const iconBtn =
  "rounded p-0.5 text-neutral-500 hover:bg-black/5 hover:text-neutral-900 dark:text-white/60 dark:hover:bg-white/10 dark:hover:text-white";

export function LibFilesPanel({ source, tool }: { source: LibsSource; tool: Tool }) {
  const kind: FileKind | null =
    tool === "footprint_editor" ? "model3d" : tool === "symbol_editor" ? "doc" : null;
  const [lib, setLib] = React.useState<LibInfo | null>(null);
  const [collapsed, setCollapsed] = React.useState(true);
  const [busy, setBusy] = React.useState(false);
  const [last, setLast] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [copied, setCopied] = React.useState(false);
  const inputRef = React.useRef<HTMLInputElement | null>(null);

  React.useEffect(() => {
    let live = true;
    void source
      .listLibs()
      .then((libs) => {
        if (live && libs.length === 1) setLib(libs[0]!);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [source]);

  const paths = lib?.paths;
  const folder = kind === "model3d" ? paths?.modelsDir : (paths?.docsDir ?? null);
  if (!kind || !lib || !paths || !folder || !source.saveItemBody) return null;
  const dir = folder.replace(/^\/+|\/+$/g, "");

  const upload = async (file: File) => {
    setError(null);
    setCopied(false);
    if (file.size > MAX_BYTES) {
      setError(`${file.name} is larger than 32 MB.`);
      return;
    }
    setBusy(true);
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const ok = await source.saveItemBody!(lib.id, kind, file.name, bytes);
      if (!ok) {
        setError(`Couldn't upload ${file.name}.`);
        return;
      }
      const ref = libVarRef(paths.pathVar, `${dir}/${file.name}`);
      if (kind === "model3d") {
        // Re-stage: a replaced model must not keep its old MEMFS bytes.
        forgetLibModel(ref);
        await ensureModelInMemfs(ref);
      } else {
        writeStaged(`${LIB_ROOTS_DIR}/${paths.pathVar}/${dir}/${file.name}`, bytes);
      }
      setLast(ref);
    } catch (e) {
      setError(`Couldn't upload ${file.name}: ${String(e)}`);
    } finally {
      setBusy(false);
    }
  };

  const copy = async () => {
    if (!last) return;
    try {
      await navigator.clipboard.writeText(last);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };

  const what = kind === "model3d" ? "3D model" : "datasheet";
  return (
    <div
      data-testid="lib-files-panel"
      className="absolute bottom-3 right-3 z-40 flex w-80 flex-col overflow-hidden rounded-xl bg-white/95 text-neutral-900 shadow-2xl ring-1 ring-inset ring-black/10 backdrop-blur-sm dark:bg-neutral-950/90 dark:text-white dark:ring-white/15"
    >
      <button
        data-testid="lib-files-toggle"
        aria-expanded={!collapsed}
        onClick={() => setCollapsed(!collapsed)}
        className="flex items-center gap-2 px-3 py-2 text-left text-xs font-semibold"
      >
        {collapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
        <FolderOpen size={14} className="text-neutral-400 dark:text-white/50" />
        <span>Library files</span>
        <span className="ml-auto font-mono font-normal text-neutral-500 dark:text-white/50">
          {"${"}
          {paths.pathVar}
          {"}"}
        </span>
      </button>
      {!collapsed && (
        <div className="flex flex-col gap-2 px-3 pb-3 text-xs">
          <p className="text-neutral-500 dark:text-white/60">
            Upload a {what} into <span className="font-mono">{dir}/</span> of this library. Use
            the path below in KiCad: it works here, and in desktop KiCad once{" "}
            <span className="font-mono">{paths.pathVar}</span> points at the library folder.
          </p>
          <button
            data-testid="lib-files-upload"
            disabled={busy}
            onClick={() => inputRef.current?.click()}
            className="inline-flex items-center justify-center gap-1.5 rounded-md bg-sky-600 px-3 py-1.5 font-medium text-white hover:bg-sky-500 disabled:cursor-not-allowed disabled:opacity-40"
          >
            <Upload size={13} /> {busy ? "Uploading…" : `Upload ${what}`}
          </button>
          <input
            ref={inputRef}
            data-testid="lib-files-input"
            type="file"
            accept={ACCEPT[kind]}
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void upload(f);
              e.target.value = "";
            }}
          />
          {last && (
            <div className="flex items-center gap-1.5">
              <code
                data-testid="lib-files-ref"
                className="min-w-0 flex-1 truncate rounded bg-black/5 px-1.5 py-1 dark:bg-white/10"
                title={last}
              >
                {last}
              </code>
              <button title="Copy path" onClick={() => void copy()} className={iconBtn}>
                {copied ? <Check size={14} /> : <Copy size={14} />}
              </button>
            </div>
          )}
          {last && kind === "model3d" && (
            <p className="text-neutral-500 dark:text-white/60">
              In Footprint Properties → 3D Models, paste this path, or use the folder button and
              browse to <span className="font-mono">{`${LIB_ROOTS_DIR}/${paths.pathVar}`}</span>.
            </p>
          )}
          {last && kind === "doc" && (
            <p className="text-neutral-500 dark:text-white/60">
              Paste this path into the symbol's Datasheet field.
            </p>
          )}
          {error && (
            <p data-testid="lib-files-error" className="text-red-600 dark:text-red-400">
              {error}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

/** Write a staged copy into the editor's MEMFS (best-effort; the library has the file). */
function writeStaged(path: string, bytes: Uint8Array): void {
  const fs = (window as ToolWindow).FS as
    | Pick<EmscriptenFS, "mkdirTree" | "writeFile">
    | undefined;
  if (!fs || typeof fs.writeFile !== "function") return;
  try {
    fs.mkdirTree(path.slice(0, path.lastIndexOf("/")));
    fs.writeFile(path, bytes);
  } catch {
    // the upload itself succeeded; only the local copy is missing
  }
}
