// The AI chat's agent executor (ai-chat 0003 step 4) for the kicad specs: the
// editor app's executor plus the shared schematic-ops that compute its edits,
// so a spec runs the real chain (ops → executor → KiCad) inside the harness
// page. Bundled to apps/kicad/agent-bundle.js (global PcbjamAgent) by
// build-agent.mjs.
import { connectEdit, fileToDoc, placementBlob, placePartEdit, readSheet } from "@pcbjam/shared";
import { applyAgentEdit, placeAgentPart, readParts } from "../../web/standalone/src/agent/executor";

(window as unknown as { PcbjamAgent: unknown }).PcbjamAgent = {
  applyAgentEdit,
  placeAgentPart,
  readParts,
  ops: { connectEdit, fileToDoc, placementBlob, placePartEdit, readSheet },
};
