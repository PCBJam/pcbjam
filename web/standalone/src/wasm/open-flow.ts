/**
 * Drive the tool (running in `win` — the top-level window) to open a file
 * already written into its MEMFS.
 *
 * Two strategies, tried in order:
 *   1. Programmatic hook — `win.Module.kicadOpenFile(path)` if the build exposes
 *      one. PREFERRED (spec §11.2): deterministic, no UI automation. Not present
 *      in the current build; adding it is a small embind change.
 *   2. UI automation fallback — synthesize canvas mouse/keyboard events using
 *      win.wxElementRegistry coordinates (a browser port of
 *      tests/kicad/load-pcb.spec.ts). Inherently fragile; EXPERIMENTAL, needs
 *      in-browser validation.
 */

export interface OpenFlowOptions {
  log: (msg: string) => void;
  timeoutMs?: number;
  /** Override the load-settle budget (kicadOpenFileBusy poll) — tests only. */
  settleTimeoutMs?: number;
  /**
   * Replace the programmatic invocation (default: `Module.kicadOpenFile(path)`)
   * while keeping the readiness handling around it — the frame wait, the
   * settle gate, the no-UI-automation-while-parked rule. GerbView uses this to
   * open a whole fabrication set through `kicadOpenFiles`. May return the
   * open call's Promise (JSPI embind async) — the flow contains its rejection.
   */
  open?: () => unknown;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor<T>(
  fn: () => T | null | undefined | false,
  timeoutMs: number,
  intervalMs = 200,
): Promise<T | null> {
  const deadline = performance.now() + timeoutMs;
  for (;;) {
    const v = fn();
    if (v) return v as T;
    if (performance.now() >= deadline) return null;
    await sleep(intervalMs);
  }
}

function registry(win: ToolWindow): WxElementRegistry | undefined {
  return win.wxElementRegistry;
}

function visible(
  win: ToolWindow,
  filter: { type?: string; name?: string; label?: string },
): WxElementInfo[] {
  return registry(win)?.findAll({ ...filter, visible: true }) ?? [];
}

function canvasOf(win: ToolWindow): HTMLCanvasElement | null {
  return (win.Module?.canvas as HTMLCanvasElement) ?? null;
}

/** Dispatch a full pointer+mouse click at page coordinates on the tool canvas. */
function clickAt(win: ToolWindow, x: number, y: number): void {
  const el = canvasOf(win);
  if (!el) return;
  const PE = win.PointerEvent ?? PointerEvent;
  const ME = win.MouseEvent ?? MouseEvent;
  const base = { clientX: x, clientY: y, bubbles: true, cancelable: true };
  el.dispatchEvent(new PE("pointerdown", { ...base, pointerId: 1 }));
  el.dispatchEvent(new ME("mousedown", { ...base, button: 0 }));
  el.dispatchEvent(new PE("pointerup", { ...base, pointerId: 1 }));
  el.dispatchEvent(new ME("mouseup", { ...base, button: 0 }));
  el.dispatchEvent(new ME("click", { ...base, button: 0 }));
}

function typeText(win: ToolWindow, text: string): void {
  const el = canvasOf(win) ?? win.document.body;
  const KE = win.KeyboardEvent ?? KeyboardEvent;
  for (const ch of text) {
    const init = { key: ch, bubbles: true, cancelable: true } as KeyboardEventInit;
    el.dispatchEvent(new KE("keydown", init));
    el.dispatchEvent(new KE("keypress", init));
    el.dispatchEvent(new KE("keyup", init));
  }
}

function pressKey(win: ToolWindow, key: string): void {
  const el = canvasOf(win) ?? win.document.body;
  const KE = win.KeyboardEvent ?? KeyboardEvent;
  const init = { key, bubbles: true, cancelable: true } as KeyboardEventInit;
  el.dispatchEvent(new KE("keydown", init));
  el.dispatchEvent(new KE("keyup", init));
}

/** True if the build exposes the programmatic open hook. */
function hasProgrammaticHook(win: ToolWindow): boolean {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mod = win.Module as any;
  return !!mod && typeof mod.kicadOpenFile === "function";
}

/**
 * Invoke the programmatic hook. kicadOpenFile suspends mid-load either way:
 * under JSPI it is an embind async() export and returns a real Promise for the
 * whole load chain; legacy asyncify builds return a falsy placeholder. The
 * caller contains the Promise's rejection and gates readiness on the settle
 * probe, which is truthful for both shapes.
 */
function invokeProgrammaticOpen(
  win: ToolWindow,
  absPath: string,
  log: (m: string) => void,
): unknown {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mod = win.Module as any;
  const ret = mod.kicadOpenFile(absPath);
  log(`[open] invoked Module.kicadOpenFile(${absPath}) (async; awaiting settle)`);
  return ret;
}

/** Heuristic: the editor frame title drops "untitled" once a real file is open. */
function schematicLoaded(win: ToolWindow): boolean {
  const title = win.document?.title ?? "";
  return title.length > 0 && !/untitled/i.test(title);
}

/**
 * How long a load may stay in flight before we give up waiting and boot on
 * without collab (slow Firefox + big board loads run minutes, and the poll is
 * free — see waitForOpenSettled).
 */
const OPEN_SETTLE_TIMEOUT_MS = 300_000;

/**
 * A modal dialog other than the load's own progress dialog is up — the open
 * chain is parked waiting for USER input (file-version confirm, remap…). We
 * must not keep the shell blocked (the boot overlay would sit on top of the
 * dialog, unanswerable), so the settle wait treats this as "proceed".
 */
function inputDialogVisible(win: ToolWindow): boolean {
  return visible(win, {}).some(
    (e) => /Dialog/.test(e.typeName) && !/Progress/i.test(e.typeName),
  );
}

/**
 * Wait until the kicadOpenFile Asyncify chain has TRULY completed.
 *
 * kicadOpenFile suspends and unwinds back to JS long before the load finishes;
 * for the whole load the chain stays parked mid-mutation of the board/schematic.
 * Any bare embind entry that walks the model during such a park (collab
 * snapshot, presence bind) can virtual-dispatch through a half-built item and
 * trap with "indirect call signature mismatch" — the same reentrancy class the
 * wx dispatch interlock guards, but through a JS entry it cannot see. The old
 * readiness signal (the "untitled" title heuristic below) passes IMMEDIATELY
 * for any real project (the pre-open title is just "PCB Editor"), so it never
 * actually gated anything.
 *
 * The truthful signal is the wasm's kicadOpenFileBusy probe (open_gate.h): an
 * RAII counter on the open's C++ stack, held across every park, dropped when
 * OpenProjectFiles really returns. Feature-detected — wasm builds predating it
 * fall back to the legacy title poll. Returns false when the load never
 * settled (caller reports "failed"; the shell then skips the wasm-entering
 * collab/presence attach instead of trapping).
 */
async function waitForOpenSettled(
  win: ToolWindow,
  log: (m: string) => void,
  legacyTimeoutMs: number,
  settleTimeoutMs = OPEN_SETTLE_TIMEOUT_MS,
): Promise<boolean> {
  const mod = win.Module as { kicadOpenFileBusy?: () => boolean } | undefined;
  const busyFn = mod?.kicadOpenFileBusy;
  if (typeof busyFn === "function") {
    const settled = await waitFor(
      () => !busyFn.call(mod) || inputDialogVisible(win),
      settleTimeoutMs,
    );
    if (!settled) {
      log("[open] load chain never settled (kicadOpenFileBusy stuck) — giving up");
      return false;
    }
    if (busyFn.call(mod)) {
      log("[open] modal dialog during load — proceeding so it stays answerable");
    } else {
      log("[open] load chain settled (kicadOpenFileBusy cleared)");
    }
    return true;
  }
  // Legacy wasm without the probe: the old title heuristic.
  const loaded = await waitFor(() => schematicLoaded(win), legacyTimeoutMs);
  if (!loaded) {
    log("[open] kicadOpenFile did not load the schematic within timeout");
    return false;
  }
  log(`[open] schematic loaded: ${win.document.title}`);
  return true;
}

export async function openFileInTool(
  win: ToolWindow,
  absPath: string,
  opts: OpenFlowOptions,
): Promise<"programmatic" | "ui" | "failed"> {
  const { log } = opts;
  const timeoutMs = opts.timeoutMs ?? 60000;

  // Both strategies need the editor frame up first. Crucially, the programmatic
  // hook (Module.kicadOpenFile → OpenProjectFiles) requires a top window, and
  // embind only registers the hook during runtime init — which lands AFTER the
  // Emscripten FS is ready, i.e. after driveProjectIntoTool calls us. Probing
  // the hook before the frame exists therefore always missed and fell back to
  // UI automation (and the wizard's modal loop then crashed Asyncify). Waiting
  // for a visible Frame guarantees the runtime is initialized, the hook is
  // registered, and a top window exists — so we probe only after this point.
  const ready = await waitFor(
    () =>
      visible(win, {}).some(
        (e) => /Frame$/.test(e.typeName) || e.name.endsWith("Frame"),
      ),
    timeoutMs,
  );
  if (!ready) {
    log("[open] app frame never became visible");
    return "failed";
  }

  // Strategy 1: programmatic hook (preferred — deterministic, no UI automation).
  // The open call suspends mid-load; readiness comes from the settle probe
  // (kicadOpenFileBusy — see waitForOpenSettled), NOT the call's return: under
  // JSPI the returned Promise deliberately stays pending while the load is
  // parked on a user dialog (file-version confirm, remap…), exactly the case
  // the probe's input-dialog escape handles. We must NOT fall back to UI
  // automation while the hook is in flight — synthesizing input would re-enter
  // the suspended load and corrupt it.
  if (opts.open || hasProgrammaticHook(win)) {
    const ret = opts.open ? opts.open() : invokeProgrammaticOpen(win, absPath, log);
    // JSPI: contain the load Promise's rejection — a failed open clears the
    // busy gate (RAII) and reports through the settle path like it always
    // has; it must not ALSO surface as an unhandled rejection.
    Promise.resolve(ret).catch((e) => log(`[open] open chain rejected: ${e}`));
    const settled = await waitForOpenSettled(win, log, timeoutMs, opts.settleTimeoutMs);
    return settled ? "programmatic" : "failed";
  }

  // Strategy 2: UI automation fallback (EXPERIMENTAL, fragile). Only when the
  // build has no programmatic hook at all.
  log("[open] no programmatic hook; using EXPERIMENTAL UI automation");

  const fileMenu =
    registry(win)
      ?.findByLabel("File", {})
      ?.find((e) => e.visible) ??
    visible(win, {}).find((e) => e.label === "File");
  if (!fileMenu) {
    log("[open] could not find File menu");
    return "failed";
  }
  clickAt(win, fileMenu.centerX, fileMenu.centerY);
  await sleep(400);

  const openItem =
    registry(win)?.findRenderedByLabel?.("Open...", {})?.[0] ??
    registry(win)?.findByLabel("Open...", {})?.[0];
  if (!openItem) {
    log("[open] could not find Open... item");
    return "failed";
  }
  clickAt(win, openItem.centerX, openItem.centerY);

  const dlg = await waitFor(() => visible(win, { type: "wxFileDialog" })[0], 15000);
  if (!dlg) {
    log("[open] wxFileDialog never appeared");
    return "failed";
  }
  await sleep(800);

  const textInput = visible(win, { type: "wxTextCtrl" }).find(
    (e) => e.name === "text",
  );
  if (!textInput) {
    log("[open] filename text input not found");
    return "failed";
  }
  clickAt(win, textInput.centerX, textInput.centerY);
  await sleep(150);
  typeText(win, absPath);
  await sleep(150);
  pressKey(win, "Enter");
  log(`[open] typed path and pressed Enter: ${absPath}`);
  return "ui";
}
