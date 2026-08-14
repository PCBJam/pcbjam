import type { Tool } from "@pcbjam/shared";

/**
 * KiCad config/version dir baked into the WASM build. The File→Open dialog
 * starts in MEMFS_PROJECTS_DIR; we mirror each project under a subfolder of it.
 *
 * NOTE (spec §11.1): this path is KiCad-version dependent and confirmed by
 * tests/kicad/load-pcb-probe.spec.ts. If the build's version dir changes, this
 * must change too — a candidate for reading from the module at runtime later.
 * It MUST match KiCad's GetMajorMinorVersion() (== PATHS::GetUserSettingsPath()'s
 * version subdir); otherwise the seeded sym-lib-table/config is written to a dir
 * the WASM never reads and the symbol/footprint choosers come up empty. The
 * KiCad 10.0.4 rebase bumped this from "9.99" to "10.0".
 */
export const KICAD_VERSION_DIR = "10.0";
export const MEMFS_PROJECTS_DIR = `/home/kicad/documents/kicad/${KICAD_VERSION_DIR}/projects`;

/** Where KiCad expects images.tar.gz (compiled-in KICAD_DATA path). */
export const RESOURCE_PATH =
  "/workspace/build-wasm/sysroot/share/kicad/resources";

/**
 * argv[0] each tool's DEBUG check expects. These MUST match the values the
 * proven harness HTMLs set as `Module.thisProgram` (tests/apps/kicad/<tool>.html)
 * — notably the calculator binary is `pcb_calculator`, not `calculator`.
 */
export const TOOL_ARGV0: Record<Tool, string> = {
  pcbnew: "/usr/bin/pcbnew",
  eeschema: "/usr/bin/eeschema",
  calculator: "/usr/bin/pcb_calculator",
  pl_editor: "/usr/bin/pl_editor",
  symbol_editor: "/usr/bin/symbol_editor",
  footprint_editor: "/usr/bin/footprint_editor",
  gerbview: "/usr/bin/gerbview",
};

/**
 * A deployed WASM bundle (CDN folder + `<bundle>.{wasm,js}` basenames). NOT the same
 * space as `Tool`: since editor-unification Part 2 the four editor TOOLS (pcbnew,
 * eeschema, footprint_editor, symbol_editor) are all served by the ONE merged
 * `kicad_editor` bundle — two engines (kifaces) statically linked, the frame chosen
 * at runtime (`TOOL_FRAME`). Deliberately not part of the `TOOLS` enum: a bundle is
 * a delivery artifact, not a user-facing tool/route.
 */
export type Bundle =
  | "kicad_editor"
  | "calculator"
  | "pl_editor"
  | "gerbview"
  // Headless lazy OCC worker module (docs/features/occ-split/) — fetched by the
  // occService provider on first STEP export / STEP-IGES model parse; backs no
  // tool/route of its own.
  | "occ_service"
  // Headless lazy ngspice worker module (docs/features/ngspice-split/) —
  // fetched by the ngspiceService provider when eeschema's simulator first
  // initializes; backs no tool/route of its own.
  | "ngspice_service";

/**
 * Which deployed WASM bundle actually backs each tool. The four editors share the
 * merged `kicad_editor` engine image (editor-unification Part 2); the remaining
 * tools are genuinely separate engines and back their own bundles. Used to resolve
 * the CDN asset folder and the `<bundle>.{wasm,js}` filenames.
 */
export const TOOL_BUNDLE: Record<Tool, Bundle> = {
  pcbnew: "kicad_editor",
  eeschema: "kicad_editor",
  calculator: "calculator",
  pl_editor: "pl_editor",
  symbol_editor: "kicad_editor",
  footprint_editor: "kicad_editor",
  gerbview: "gerbview",
};

