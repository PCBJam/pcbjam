// Extracted from WasmTool.tsx (2026-08-25 split) — behavior unchanged.
import {
  EXTENSION_TOOL,
  FILELESS_TOOLS,
  projectPath,
  projectToolPath,
  toolSchema,
  type Tool,
} from "@pcbjam/shared";
import { currentScope } from "@/lib/config";
import { defaultFileName, newFileTemplate, withExtension } from "@/lib/new-file";
import { memfsProjectDir } from "@/wasm/constants";
import type { ToolFile } from "@/wasm/kicad-runner";
import { markDeliberateNavigation } from "./quit-hook";

const LEGACY_EXTENSION_TOOL: Record<string, Tool> = {
  ".sch": "eeschema",
  ".brd": "pcbnew",
};

let activeToolNavigationHook:
  | ((toolName: string, fileName: string) => boolean)
  | undefined;

const toolNavigationDispatcher = (toolName: string, fileName: string) =>
  activeToolNavigationHook?.(toolName, fileName) ?? false;

function ensureToolNavigationDispatcher(win: ToolWindow): boolean {
  if (win.kicadWebOpenTool === toolNavigationDispatcher) return true;

  try {
    Object.defineProperty(win, "kicadWebOpenTool", {
      configurable: true,
      value: toolNavigationDispatcher,
    });
    return true;
  } catch {
    return false;
  }
}

if (typeof window !== "undefined") {
  ensureToolNavigationDispatcher(window as ToolWindow);
}

export function normalizeToolName(rawName: string): Tool | null {
  const basename = rawName.replace(/\\/g, "/").split("/").pop() ?? rawName;
  const withoutExe = basename.replace(/\.exe$/i, "");
  const toolName = withoutExe === "pcb_calculator" ? "calculator" : withoutExe;
  const parsed = toolSchema.safeParse(toolName);
  return parsed.success ? parsed.data : null;
}

export function relativeProjectPath(slug: string, path: string): string | undefined {
  if (!path) return undefined;

  const normalized = path.replace(/\\/g, "/");
  const prefix = `${memfsProjectDir(slug)}/`;

  if (normalized.startsWith(prefix)) return normalized.slice(prefix.length);

  const marker = `/projects/${slug}/`;
  const markerIndex = normalized.indexOf(marker);

  if (markerIndex >= 0) return normalized.slice(markerIndex + marker.length);

  return normalized.startsWith("/") ? undefined : normalized;
}

export function fileStem(path: string): string {
  const name = path.replace(/\\/g, "/").split("/").pop() ?? path;
  return name.replace(/\.[^.]+$/, "");
}

export function fileTool(path: string): Tool | undefined {
  const lower = path.toLowerCase();

  for (const [extension, mappedTool] of Object.entries({
    ...EXTENSION_TOOL,
    ...LEGACY_EXTENSION_TOOL,
  })) {
    if (lower.endsWith(extension)) return mappedTool;
  }

  return undefined;
}

export function chooseToolFile(
  files: ToolFile[],
  nextTool: Tool,
  requestedPath?: string,
  currentPath?: string,
): string | undefined {
  if (requestedPath && files.some((file) => file.path === requestedPath)) {
    return requestedPath;
  }

  const candidates = files.filter((file) => fileTool(file.path) === nextTool);
  const preferredStem = requestedPath
    ? fileStem(requestedPath)
    : currentPath
      ? fileStem(currentPath)
      : undefined;

  if (preferredStem) {
    const matchingStem = candidates.find(
      (file) => fileStem(file.path) === preferredStem,
    );
    if (matchingStem) return matchingStem.path;
  }

  return candidates[0]?.path;
}

export function installToolNavigationHook(
  win: ToolWindow,
  opts: {
    slug: string;
    files: ToolFile[];
    targetPath?: string;
    /** Persist a new file into the project (see the WasmTool prop). Absent ⇒
     *  this session can't create one, and a missing target stays a no-op. */
    createFile?: (relPath: string, bytes: Uint8Array) => Promise<void>;
    log: (m: string) => void;
  },
): () => void {
  // One create at a time: a double-fired menu item must not upload twice.
  // Cleared only on failure — success navigates the page away.
  let pendingCreate: string | null = null;

  const hook = (rawToolName: string, rawFileName: string): boolean => {
    const nextTool = normalizeToolName(rawToolName);

    if (!nextTool) {
      opts.log(`[nav] unsupported KiCad tool: ${rawToolName}`);
      return false;
    }

    const requestedPath = relativeProjectPath(opts.slug, rawFileName);
    const nextPath = FILELESS_TOOLS.has(nextTool)
      ? undefined
      : chooseToolFile(opts.files, nextTool, requestedPath, opts.targetPath);

    if (!FILELESS_TOOLS.has(nextTool) && !nextPath) {
      // Native KiCad's "Switch to PCB Editor" with no board opens pcbnew on a
      // NEW empty board at the derived path — mirror it by creating the
      // templated counterpart in the project (the shape NewFileDialog writes)
      // and navigating to it. Only sessions that can persist pass `createFile`
      // (ToolPage); viewers and scratch/local-folder sessions keep the quiet
      // no-op. C++ calls this hook synchronously (EM_ASM_INT) and ignores the
      // result beyond a log line, so the create+navigate runs async and we
      // answer true optimistically once it's kicked off.
      const createFile = opts.createFile;
      if (!createFile) {
        opts.log(`[nav] no project file found for ${nextTool}: ${rawFileName}`);
        return false;
      }
      if (pendingCreate) {
        opts.log(`[nav] create already pending: ${pendingCreate}`);
        return true;
      }
      const relPath =
        requestedPath ??
        (opts.targetPath
          ? withExtension(nextTool, fileStem(opts.targetPath))
          : defaultFileName(nextTool));
      const url =
        projectPath(currentScope(), opts.slug, relPath) + win.location.search;
      pendingCreate = relPath;
      void (async () => {
        try {
          const bytes = new TextEncoder().encode(
            newFileTemplate(nextTool, crypto.randomUUID()),
          );
          await createFile(relPath, bytes);
          opts.log(`[nav] created missing ${nextTool} file ${relPath} -> ${url}`);
          markDeliberateNavigation();
          win.location.assign(url);
        } catch (e) {
          pendingCreate = null;
          opts.log(
            `[nav] create failed for ${relPath}: ${e instanceof Error ? e.message : String(e)}`,
          );
        }
      })();
      return true;
    }

    // Scope/kind/name grammar: a fileless tool boots at `…/-/:tool`; a file route
    // carries the path (its tool is inferred). Scope = the current URL's scope.
    const scope = currentScope();
    const url =
      (FILELESS_TOOLS.has(nextTool)
        ? projectToolPath(scope, opts.slug, nextTool)
        : projectPath(scope, opts.slug, nextPath)) + win.location.search;

    opts.log(`[nav] ${rawToolName} ${rawFileName || "(no file)"} -> ${url}`);
    markDeliberateNavigation();
    win.location.assign(url);
    return true;
  };

  if (!ensureToolNavigationDispatcher(win)) {
    opts.log("[nav] unable to install KiCad tool navigation hook");
  }

  activeToolNavigationHook = hook;

  return () => {
    if (activeToolNavigationHook === hook) activeToolNavigationHook = undefined;
  };
}

