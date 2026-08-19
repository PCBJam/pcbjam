import { describe, expect, it, vi } from "vitest";
import {
  collectBoardModelFiles,
  ensureModelInMemfs,
  installModel3dHandler,
  deferBoardModelPrescan,
  runDeferredModelPrescan,
  normalizeModelRef,
  scanModelRefs,
} from "./models-bridge";
import type { Model3dSource } from "./models-source";

describe("normalizeModelRef", () => {
  it("strips any vintage of the model-dir var", () => {
    for (const v of ["KICAD6", "KICAD7", "KICAD8", "KICAD9", "KICAD10"]) {
      expect(
        normalizeModelRef(`\${${v}_3DMODEL_DIR}/Resistor_SMD.3dshapes/R_0201.wrl`),
      ).toBe("Resistor_SMD.3dshapes/R_0201.wrl");
    }
  });

  it("accepts the paren syntax and the legacy KISYS3DMOD alias", () => {
    expect(normalizeModelRef("$(KICAD8_3DMODEL_DIR)/L.3dshapes/m.step")).toBe(
      "L.3dshapes/m.step",
    );
    expect(normalizeModelRef("${KISYS3DMOD}/L.3dshapes/m.wrl")).toBe(
      "L.3dshapes/m.wrl",
    );
  });

  it("passes bare relative refs through", () => {
    expect(normalizeModelRef("L.3dshapes/m.wrl")).toBe("L.3dshapes/m.wrl");
  });

  it("rejects refs it cannot serve", () => {
    expect(normalizeModelRef("${KIPRJMOD}/libs/3d/m.wrl")).toBeNull(); // project-local
    expect(normalizeModelRef("/abs/path/m.wrl")).toBeNull();
    expect(normalizeModelRef("kicad_embed://m.wrl")).toBeNull();
    expect(normalizeModelRef("")).toBeNull();
    expect(normalizeModelRef("${UNCLOSED/m.wrl")).toBeNull();
  });
});

describe("ensureModelInMemfs format fallback", () => {
  function installFakes(available: (ref: string) => boolean) {
    const files = new Map<string, Uint8Array>();
    const fs = {
      mkdirTree: () => {},
      writeFile: (p: string, b: Uint8Array) => void files.set(p, b),
      analyzePath: (p: string) => ({ exists: files.has(p) }),
    };
    (globalThis as unknown as { window: unknown }).window ??= globalThis;
    (globalThis as unknown as { FS: unknown }).FS = fs;
    const source: Model3dSource = {
      getModelBody: async (ref) =>
        available(ref) ? new TextEncoder().encode(`body:${ref}`) : null,
      hasModel: async (ref) => available(ref),
    };
    installModel3dHandler(source, () => {});
    return files;
  }

  it("serves a .wrl ask from the same-stem .step, under the .step path", async () => {
    // kicad-packages3D is STEP-only from 10.x — old boards still ask for .wrl.
    const files = installFakes((r) => r.endsWith(".step"));
    const dest = await ensureModelInMemfs("FallbackLibA.3dshapes/M1.wrl");
    // Returned (and written) under the SUBSTITUTED extension: the path picks
    // the parsing plugin, so the .step body must dispatch to oce, not vrml.
    expect(dest).toBe("/pcbjam/3dmodels/FallbackLibA.3dshapes/M1.step");
    expect(files.has("/pcbjam/3dmodels/FallbackLibA.3dshapes/M1.step")).toBe(true);
    expect(files.has("/pcbjam/3dmodels/FallbackLibA.3dshapes/M1.wrl")).toBe(false);
  });

  it("returns the substituted .step path on the memoized second ensure", async () => {
    // Regression: the first ensure (e.g. the prescan) writes the .step body and
    // memoizes it; a second ensure for the SAME .wrl ref (the C++ viewer's lazy
    // fallback) must hand back the .step path that exists on disk — NOT the
    // ref's own .wrl path, which was never written. Returning the .wrl path
    // pointed KiCad at a missing file → "Failed to retrieve file times '…​.wrl'".
    const files = installFakes((r) => r.endsWith(".step"));
    const first = await ensureModelInMemfs("FallbackLibD.3dshapes/M4.wrl");
    const second = await ensureModelInMemfs("FallbackLibD.3dshapes/M4.wrl");
    expect(first).toBe("/pcbjam/3dmodels/FallbackLibD.3dshapes/M4.step");
    expect(second).toBe(first);
    expect(files.has("/pcbjam/3dmodels/FallbackLibD.3dshapes/M4.wrl")).toBe(false);
  });

  it("prefers the exact ref when it exists", async () => {
    const files = installFakes(() => true);
    const dest = await ensureModelInMemfs("FallbackLibB.3dshapes/M2.wrl");
    expect(dest).toBe("/pcbjam/3dmodels/FallbackLibB.3dshapes/M2.wrl");
    expect(files.has("/pcbjam/3dmodels/FallbackLibB.3dshapes/M2.wrl")).toBe(true);
  });

  it("resolves null when no format of the model exists", async () => {
    installFakes(() => false);
    expect(await ensureModelInMemfs("FallbackLibC.3dshapes/M3.wrl")).toBeNull();
  });
});

