import type { Page } from "@playwright/test";
import { test, expect } from "./fixtures";

/**
 * Closing, reloading or leaving the tab must not run KiCad's window close.
 *
 * The wx port used to answer `beforeunload` by sending the top frame a vetoable
 * wxEVT_CLOSE_WINDOW. The browser calls that handler synchronously, outside any
 * WebAssembly.promising entry, so the first JSPI wait in KiCad's close path
 * threw: "SuspendError: trying to suspend without WebAssembly.promising" in
 * Chrome, "No matching WebAssembly.promising for call to WebAssembly.Promising
 * import." in Firefox. On a clean board that wait was PCB_EDIT_FRAME::
 * doCloseWindow → Clear_Pcb → TOOL_MANAGER::ResetTools resuming a tool
 * coroutine (a coroutine switch is a JSPI suspend here), after the close had
 * already stopped the canvas and unlinked the project. Every tab close of an
 * open editor reported it (the top pcbjam-editor error in Better Stack).
 *
 * Nothing in that close survives a page unload anyway: KiCad's settings and
 * the .kicad_prl live in MEMFS, and only an explicit Save uploads a file.
 *
 * Checked on a clean and on an edited board: the event raises no error, the
 * frame is not closed (wxAppTopWindowClosed never fires) and the board is
 * still there. A real reload is checked too, with the unloading page's errors
 * recorded in window.name (it survives the reload; DevTools does not show
 * errors thrown while a page unloads).
 */
type FS = { mkdirTree(p: string): void; writeFile(p: string, d: string): void };
type Mod = {
  kicadOpenFile(p: string): unknown;
  kicadBoardStatus(): string;
  kicadCollabTestRemoveItem(id: string): boolean;
};
type Probe = { errors: string[]; closed: number; prevented: boolean };

const BOOT = 150000;
const SEG = ["44444444-0000-0000-0000-000000000001", "44444444-0000-0000-0000-000000000002"];
const BOARD = `(kicad_pcb
\t(version 20241229)
\t(generator "pcbnew")
\t(generator_version "9.0")
\t(general (thickness 1.6))
\t(paper "A4")
\t(layers
\t\t(0 "F.Cu" signal)
\t\t(2 "B.Cu" signal)
\t\t(25 "Edge.Cuts" user)
\t)
\t(setup)
\t(net 0 "")
\t(gr_rect (start 50 50) (end 80 70) (stroke (width 0.1) (type solid)) (fill no) (layer "Edge.Cuts") (uuid "55555555-0000-0000-0000-000000000001"))
\t(segment (start 55 55) (end 75 55) (width 0.25) (layer "F.Cu") (net 0) (uuid "${SEG[0]}"))
\t(segment (start 55 65) (end 75 65) (width 0.25) (layer "F.Cu") (net 0) (uuid "${SEG[1]}"))
)
`;

async function tracks(page: Page): Promise<number> {
  return page.evaluate(
    () =>
      (JSON.parse((window as unknown as { Module: Mod }).Module.kicadBoardStatus()) as { tracks: number })
        .tracks,
  );
}

async function bootAndOpen(page: Page): Promise<void> {
  await page.goto("/kicad/pcbnew-collab.html");
  await expect(page.locator("#canvas")).toBeVisible({ timeout: BOOT });
  await page.waitForFunction(
    () => {
      const m = (window as unknown as { Module?: Partial<Mod> }).Module;
      return typeof m?.kicadOpenFile === "function" && typeof m?.kicadBoardStatus === "function";
    },
    null,
    { timeout: BOOT },
  );
  await page.waitForFunction(
    () =>
      !!window.wxElementRegistry &&
      window.wxElementRegistry
        .findAll({ visible: true })
        .some((e) => /Frame$/.test(e.typeName) || (e.name || "").endsWith("Frame")),
    null,
    { timeout: BOOT },
  );
  await page.evaluate(
    ({ content }) => {
      const w = window as unknown as { FS: FS; Module: Mod };
      const dir = "/home/kicad/documents";
      try {
        w.FS.mkdirTree(dir);
      } catch {
        /* exists */
      }
      w.FS.writeFile(`${dir}/unload.kicad_pcb`, content);
      w.Module.kicadOpenFile(`${dir}/unload.kicad_pcb`);
    },
    { content: BOARD },
  );
  await expect.poll(() => tracks(page), { timeout: 60000 }).toBe(2);
}

