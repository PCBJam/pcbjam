import { afterEach, describe, expect, it, vi } from "vitest";
import {
  hasWritableLib,
  installPthreadWorkerRedirect,
  pthreadWorkerScript,
  resetWorkerRedirectForTest,
} from "./boot";
import type { LibInfo } from "./libs/source";

const lib = (type?: string): LibInfo => ({ id: `id-${type}`, name: `n-${type}`, type });

describe("hasWritableLib", () => {
  it("sees an example-backend 'user' lib", () => {
    expect(hasWritableLib([[lib("origin"), lib("user")]])).toBe(true);
  });

  it("sees a private-platform 'org' lib (renamed from 'user') — the My Symbols 409", () => {
    expect(hasWritableLib([[lib("origin")], [lib("mirror"), lib("org")]])).toBe(true);
  });

  it("false when only read-only libs are listed", () => {
    expect(hasWritableLib([[lib("origin"), lib("mirror")], [lib(undefined)]])).toBe(false);
  });

  it("false on empty lists", () => {
    expect(hasWritableLib([[], []])).toBe(false);
    expect(hasWritableLib([])).toBe(false);
  });
});

/**
 * Cross-origin (CDN) pthread spawn fix — doc-23 §7 KNOWN GAP. Emscripten
 * spawns pthread workers from the glue's absolute URL; when that URL is the
 * CDN, `new Worker(...)` is a SecurityError and the editor dies right after
 * instantiation (observed on staging). The redirect substitutes a same-origin
 * blob that importScripts() the glue — for EXACTLY that URL, nothing else.
 */
describe("installPthreadWorkerRedirect", () => {
  class FakeWorker {
    constructor(
      public scriptURL: string | URL,
      public opts?: WorkerOptions,
    ) {}
  }
  const PAGE = "https://editor.example.test/some/route";
  const CDN = "https://cdn.example.test/wasm/kicad_editor/rev";

  function stubWindow(): { win: { location: { href: string; origin: string }; Worker: unknown } } {
    const win = {
      location: { href: PAGE, origin: "https://editor.example.test" },
      Worker: FakeWorker as unknown,
    };
    vi.stubGlobal("window", win);
    return { win };
  }

  afterEach(() => {
    vi.unstubAllGlobals();
    resetWorkerRedirectForTest();
  });

  it("same-origin base without trace installs nothing", () => {
    const { win } = stubWindow();
    installPthreadWorkerRedirect("/wasm/kicad_editor/rev", "kicad_editor");
    expect(win.Worker).toBe(FakeWorker);
  });

  it("cross-origin base: the glue URL is redirected to a same-origin blob; everything else passes through", () => {
    const { win } = stubWindow();
    installPthreadWorkerRedirect(CDN, "kicad_editor");
    expect(win.Worker).not.toBe(FakeWorker);
    const W = win.Worker as new (u: string | URL, o?: WorkerOptions) => FakeWorker;

    // Exactly what emscripten does: new Worker(_scriptName) with the glue URL.
    const pthread = new W(`${CDN}/kicad_editor.js`, { name: "em-pthread" });
    expect(String(pthread.scriptURL).startsWith("blob:")).toBe(true);
    expect(pthread.opts).toEqual({ name: "em-pthread" });

    // Unrelated workers (ngspice/occ services…) are untouched.
    const other = new W("/assets/other-worker.js");
    expect(other.scriptURL).toBe("/assets/other-worker.js");
  });

  it("?trace= rides the blob even same-origin (worker realms need the env)", () => {
    const { win } = stubWindow();
    installPthreadWorkerRedirect(
      "/wasm/kicad_editor/rev",
      "kicad_editor",
      "KI_TRACE_SYM_CHOOSER",
    );
    const W = win.Worker as new (u: string | URL) => FakeWorker;
    const pthread = new W(
      "https://editor.example.test/wasm/kicad_editor/rev/kicad_editor.js",
    );
    expect(String(pthread.scriptURL).startsWith("blob:")).toBe(true);
  });

  it("the blob trampoline importScripts the absolute glue URL", async () => {
    stubWindow();
    const script = pthreadWorkerScript(CDN, "kicad_editor");
    expect(script).toBeInstanceOf(Blob);
    const text = await (script as Blob).text();
    expect(text).toBe(
      `importScripts(${JSON.stringify(`${CDN}/kicad_editor.js`)});`,
    );
    // Same-origin without trace stays a plain relative URL (no blob detour).
    expect(pthreadWorkerScript("/wasm/rev", "kicad_editor")).toBe(
      "/wasm/rev/kicad_editor.js",
    );
  });
});
