// Extracted from WasmTool.tsx (2026-08-25 split) — behavior unchanged.
// The wx wasm port calls window.wxAppTopWindowClosed() when the app's MAIN
// frame is destroyed (wxwidgets src/wasm/toplevel.cpp) — i.e. on a real
// File→Quit / window close. A close vetoed by the unsaved-changes prompt never
// destroys the frame, so it never fires. The port also closes the frame while
// the page itself unloads (app.cpp UnloadCallback), so the dispatcher latches
// off as soon as any unload/navigation is under way.

let activeQuitHook: (() => void) | undefined;
let quitHandled = false;

/**
 * Latch the quit dispatcher off ahead of a deliberate in-app navigation (the
 * tool-switch hook's location.assign). The wx port's UnloadCallback runs on
 * BEFOREUNLOAD — i.e. the instant the navigation starts, while this document
 * keeps running until the next one commits — and closes the top frame, which
 * fires wxAppTopWindowClosed. Without the latch the quit hook then navigates
 * to the exit URL over the in-flight navigation (the pagehide latch below is
 * too late: pagehide only fires at commit time). One-shot per document, same
 * as the pagehide latch — this page is on its way out.
 */
export function markDeliberateNavigation() {
  quitHandled = true;
}

const quitDispatcher = () => {
  if (quitHandled) return;
  quitHandled = true;
  // The wasm side only calls this when the app's top window is genuinely
  // destroyed. When that happens unexpectedly (2026-08-03: a guarded-off
  // settle-window dispatch cascaded into a silent frame close), the stack is
  // the only artifact that says WHO closed it — keep it in every log.
  console.warn("[quit] wxAppTopWindowClosed invoked — top window destroyed", new Error("quit-origin").stack);
  activeQuitHook?.();
};

function ensureQuitDispatcher(win: ToolWindow): boolean {
  if (win.wxAppTopWindowClosed === quitDispatcher) return true;

  try {
    Object.defineProperty(win, "wxAppTopWindowClosed", {
      configurable: true,
      value: quitDispatcher,
    });
    return true;
  } catch {
    return false;
  }
}

if (typeof window !== "undefined") {
  ensureQuitDispatcher(window as ToolWindow);
  // Latch off for a BROWSER-initiated unload: reload (F5), Back, closing the
  // tab, typing a URL. markDeliberateNavigation covers only our own in-app
  // navigations, and the pagehide latch below fires at commit time — too late.
  // The wx port's UnloadCallback runs on beforeunload and closes the top frame,
  // which fires wxAppTopWindowClosed; unlatched, the quit hook then navigated to
  // the project overview OVER the in-flight reload, so every refresh of an
  // editor URL bounced to the management app instead of reloading.
  //
  // Registered at MODULE scope, which runs on import — before the wasm boots and
  // installs its own beforeunload handler. Listeners fire in registration order,
  // so this latch is always set before UnloadCallback can close the frame.
  //
  // Tradeoff: if a beforeunload prompt is shown and the user chooses to stay,
  // the latch stays set and a later File→Quit won't navigate on its own. That
  // is strictly better than the alternative — a page that cannot be refreshed —
  // and the user can still navigate manually.
  window.addEventListener(
    "beforeunload",
    () => {
      quitHandled = true;
    },
    { capture: true },
  );
}

export function installQuitHook(
  win: ToolWindow,
  opts: { exitUrl: string; log: (m: string) => void },
): () => void {
  const hook = () => {
    // Quit always navigates to the exit URL (project overview / home). Never
    // history.back(): every in-app entry AND every tool switch is a hard
    // location.assign(), so after a schematic ⇄ pcb switch the previous
    // history entry is another editor — unwinding history strands the user
    // there instead of leaving the editor.
    //
    // Defer the navigation out of the wasm callback: this fires from inside the
    // frame's C++ destructor (via EM_ASM), and the teardown keeps
    // running after we return. A cross-document location.assign() started here is
    // aborted by that continuing teardown — so hand it to a fresh task once the
    // wasm stack has unwound.
    setTimeout(() => {
      opts.log(`[quit] editor closed — going to ${opts.exitUrl}`);
      win.location.assign(opts.exitUrl);
    }, 0);
  };

  if (!ensureQuitDispatcher(win)) {
    opts.log("[quit] unable to install quit hook");
  }
  activeQuitHook = hook;

  // Once the page is unloading for any reason, the hook must never navigate.
  const markUnloading = () => {
    quitHandled = true;
  };
  win.addEventListener("pagehide", markUnloading);

  // A bfcache restore (Forward after quitting) would resurrect a page whose wx
  // frame was already destroyed — force a clean re-boot instead.
  const onPageShow = (e: PageTransitionEvent) => {
    if (e.persisted) win.location.reload();
  };
  win.addEventListener("pageshow", onPageShow);

  return () => {
    if (activeQuitHook === hook) activeQuitHook = undefined;
    win.removeEventListener("pagehide", markUnloading);
    win.removeEventListener("pageshow", onPageShow);
  };
}

