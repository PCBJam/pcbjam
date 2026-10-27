/**
 * DOM-level fatal screen — deliberately OUTSIDE React.
 *
 * Two iterations of React-side fixes (fatal state + window listeners in
 * v0.1.21, WasmErrorBoundary in v0.1.22) still ended in a white page in prod:
 * a commit-phase throw in WasmTool's OWN effects unmounts the root, and no
 * boundary below it can help. This module owns the last line of defense:
 * plain DOM, inline styles, its own copy of the log lines — nothing React
 * can take down.
 *
 * Cooperation contract: while React's own fatal overlay
 * ([data-testid="fatal-overlay"]) is in the document, this module stays
 * invisible. Once a fatal has been signaled, a 1 Hz ensure-loop watches: the
 * moment the React overlay is gone (root unmounted, tree died later), the
 * DOM screen is built. Whichever layer survives, the user never sees white.
 */

import { compositeCanvases } from "@/lib/diagnostics/canvas-composite";
import { dump } from "./load-trace";

const MAX_RING = 400;
const ring: string[] = [];

/** WasmTool's `append` mirrors every log line here (React-free copy). */
export function recordFatalLog(line: string): void {
  ring.push(line);
  if (ring.length > MAX_RING) ring.shift();
}

/** A copy of the log lines (problem reports read the editor log from here). */
export function fatalLogLines(): string[] {
  return [...ring];
}

let messages: string[] = [];
let ensureTimer: number | undefined;

function buildDom(): void {
  const doc = document;
  if (doc.getElementById("pcbjam-fatal-screen")) return;

  const root = doc.createElement("div");
  root.id = "pcbjam-fatal-screen";
  root.setAttribute("data-testid", "fatal-screen-dom");
  // Same blue as the boot overlay / React fatal screen (#1a1a2e) — one
  // coherent family across every full-screen state.
  root.style.cssText =
    "position:fixed;inset:0;z-index:2147483000;background:#1a1a2e;color:#fff;" +
    "display:flex;flex-direction:column;font-family:ui-monospace,Menlo,monospace;";

  // The message, buttons and report form above the console, never under it:
  // an open console used to cover the buttons in a short window. Scrolls when
  // the form makes it taller than the room left (`safe center` keeps the top
  // reachable).
  const main = doc.createElement("div");
  main.style.cssText =
    "flex:1 1 auto;min-height:0;overflow-y:auto;display:flex;flex-direction:column;align-items:center;" +
    "justify-content:safe center;gap:12px;padding:24px;box-sizing:border-box;";

  const face = doc.createElement("div");
  face.textContent = ":(";
  face.style.cssText = "font-size:44px;opacity:.9;";

  const title = doc.createElement("div");
  title.textContent = "The editor hit an unrecoverable error and stopped.";
  title.style.cssText = "font-size:14px;";

  const err = doc.createElement("div");
  err.setAttribute("data-fatal-extra", "");
  err.textContent = messages.join("\n");
  err.style.cssText =
    "font-size:12px;color:#dbeafe;max-width:640px;text-align:center;white-space:pre-wrap;";

  const hint = doc.createElement("div");
  hint.textContent =
    'The console below records what was loading when this happened. "Report this problem" sends it to us with a screenshot.';
  hint.style.cssText = "font-size:11px;color:#bfdbfe99;max-width:520px;text-align:center;";

  const buttonStyle =
    "border:1px solid #ffffff66;background:transparent;color:#fff;border-radius:4px;" +
    "padding:4px 14px;font-size:12px;cursor:pointer;font-family:inherit;";
  const reload = doc.createElement("button");
  reload.textContent = "Reload";
  reload.style.cssText = buttonStyle;
  reload.onclick = () => window.location.reload();

  const report = doc.createElement("button");
  report.textContent = "Report this problem";
  report.setAttribute("data-testid", "fatal-screen-report");
  report.style.cssText = buttonStyle;

  const actions = doc.createElement("div");
  actions.style.cssText = "display:flex;gap:8px;";
  actions.append(reload, report);

  // The form goes here. It is loaded on click: the floor must not depend on
  // anything that could have broken along with React.
  const reportHost = doc.createElement("div");
  reportHost.style.cssText = "width:100%;display:flex;justify-content:center;";

  // Console block mirroring the in-editor one: toggle bar + copy, collapsible.
  const consoleWrap = doc.createElement("div");
  consoleWrap.style.cssText = "flex:none;text-align:left;";

  const bar = doc.createElement("div");
  bar.style.cssText =
    "display:flex;align-items:center;background:#000000b3;font-size:11px;";

  const logText = () => [...ring, "", dump()].join("\n");

  const toggle = doc.createElement("button");
  toggle.textContent = "▾ console";
  toggle.style.cssText =
    "border:0;background:transparent;color:#fff;padding:4px 12px;cursor:pointer;font:inherit;";

  const copy = doc.createElement("button");
  copy.textContent = "copy";
  copy.style.cssText =
    "border:0;background:transparent;color:#ffffffb3;padding:4px 12px;cursor:pointer;" +
    "font:inherit;margin-left:auto;";
  copy.onclick = () => {
    navigator.clipboard.writeText(logText()).then(
      () => { copy.textContent = "copied ✓"; },
      () => { copy.textContent = "copy failed"; },
    );
  };

  const log = doc.createElement("pre");
  log.style.cssText =
    "max-height:38vh;overflow:auto;margin:0;padding:10px 12px;background:#000000d9;" +
    "color:#86efac;font-size:11px;line-height:1.35;";
  log.textContent = logText();

  toggle.onclick = () => {
    const hidden = log.style.display === "none";
    log.style.display = hidden ? "" : "none";
    toggle.textContent = hidden ? "▾ console" : "▸ console";
  };

  report.onclick = () => {
    report.disabled = true;
    report.textContent = "Opening...";
    // The form needs the room the open console takes.
    log.style.display = "none";
    toggle.textContent = "▸ console";
    const reset = () => {
      report.disabled = false;
      report.textContent = "Report this problem";
      report.style.display = "";
    };
    import("@/lib/diagnostics/floor-report")
      .then((m) => m.openFloorReport(reportHost, root, reset))
      .then(() => {
        report.style.display = "none";
      })
      .catch(() => {
        report.textContent = "Could not open the report form - copy the console instead";
      });
  };

  bar.append(toggle, copy);
  consoleWrap.append(bar, log);
  main.append(face, title, err, hint, actions, reportHost);
  root.append(main, consoleWrap);
  doc.body.appendChild(root);
}

