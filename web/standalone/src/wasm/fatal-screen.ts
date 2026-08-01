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

import { dump } from "./load-trace";

const MAX_RING = 400;
const ring: string[] = [];

/** WasmTool's `append` mirrors every log line here (React-free copy). */
export function recordFatalLog(line: string): void {
  ring.push(line);
  if (ring.length > MAX_RING) ring.shift();
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
    "display:flex;flex-direction:column;align-items:center;justify-content:center;" +
    "gap:12px;font-family:ui-monospace,Menlo,monospace;padding:24px;box-sizing:border-box;";

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
    "The console below records what was loading when this happened — please copy it into a bug report.";
  hint.style.cssText = "font-size:11px;color:#bfdbfe99;max-width:520px;text-align:center;";

  const reload = doc.createElement("button");
  reload.textContent = "Reload";
  reload.style.cssText =
    "border:1px solid #ffffff66;background:transparent;color:#fff;border-radius:4px;" +
    "padding:4px 14px;font-size:12px;cursor:pointer;font-family:inherit;";
  reload.onclick = () => window.location.reload();

  // Console block mirroring the in-editor one: toggle bar + copy, collapsible.
  const consoleWrap = doc.createElement("div");
  consoleWrap.style.cssText = "position:absolute;bottom:0;left:0;right:0;text-align:left;";

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

  bar.append(toggle, copy);
  consoleWrap.append(bar, log);
  root.append(face, title, err, hint, reload, consoleWrap);
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

/** Signal a fatal. Idempotent; new distinct messages are appended. */
export function showFatalScreen(message: string): void {
  if (!messages.includes(message)) messages.push(message);
  if (ensureTimer === undefined) {
    ensure();
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