/** Dispatch the browser's `beforeunload` and report what it caused. */
async function fireBeforeUnload(page: Page): Promise<Probe> {
  return page.evaluate(() => {
    const probe = { errors: [] as string[], closed: 0, prevented: false };
    const w = window as unknown as { wxAppTopWindowClosed?: () => void };
    const onError = (e: ErrorEvent) => {
      probe.errors.push(`${e.message}\n${(e.error as Error | undefined)?.stack ?? ""}`);
      e.preventDefault();
    };
    const prevQuit = w.wxAppTopWindowClosed;
    w.wxAppTopWindowClosed = () => {
      probe.closed++;
    };
    window.addEventListener("error", onError);
    try {
      const ev = new Event("beforeunload", { cancelable: true });
      window.dispatchEvent(ev);
      probe.prevented = ev.defaultPrevented;
    } finally {
      window.removeEventListener("error", onError);
      w.wxAppTopWindowClosed = prevQuit;
    }
    return probe;
  });
}

test.describe("closing the tab", () => {
  test.setTimeout(240000);

  test("beforeunload runs no KiCad close, on a clean or an edited board", async ({ page, testLogger }) => {
    void testLogger;
    await bootAndOpen(page);

    const clean = await fireBeforeUnload(page);
    expect(clean.errors, "clean board: beforeunload raised").toEqual([]);
    expect(clean.closed, "clean board: the top frame was closed").toBe(0);
    expect(clean.prevented, "clean board: a Leave-site prompt was asked for").toBe(false);
    expect(await tracks(page), "clean board: the board was torn down").toBe(2);

    expect(await page.evaluate((id) => (window as unknown as { Module: Mod }).Module.kicadCollabTestRemoveItem(id), SEG[0])).toBe(true);
    await expect.poll(() => tracks(page), { timeout: 30000 }).toBe(1);

    const edited = await fireBeforeUnload(page);
    expect(edited.errors, "edited board: beforeunload raised").toEqual([]);
    expect(edited.closed, "edited board: the top frame was closed").toBe(0);
    expect(await tracks(page), "edited board: the board was torn down").toBe(1);
  });

  test("a real reload raises nothing in the unloading page", async ({ page, testLogger }) => {
    void testLogger;
    // An error thrown while the page unloads doesn't reliably reach the error
    // event, so wrap every beforeunload listener and record its throw in
    // window.name (it survives the reload). "fired" proves the event ran.
    await page.addInitScript(() => {
      if (!window.name.startsWith("unload-probe:")) window.name = "unload-probe:";
      const wrapped = new WeakMap<object, EventListener>();
      const add = EventTarget.prototype.addEventListener;
      const remove = EventTarget.prototype.removeEventListener;
      EventTarget.prototype.addEventListener = function (type, listener, options) {
        if (type === "beforeunload" && typeof listener === "function") {
          const inner = listener;
          const outer: EventListener = function (this: unknown, ev) {
            try {
              return inner.call(this, ev);
            } catch (err) {
              window.name += `threw: ${(err as Error)?.message}\n`;
              throw err;
            }
          };
          wrapped.set(inner, outer);
          return add.call(this, type, outer, options);
        }
        return add.call(this, type, listener, options);
      };
      EventTarget.prototype.removeEventListener = function (type, listener, options) {
        const outer = listener && wrapped.get(listener);
        return remove.call(this, type, outer ?? listener, options);
      };
      window.addEventListener("beforeunload", () => {
        window.name += "fired\n";
      });
    });
    await bootAndOpen(page);
    // Start the record here. Firefox also runs the init script in the tab's
    // initial about:blank and fires its beforeunload when goto leaves it, and
    // window.name carries that "fired" over into the editor page.
    await page.evaluate(() => {
      window.name = "unload-probe:";
    });

    // A page-initiated reload: Playwright's page.reload() (CDP Page.reload)
    // skips beforeunload in Chromium.
    const reloaded = page.waitForEvent("load");
    await page.evaluate(() => {
      setTimeout(() => location.reload(), 0);
    });
    await reloaded;
    // The new page's init script keeps the record (it resets only a foreign name).
    const record = await page.evaluate(() => window.name);
    expect(record, "the reload ran beforeunload").toContain("fired");
    expect(record, "the unloading page raised").not.toContain("threw:");
  });
});
