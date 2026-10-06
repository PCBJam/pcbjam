// Programmatic API (GPL/MIT callers only — closed code spawns the CLI).
export { boardShot, schematicShot, type Options } from "./commands.ts";
export { fetchAll, moduleDir, readManifest, type Manifest, type Tool, type ToolPin } from "./modules.ts";
export { runKicadTools } from "./kicad-tools.ts";
export { BACKGROUND, BOARD_PRESETS, parseCrop, prepareSvg, rasterize, type BoardPreset, type CropMm } from "./shot.ts";
export { classifyRef, modelRefs, stepExport, type ModelRef } from "./step.ts";
export { readGlb, type Mesh } from "./glb.ts";
export { encodePng } from "./png.ts";
export { BACKGROUND_3D, render, VIEWS, type RenderOptions, type View3d } from "./render3d.ts";
export { board3dShot } from "./shot3d.ts";
export { occExport, prepareBoard, UsageError, type PreparedBoard } from "./step.ts";