function ensure(): void {
  try {
    // React's fatal overlay present ⇒ the tree survived and is reporting;
    // stay out of the way. The loop keeps watching: if that overlay
    // disappears (a later unmount), the floor goes up.
    if (document.querySelector('[data-testid="fatal-overlay"]')) {
      const dom = document.getElementById("pcbjam-fatal-screen");
      if (dom) dom.remove();
      return;
    }
    buildDom();
  } catch {
    /* the floor must never throw into anyone */
  }
}

/**
 * How long React gets to commit its own overlay before the first check.
 * Callers signal in the same tick as `setFatal()` (and the window listener
 * below even earlier), so checking at once always found no React overlay and
 * put the floor up over it until the next 1 Hz tick, hiding the overlay's
 * "Report this problem" button for up to a second.
 */
const REACT_GRACE_MS = 300;

let frame: HTMLCanvasElement | null = null;

/**
 * The editor's canvases as they were when the first fatal was signaled. By
 * the time someone reports from the floor, React may have taken the editor's
 * DOM with it, and a fresh screenshot would be blank.
 */
export function crashFrame(): HTMLCanvasElement | null {
  return frame;
}

/** Signal a fatal. Idempotent; new distinct messages are appended. */
export function showFatalScreen(message: string): void {
  if (!messages.includes(message)) messages.push(message);
  if (ensureTimer === undefined) {
    try {
      frame = compositeCanvases();
    } catch {
      /* the floor must never throw into anyone */
    }
    window.setTimeout(ensure, REACT_GRACE_MS);
    ensureTimer = window.setInterval(ensure, 1000);
  } else {
    const err = document.querySelector("#pcbjam-fatal-screen [data-fatal-extra]");
    if (err) err.textContent = messages.join("\n");
  }
}

const TERMINAL =
  /RuntimeError|\babort(ed)?\b|\bindex out of bounds|indirect call signature|memory access out of bounds|unreachable executed|null function or function signature/i;

/**
 * Global last-resort listeners, installed once at module import time — i.e.
 * before and independent of any React lifecycle.
 */
export function installFatalScreenListeners(): void {
  const w = window as Window & { __pcbjamFatalListeners?: boolean };
  if (w.__pcbjamFatalListeners) return;
  w.__pcbjamFatalListeners = true;
  window.addEventListener("error", (e) => {
    const msg = e.error instanceof Error ? e.error.message : String(e.message ?? "");
    if (TERMINAL.test(msg)) showFatalScreen(msg);
  });
  window.addEventListener("unhandledrejection", (e) => {
    const msg = e.reason instanceof Error ? e.reason.message : String(e.reason ?? "");
    if (TERMINAL.test(msg)) showFatalScreen(msg);
  });
}
