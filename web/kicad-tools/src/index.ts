// Programmatic API (GPL/MIT callers only — closed code spawns the CLI).
export { boardShot, schematicShot, type Options } from "./commands.ts";
export { moduleDir, readManifest, type Manifest, type Tool, type ToolPin } from "./modules.ts";
export { runKicadTools } from "./kicad-tools.ts";
export { BACKGROUND, BOARD_PRESETS, parseCrop, prepareSvg, rasterize, type BoardPreset, type CropMm } from "./shot.ts";
export { classifyRef, modelRefs, stepExport, type ModelRef } from "./step.ts";