describe("collectBoardModelFiles", () => {
  function installFakes(available: (ref: string) => boolean) {
    const files = new Map<string, Uint8Array>();
    const fs = {
      mkdirTree: () => {},
      writeFile: (p: string, b: Uint8Array) => void files.set(p, b),
      analyzePath: (p: string) => ({ exists: files.has(p) }),
      readFile: (p: string) => files.get(p),
    };
    (globalThis as unknown as { window: unknown }).window ??= globalThis;
    (globalThis as unknown as { FS: unknown }).FS = fs;
    const source: Model3dSource = {
      getModelBody: async (ref) =>
        available(ref) ? new TextEncoder().encode(`body:${ref}`) : null,
      hasModel: async (ref) => available(ref),
    };
    installModel3dHandler(source, () => {});
  }

  it("collects staged bodies under their REAL extension, deduped, misses skipped", async () => {
    installFakes((r) => r.startsWith("ExportLibA") && r.endsWith(".step"));
    const board = `
      (model "\${KICAD10_3DMODEL_DIR}/ExportLibA.3dshapes/M1.wrl")
      (model "\${KICAD10_3DMODEL_DIR}/ExportLibA.3dshapes/M1.step")
      (model "\${KICAD10_3DMODEL_DIR}/ExportLibB.3dshapes/GONE.wrl")
      (model "\${KIPRJMOD}/libs/3d_shapes/prj.wrl")
    `;
    // M1.wrl is served by the .step sibling; the M1.step ref materializes to
    // the SAME file → one entry. The unservable ref is skipped; the
    // project-local ref never enters the scan.
    const models = await collectBoardModelFiles(board);
    expect(models).toHaveLength(1);
    expect(models[0]!.path).toBe("ExportLibA.3dshapes/M1.step");
    expect(new TextDecoder().decode(models[0]!.bytes)).toBe(
      "body:ExportLibA.3dshapes/M1.step",
    );
  });

  it("returns empty for a board without lib model refs", async () => {
    installFakes(() => true);
    expect(await collectBoardModelFiles("(kicad_pcb (version 1))")).toEqual([]);
  });

  it("makes an in-flight source result inert and starts no later ref after abort", async () => {
    // repro for E-4: the prefetch abort must stop selection immediately and
    // may not retain a body that resolves after the abort.
    (globalThis as unknown as { window: unknown }).window ??= globalThis;
    let resolveFirst!: (body: Uint8Array | null) => void;
    const source: Model3dSource = {
      getModelBody: vi.fn(
        () => new Promise<Uint8Array | null>((resolve) => {
          resolveFirst = resolve;
        }),
      ),
      hasModel: async () => true,
    };
    installModel3dHandler(source, () => {});
    const controller = new AbortController();
    const retired = new Error("exact OCC prefetch retired");
    const collection = collectBoardModelFiles(
      '(model "AbortA.3dshapes/A.step")\n' +
        '(model "AbortB.3dshapes/B.step")',
      1,
      controller.signal,
    );

    await vi.waitFor(() => expect(source.getModelBody).toHaveBeenCalledTimes(1));
    controller.abort(retired);
    resolveFirst(new Uint8Array([1, 2, 3]));

    await expect(collection).rejects.toBe(retired);
    expect(source.getModelBody).toHaveBeenCalledTimes(1);
  });

  it("never touches the editor MEMFS (pure source/IDB/network path)", async () => {
    // repro for E-4: routing bodies through the editor heap added a stale
    // native-completion tail after a prefetch timeout — the collect path must
    // stay off FS entirely (the OCC worker stages bodies in its own MEMFS).
    const fs = {
      mkdirTree: vi.fn(),
      writeFile: vi.fn(),
      analyzePath: vi.fn(() => ({ exists: false })),
      readFile: vi.fn(),
    };
    (globalThis as unknown as { window: unknown }).window ??= globalThis;
    (globalThis as unknown as { FS: unknown }).FS = fs;
    const source: Model3dSource = {
      getModelBody: async (ref) => new TextEncoder().encode(`body:${ref}`),
      hasModel: async () => true,
    };
    installModel3dHandler(source, () => {});
    const models = await collectBoardModelFiles(
      '(model "PureLib.3dshapes/M1.step")',
    );
    expect(models).toHaveLength(1);
    expect(fs.mkdirTree).not.toHaveBeenCalled();
    expect(fs.writeFile).not.toHaveBeenCalled();
    expect(fs.readFile).not.toHaveBeenCalled();
    expect(fs.analyzePath).not.toHaveBeenCalled();
  });
});

