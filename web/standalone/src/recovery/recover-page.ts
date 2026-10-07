/**
 * The /recover airlock page — standalone-hardening 0009 (see airlock.ts).
 *
 * 1. Census: other editor tabs on this origin keep Firefox's shared isolated
 *    process alive, so list them and wait until they are closed (or the user
 *    continues anyway).
 * 2. Wait long enough for that process to exit (10 s in Firefox).
 * 3. `location.replace` back to the editor, which boots in a fresh process.
 *
 * Plain DOM, no React: this page must hold as little memory as possible.
 */
import {
  AIRLOCK_WAIT_FIREFOX_MS,
  AIRLOCK_WAIT_OTHER_MS,
  safeReturnPath,
} from "./airlock";
import { isFirefox, takeCensus, type EditorTabInfo } from "./tab-census";

const RECHECK_MS = 2_000;

const root = document.getElementById("airlock")!;
const target = safeReturnPath(new URLSearchParams(location.search).get("to"), location.origin);
const firefox = isFirefox();
const waitMs = firefox ? AIRLOCK_WAIT_FIREFOX_MS : AIRLOCK_WAIT_OTHER_MS;

let left = false;
function goBack(): void {
  if (left) return;
  left = true;
  location.replace(target);
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Partial<HTMLElementTagNameMap[K]> & { dataset?: Record<string, string> } = {},
  ...children: (Node | string)[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  const { dataset, ...rest } = props;
  Object.assign(node, rest);
  if (dataset) Object.assign(node.dataset, dataset);
  node.append(...children);
  return node;
}

function render(...children: Node[]): void {
  root.replaceChildren(el("h1", {}, "Restarting the editor"), ...children);
}

function showOtherTabs(tabs: EditorTabInfo[]): void {
  render(
    el(
      "p",
      {},
      firefox
        ? "Firefox runs all open PCBJam editors in one shared process, and that process ran out of memory. Close these editor tabs so it can be freed:"
        : "These PCBJam editor tabs are still open. Close the ones you don't need to free memory:",
    ),
    el(
      "ul",
      { dataset: { testid: "airlock-tabs" } },
      ...tabs.map((t) => el("li", {}, t.title || t.url)),
    ),
    el("p", {}, "This page continues on its own once they are closed."),
    el(
      "div",
      { className: "actions" },
      el("button", { type: "button", onclick: goBack }, "Continue anyway"),
    ),
  );
}

function countdown(): void {
  const deadline = Date.now() + waitMs;
  const seconds = el("span", { className: "count" });
  render(
    el(
      "p",
      {},
      "Freeing memory before the editor starts again. Continuing in ",
      seconds,
      ".",
    ),
    el(
      "div",
      { className: "actions" },
      el("button", { type: "button", className: "primary", onclick: goBack, dataset: { testid: "airlock-continue" } }, "Continue now"),
    ),
  );
  const tick = () => {
    if (left) return;
    const ms = deadline - Date.now();
    if (ms <= 0) return goBack();
    const s = Math.ceil(ms / 1000);
    seconds.textContent = `${s} second${s === 1 ? "" : "s"}`;
    setTimeout(tick, Math.min(250, ms));
  };
  tick();
}

async function waitForOtherTabs(): Promise<void> {
  for (;;) {
    const tabs = await takeCensus();
    if (left) return;
    if (tabs.length === 0) return countdown();
    showOtherTabs(tabs);
    await new Promise((r) => setTimeout(r, RECHECK_MS));
  }
}

void waitForOtherTabs();
