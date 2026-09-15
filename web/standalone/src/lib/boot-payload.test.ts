import { describe, expect, it } from "vitest";
import { narrowBootForViewer, type BootPayload } from "./boot-payload";

/** A self-locked writer (mobile 0002) must boot with the viewer's catalog:
 *  3D-model origins only, their stacks only — mirroring the server's rule. */
describe("narrowBootForViewer", () => {
  const boot = {
    project: { id: "p" },
    files: [],
    libs: [
      { id: "sym", name: "Device", type: "origin", kind: "symbol" },
      { id: "fp", name: "Resistor_SMD", type: "origin", kind: "footprint" },
      { id: "m3d", name: "Resistor_SMD.3dshapes", type: "origin", kind: "model3d" },
      { id: "org", name: "Team parts", type: "org" },
      { id: "mir", name: "Device", type: "mirror", kind: "model3d" },
    ],
    stacks: { sym: null, fp: null, m3d: null, org: null, mir: null },
  } as unknown as BootPayload;

  it("keeps only model3d origins and their stacks", () => {
    const out = narrowBootForViewer(boot);
    expect(out.libs.map((l) => l.id)).toEqual(["m3d"]);
    expect(Object.keys(out.stacks)).toEqual(["m3d"]);
    // Untouched otherwise, and the input is not mutated.
    expect(out.project).toBe(boot.project);
    expect(boot.libs).toHaveLength(5);
  });

  it("is idempotent on an already-narrowed payload", () => {
    const once = narrowBootForViewer(boot);
    expect(narrowBootForViewer(once)).toEqual(once);
  });
});
