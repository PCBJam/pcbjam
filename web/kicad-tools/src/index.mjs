// @ts-check
// Programmatic API (GPL/MIT callers only — closed code spawns the CLI).
export { boardShot, schematicShot } from "./commands.mjs";
export { moduleDir, readManifest } from "./modules.mjs";
export { runKicadTools } from "./kicad-tools.mjs";
export { BACKGROUND, BOARD_PRESETS, parseCrop, prepareSvg, rasterize } from "./shot.mjs";
export { classifyRef, modelRefs, stepExport } from "./step.mjs";