describe("scanModelRefs", () => {
  it("finds, normalizes and dedupes board model refs", () => {
    const board = `
      (footprint "Resistor_THT:R_Axial"
        (model "\${KICAD10_3DMODEL_DIR}/Resistor_THT.3dshapes/R_Axial.step"
          (offset (xyz 0 0 0))))
      (footprint "Resistor_THT:R_Axial"
        (model "\${KICAD10_3DMODEL_DIR}/Resistor_THT.3dshapes/R_Axial.step"))
      (footprint "X:Y"
        (model "\${KIPRJMOD}/libs/3d_shapes/custom.wrl"))
      (footprint "L:M" (model "\${KICAD8_3DMODEL_DIR}/LED_THT.3dshapes/LED_D5.0mm.wrl"))
    `;
    expect(scanModelRefs(board).sort()).toEqual([
      "LED_THT.3dshapes/LED_D5.0mm.wrl",
      "Resistor_THT.3dshapes/R_Axial.step",
    ]);
  });

  it("handles escaped quotes inside the path", () => {
    expect(
      scanModelRefs('(model "${KICAD9_3DMODEL_DIR}/A.3dshapes/we\\"ird.wrl")'),
    ).toEqual(['A.3dshapes/we"ird.wrl']);
  });

  it("returns empty for a board with no models", () => {
    expect(scanModelRefs("(kicad_pcb (version 20240101))")).toEqual([]);
  });
});

describe("deferred board prescan (read-only sessions)", () => {
  function installCounting() {
    const files = new Map<string, Uint8Array>();
    const fs = {
      mkdirTree: () => {},
      writeFile: (p: string, b: Uint8Array) => void files.set(p, b),
      analyzePath: (p: string) => ({ exists: files.has(p) }),
    };
    (globalThis as unknown as { window: unknown }).window ??= globalThis;
    // The prescan emits its progress event on window (node: bare globalThis).
    (globalThis as unknown as { dispatchEvent?: unknown }).dispatchEvent ??= () => true;
    (globalThis as unknown as { FS: unknown }).FS = fs;
    let fetches = 0;
    const source: Model3dSource = {
      getModelBody: async (ref) => {
        fetches++;
        return new TextEncoder().encode(`body:${ref}`);
      },
      hasModel: async () => true,
    };
    installModel3dHandler(source, () => {});
    return { files, fetches: () => fetches };
  }

  it("fetches nothing at defer time and everything on the first run", async () => {
    const t = installCounting();
    deferBoardModelPrescan(
      '(model "${KICAD10_3DMODEL_DIR}/DeferLib.3dshapes/A.step") (model "${KICAD10_3DMODEL_DIR}/DeferLib.3dshapes/B.step")',
    );
    expect(t.fetches()).toBe(0);
    await runDeferredModelPrescan();
    expect(t.fetches()).toBe(2);
    expect(t.files.has("/pcbjam/3dmodels/DeferLib.3dshapes/A.step")).toBe(true);
    // Consumed: a second open does not re-scan.
    await runDeferredModelPrescan();
    expect(t.fetches()).toBe(2);
  });

  it("is a no-op when nothing was deferred", async () => {
    const t = installCounting();
    await runDeferredModelPrescan();
    expect(t.fetches()).toBe(0);
  });
});