/**
 * The frame token passed to the WASM launcher via `Module.arguments`
 * (`--frame=<token>`, parsed in `kicad/common/single_top.cpp`) so a shared bundle
 * opens a specific editor frame. Tools whose bundle already defaults to the right
 * frame need no token (`undefined`). Tokens mirror `kicad/kicad.cpp`'s `--frame`
 * parser, plus `symedit` for the symbol editor (which upstream's CLI lacks).
 * The merged bundle's build-time default is the PCB editor, so every editor tool
 * passes its token explicitly (pcbnew included — cheap insurance over relying on
 * the default).
 */
export const TOOL_FRAME: Record<Tool, string | undefined> = {
  pcbnew: "pcb",
  eeschema: "sch",
  calculator: undefined,
  pl_editor: undefined,
  symbol_editor: "symedit",
  footprint_editor: "fpedit",
  gerbview: undefined,
};

/**
 * Every standalone tool here boots through common/single_top.cpp, which runs
 * STARTWIZARD::CheckAndRun() — the first-run "KiCad Setup" wizard. It shows
 * whenever any provider (SETTINGS / LIBRARIES / PRIVACY) reports
 * NeedsUserInput() — always true on our ephemeral MEMFS with no config, where
 * the wizard's modal loop is unsupported (nothing it writes survives a reload,
 * so it would re-run every boot). So for all of them we seed a default
 * KiCad config before main() (kicad_common.json privacy flags + the lib-tables
 * the providers check) so NeedsUserInput() is false and the wizard is skipped.
 */
export const TOOL_NEEDS_CONFIG_SEED: Record<Tool, boolean> = {
  pcbnew: true,
  eeschema: true,
  calculator: true,
  pl_editor: true,
  symbol_editor: true,
  footprint_editor: true,
  gerbview: true,
};

/**
 * The library kind a tool PRIMARILY consumes — drives the IDB presync warm-up
 * (WasmTool) and which lib-table boot populates for single-engine bundles. The
 * merged kicad_editor bundle seeds BOTH tables regardless of this (cross-face
 * features like the symbol chooser's footprint selector read the other kind;
 * see `libKinds` in boot.ts) — only its presync stays per-frame. A user lib is
 * a kind-agnostic container, so the same lib id can land in both tables.
 * `null` = the tool uses no libraries.
 */
export const TOOL_LIB_KIND: Record<Tool, "symbol" | "footprint" | null> = {
  pcbnew: "footprint",
  eeschema: "symbol",
  calculator: null,
  pl_editor: null,
  symbol_editor: "symbol",
  footprint_editor: "footprint",
  gerbview: null,
};

/** KiCad user settings dir for this build (PATHS::GetUserSettingsPath()). */
export const KICAD_CONFIG_DIR = `/home/kicad/.config/kicad/kicad/${KICAD_VERSION_DIR}`;

/**
 * MEMFS root where 3D model bodies are materialized (JS prescan + the C++
 * lazy-ensure fallback both write `<root>/<lib>.3dshapes/<name>.<ext>` here).
 * Boot points every `KICAD*_3DMODEL_DIR` env var at this dir — official-lib
 * footprints reference models through vintage-specific vars (KICAD6..10 all
 * occur), and KiCad's stock FILENAME_RESOLVER picks up each var it finds — so
 * model paths resolve with zero resolver changes.
 */
export const MODELS_3D_ROOT = "/pcbjam/3dmodels";
export const MODELS_3D_ENV_VARS = [
  "KISYS3DMOD", // pre-v6 legacy alias, still common in older boards
  "KICAD6_3DMODEL_DIR",
  "KICAD7_3DMODEL_DIR",
  "KICAD8_3DMODEL_DIR",
  "KICAD9_3DMODEL_DIR",
  "KICAD10_3DMODEL_DIR",
] as const;

export function memfsProjectDir(slug: string): string {
  return `${MEMFS_PROJECTS_DIR}/${slug}`;
}

export function memfsFilePath(slug: string, relPath: string): string {
  return `${memfsProjectDir(slug)}/${relPath}`;
}
