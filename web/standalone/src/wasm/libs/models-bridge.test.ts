import { describe, expect, it, vi } from "vitest";
import { MODELS_3D_ROOT } from "../constants";
import {
  collectBoardModelFiles,
  ensureModelInMemfs,
  handleModel3dRequest,
  installModel3dHandler,
  normalizeModelRef,
  prepareModelInMemfs,
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

describe("prepared exact-wait model delivery", () => {
  it("shares one fetch without making the exact caller await a queued prescan apply", async () => {
    type TestScheduler = {
      canTouchNative(): boolean;
      enqueueNativeCompletion(
        site: string,
        estimatedBytes: number,
        run: () => void,
        onAbandon?: (error: Error) => void,
      ): boolean;
    };
    const runtime = globalThis as unknown as {
      window?: typeof globalThis;
      FS?: unknown;
      __wxScheduler?: TestScheduler;
    };
    runtime.window ??= globalThis;
    const previousScheduler = runtime.__wxScheduler;
    const previousFS = runtime.FS;
    const files = new Map<string, Uint8Array>();
    const jobs: Array<{ site: string; retainedBytes: number; run: () => void }> = [];
    let lane: "none" | "exact" | "physical" = "none";
    let writes = 0;
    runtime.FS = {
      analyzePath: (path: string) => {
        expect(lane).not.toBe("none");
        return { exists: files.has(path) };
      },
      mkdirTree: () => expect(lane).not.toBe("none"),
      writeFile: (path: string, body: Uint8Array) => {
        expect(lane).not.toBe("none");
        writes++;
        files.set(path, new Uint8Array(body));
      },
      readFile: (path: string) => files.get(path),
    };
    runtime.__wxScheduler = {
      canTouchNative: () => true,
      enqueueNativeCompletion: (site, retainedBytes, run) => {
        jobs.push({ site, retainedBytes, run });
        return true;
      },
    };

    let resolveBody!: (body: Uint8Array | null) => void;
    const source: Model3dSource = {
      getModelBody: vi.fn(
        () =>
          new Promise<Uint8Array | null>((resolve) => {
            resolveBody = resolve;
          }),
      ),
      hasModel: async () => true,
    };
    const ref = "ExactShared.3dshapes/M.step";
    const target = `${MODELS_3D_ROOT}/${ref}`;
    const bytes = new TextEncoder().encode("exact-shared-body");

    try {
      installModel3dHandler(source, () => {});
      // The ordinary caller models prescan/OCC. Let its fetch finish and its
      // physical apply queue before K3 asks for the same ref: the prepared body
      // must remain reusable throughout that admission gap.
      const ordinary = ensureModelInMemfs(ref);
      expect(source.getModelBody).toHaveBeenCalledTimes(1);

      resolveBody(bytes);
      await vi.waitFor(() => expect(jobs).toHaveLength(1));

      // The provider call models K3. It receives the already fetched body and
      // does not join the ordinary caller's still-queued physical apply.
      const exactPrepared = handleModel3dRequest("ensure", ref);
      const prepared = await exactPrepared;
      expect(prepared?.__pcbjamPreparedModel3d).toBe(true);
      expect(prepared?.retainedBytes).toBe(bytes.byteLength);
      if (!prepared) throw new Error("model preparation unexpectedly failed");

      // The ordinary caller is still blocked on its physical apply. The exact
      // caller owns the fetched body and can complete without that job.
      expect(jobs[0]).toMatchObject({
        site: `3D-model MEMFS apply: ${ref}`,
        retainedBytes: bytes.byteLength,
      });

      lane = "exact";
      expect(prepared.apply()).toBe(target);
      lane = "none";
      expect(files.get(target)).toEqual(bytes);

      lane = "physical";
      jobs[0]!.run();
      lane = "none";
      await expect(ordinary).resolves.toBe(target);
      expect(writes, "the exact and queued consumers converge on one write").toBe(1);
      expect(source.getModelBody, "the fetch, not the apply, is coalesced").toHaveBeenCalledTimes(1);
    } finally {
      runtime.__wxScheduler = previousScheduler;
      runtime.FS = previousFS;
    }
  });

  it("starts independent preparations together and preserves each path and body", async () => {
    const runtime = globalThis as unknown as {
      window?: typeof globalThis;
      FS?: unknown;
      __wxScheduler?: unknown;
    };
    runtime.window ??= globalThis;
    const previousScheduler = runtime.__wxScheduler;
    const previousFS = runtime.FS;
    delete runtime.__wxScheduler;
    const files = new Map<string, Uint8Array>();
    runtime.FS = {
      analyzePath: (path: string) => ({ exists: files.has(path) }),
      mkdirTree: () => {},
      writeFile: (path: string, body: Uint8Array) =>
        files.set(path, new Uint8Array(body)),
      readFile: (path: string) => files.get(path),
    };

    const pending = new Map<string, (body: Uint8Array | null) => void>();
    const source: Model3dSource = {
      getModelBody: vi.fn(
        (ref: string) =>
          new Promise<Uint8Array | null>((resolve) => pending.set(ref, resolve)),
      ),
      hasModel: async () => true,
    };
    const a = "ExactA.3dshapes/A.step";
    const b = "ExactB.3dshapes/B.step";
    const bodyA = new TextEncoder().encode("body-a");
    const bodyB = new TextEncoder().encode("body-b");

    try {
      installModel3dHandler(source, () => {});
      const preparedA = prepareModelInMemfs(a);
      const preparedB = prepareModelInMemfs(b);
      expect([...pending.keys()]).toEqual([a, b]);

      pending.get(b)!(bodyB);
      pending.get(a)!(bodyA);
      const [resultA, resultB] = await Promise.all([preparedA, preparedB]);
      if (!resultA || !resultB) throw new Error("model preparation unexpectedly failed");

      expect(resultB.apply()).toBe(`${MODELS_3D_ROOT}/${b}`);
      expect(resultA.apply()).toBe(`${MODELS_3D_ROOT}/${a}`);
      expect(files.get(`${MODELS_3D_ROOT}/${a}`)).toEqual(bodyA);
      expect(files.get(`${MODELS_3D_ROOT}/${b}`)).toEqual(bodyB);
    } finally {
      runtime.__wxScheduler = previousScheduler;
      runtime.FS = previousFS;
    }
  });

  it("makes a prepared apply inert after its source generation is replaced", async () => {
    const runtime = globalThis as unknown as {
      window?: typeof globalThis;
      FS?: unknown;
      __wxScheduler?: unknown;
    };
    runtime.window ??= globalThis;
    const previousScheduler = runtime.__wxScheduler;
    const previousFS = runtime.FS;
    delete runtime.__wxScheduler;
    const files = new Map<string, Uint8Array>();
    runtime.FS = {
      analyzePath: (path: string) => ({ exists: files.has(path) }),
      mkdirTree: () => {},
      writeFile: (path: string, body: Uint8Array) =>
        files.set(path, new Uint8Array(body)),
      readFile: (path: string) => files.get(path),
    };
    const oldSource: Model3dSource = {
      getModelBody: async () => new TextEncoder().encode("old"),
      hasModel: async () => true,
    };
    const newSource: Model3dSource = {
      getModelBody: async () => new TextEncoder().encode("new"),
      hasModel: async () => true,
    };
    const ref = "Generation.3dshapes/M.step";
    const target = `${MODELS_3D_ROOT}/${ref}`;

    try {
      installModel3dHandler(oldSource, () => {});
      const stale = await handleModel3dRequest("ensure", ref);
      if (!stale) throw new Error("old model preparation unexpectedly failed");

      installModel3dHandler(newSource, () => {});
      expect(stale.apply(), "an old source cannot publish into a replacement runtime").toBeNull();
      expect(files.has(target)).toBe(false);

      const current = await handleModel3dRequest("ensure", ref);
      if (!current) throw new Error("new model preparation unexpectedly failed");
      expect(current.apply()).toBe(target);
      expect(new TextDecoder().decode(files.get(target))).toBe("new");
    } finally {
      runtime.__wxScheduler = previousScheduler;
      runtime.FS = previousFS;
    }
  });
});

describe("asynchronous model FS admission", () => {
  it("starts provider reads together, then admits each FS apply and read exactly once", async () => {
    type TestScheduler = {
      canTouchNative(): boolean;
      enqueueNativeCompletion(
        site: string,
        estimatedBytes: number,
        run: () => void,
        onAbandon?: (error: Error) => void,
      ): boolean;
    };
    const runtime = globalThis as unknown as {
      window?: typeof globalThis;
      FS?: unknown;
      __wxScheduler?: TestScheduler;
    };
    runtime.window ??= globalThis;
    const previousScheduler = runtime.__wxScheduler;

    const files = new Map<string, Uint8Array>();
    const events: string[] = [];
    let insideNative = false;
    let nativeRuns = 0;
    const requireAdmission = (op: string, path: string) => {
      expect(insideNative, `${op} ${path} runs inside native admission`).toBe(true);
      events.push(`${op}:${path}`);
    };
    runtime.FS = {
      analyzePath: (path: string) => {
        requireAdmission("analyze", path);
        return { exists: files.has(path) };
      },
      mkdirTree: (path: string) => requireAdmission("mkdir", path),
      writeFile: (path: string, body: Uint8Array) => {
        requireAdmission("write", path);
        files.set(path, new Uint8Array(body));
      },
      readFile: (path: string) => {
        requireAdmission("read", path);
        return files.get(path)!;
      },
    };

    const pending = new Map<
      string,
      (body: Uint8Array | null) => void
    >();
    const sourceBodies = new Map<string, Uint8Array | null>();
    const source: Model3dSource = {
      getModelBody: vi.fn(
        (ref: string) => {
          if (sourceBodies.has(ref)) {
            const body = sourceBodies.get(ref);
            return Promise.resolve(body ? new Uint8Array(body) : null);
          }
          return new Promise<Uint8Array | null>((resolve) => {
            events.push(`fetch:${ref}`);
            pending.set(ref, (body) => {
              sourceBodies.set(ref, body ? new Uint8Array(body) : null);
              resolve(body);
            });
          });
        },
      ),
      hasModel: async () => true,
    };

    const jobs: Array<{ estimatedBytes: number; run: () => void }> = [];
    runtime.__wxScheduler = {
      canTouchNative: () => true,
      enqueueNativeCompletion: (site, estimatedBytes, run) => {
        events.push(`queued:${site}`);
        jobs.push({
          estimatedBytes,
          run: () => {
            expect(insideNative, "native completions never overlap").toBe(false);
            insideNative = true;
            nativeRuns++;
            try {
              run();
            } finally {
              insideNative = false;
            }
          },
        });
        return true;
      },
    };

    const a = "AsyncAdmissionA.3dshapes/A.step";
    const b = "AsyncAdmissionB.3dshapes/B.step";
    const absA = `${MODELS_3D_ROOT}/${a}`;
    const absB = `${MODELS_3D_ROOT}/${b}`;

    try {
      installModel3dHandler(source, () => {});
      const resultA = ensureModelInMemfs(a);
      const resultB = ensureModelInMemfs(b);

      // Both independent source reads start before either Promise resolves or
      // any FS/native-entry work is admitted.
      expect([...pending.keys()]).toEqual([a, b]);
      expect(jobs).toHaveLength(0);
      expect(events).toEqual([`fetch:${a}`, `fetch:${b}`]);

      // Resolve out of order. Each completed body owns one queued FS apply;
      // neither continuation touches FS while merely joining the native FIFO.
      pending.get(b)!(new TextEncoder().encode("body-b"));
      pending.get(a)!(new TextEncoder().encode("body-a"));
      await vi.waitFor(() => expect(jobs).toHaveLength(2));
      expect(jobs.map((job) => job.estimatedBytes)).toEqual([6, 6]);
      expect(files.size).toBe(0);

      jobs.splice(0).forEach((job) => job.run());
      await expect(Promise.all([resultA, resultB])).resolves.toEqual([absA, absB]);
      expect(events.filter((event) => event.startsWith("write:"))).toEqual([
        `write:${absB}`,
        `write:${absA}`,
      ]);
      expect(files.size, "one admitted write per completed model").toBe(2);
      expect(nativeRuns).toBe(2);

      // OCC export collection reads the source/cache directly. The worker has
      // its own MEMFS, so this path must not re-enter the editor merely to read
      // bytes back out of its heap.
      const collected = collectBoardModelFiles(
        `(model "${a}")\n(model "${b}")`,
        2,
      );
      const models = await collected;
      expect(models.map((model) => model.path).sort()).toEqual([a, b]);
      expect(jobs).toHaveLength(0);
      expect(events.filter((event) => event.startsWith("read:"))).toHaveLength(0);
      expect(nativeRuns).toBe(2);
    } finally {
      runtime.__wxScheduler = previousScheduler;
    }
  });

  it("rejects and releases an accepted model apply when shutdown abandons its entry", async () => {
    type TestScheduler = {
      canTouchNative(): boolean;
      enqueueNativeCompletion(
        site: string,
        estimatedBytes: number,
        run: () => void,
        onAbandon?: (error: Error) => void,
      ): boolean;
    };
    type QueuedCompletion = {
      site: string;
      run: () => void;
      onAbandon?: (error: Error) => void;
    };
    const runtime = globalThis as unknown as {
      window?: typeof globalThis;
      FS?: unknown;
      __wxScheduler?: TestScheduler;
    };
    runtime.window ??= globalThis;
    const previousScheduler = runtime.__wxScheduler;
    const previousFS = runtime.FS;
    let live = true;
    let writes = 0;
    const files = new Map<string, Uint8Array>();
    runtime.FS = {
      analyzePath: (path: string) => ({ exists: files.has(path) }),
      mkdirTree: () => {},
      writeFile: (path: string, body: Uint8Array) => {
        writes++;
        files.set(path, new Uint8Array(body));
      },
      readFile: (path: string) => files.get(path),
    };

    const jobs: QueuedCompletion[] = [];
    runtime.__wxScheduler = {
      canTouchNative: () => live,
      enqueueNativeCompletion: (site, _estimatedBytes, run, onAbandon) => {
        jobs.push({ site, run, onAbandon });
        return true;
      },
    };
    const source: Model3dSource = {
      getModelBody: vi.fn(async (ref) =>
        new TextEncoder().encode(`body:${ref}`)),
      hasModel: async () => true,
    };
    const ref = "ShutdownApply.3dshapes/M.step";
    const target = `${MODELS_3D_ROOT}/${ref}`;

    try {
      installModel3dHandler(source, () => {});
      const first = ensureModelInMemfs(ref);
      for (let i = 0; i < 6 && jobs.length < 1; i++) await Promise.resolve();
      expect(jobs).toHaveLength(1);
      expect(jobs[0]!.onAbandon).toBeTypeOf("function");

      live = false;
      const shutdownError = Object.assign(
        new Error("[wx-scheduler] native entry abandoned at model apply"),
        { code: "WX_NATIVE_ENTRY_ABANDONED", site: jobs[0]!.site },
      );
      jobs[0]!.onAbandon!(shutdownError);
      await expect(first).rejects.toMatchObject({
        code: "WX_NATIVE_ENTRY_ABANDONED",
        site: `3D-model MEMFS apply: ${ref}`,
      });
      expect(writes).toBe(0);
      expect(files.has(target)).toBe(false);

      // The rejected Promise must retire the physical-apply coalescing record.
      // A later admission can reuse the completed immutable source body, but
      // must enqueue fresh physical work rather than inherit the abandoned
      // apply Promise.
      live = true;
      const second = ensureModelInMemfs(ref);
      for (let i = 0; i < 6 && jobs.length < 2; i++) await Promise.resolve();
      expect(jobs).toHaveLength(2);
      jobs[1]!.run();
      await expect(second).resolves.toBe(target);
      expect(source.getModelBody).toHaveBeenCalledTimes(1);
      expect(writes).toBe(1);
    } finally {
      runtime.__wxScheduler = previousScheduler;
      runtime.FS = previousFS;
    }
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
