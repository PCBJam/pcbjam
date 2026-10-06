/**
 * Cross-tab cross-probing (cross-probe 0001, private docs): KiCad's "select in
 * one editor → show it in the other" between the user's own schematic and PCB
 * tabs.
 *
 * KiCad sends its cross-probe text ("$SELECT: …", "$NET: …", "$CLEAR") through
 * SendCommand, which the wasm layer forwards to `window.kicadCrossProbeSend`.
 * This module carries it over a BroadcastChannel scoped to one user, project
 * and working copy, and the receiving tab runs it with `kicadCrossProbeExec`
 * (KiCad's own ExecuteRemoteCommand). No server, no Yjs.
 *
 * Rules (browser-tested 2026-10-06):
 *  - Only an explicit action (switch button, Select on PCB/Schematic) opens a
 *    tab; a plain selection reaches tabs that are already open, or nothing.
 *  - A tab can only focus a tab it opened itself (the window.open handle).
 *    Any other peer gets the probe in the background plus a toast.
 *  - The sender keeps the latest explicit probe until the target tab reports
 *    `ready` (its file open settled), then sends it once.
 */
import type { Tool } from "@pcbjam/shared";

export type ProbeTool = "pcbnew" | "eeschema";

export function isProbeTool(tool: Tool | string): tool is ProbeTool {
  return tool === "pcbnew" || tool === "eeschema";
}

type TabState = "loading" | "ready";

export type CrossProbeMessage = { v: 1; tabId: string; tool: ProbeTool } & (
  | { type: "hello" }
  | { type: "here"; state: TabState }
  | { type: "ready" }
  | { type: "bye" }
  | { type: "probe"; to: ProbeTool; cmd: string; explicit: boolean }
);

/** The BroadcastChannel surface we use (injectable for tests). */
export interface ChannelLike {
  postMessage(message: unknown): void;
  onmessage: ((event: MessageEvent) => void) | null;
  close(): void;
}

export interface CrossProbeNotice {
  text: string;
  action?: { label: string; run: () => void };
}

/** Window event the editor's notice stack shows as a toast. */
export const CROSS_PROBE_NOTICE_EVENT = "pcbjam:cross-probe-notice";

export interface CrossProbeOptions {
  tool: ProbeTool;
  channel: ChannelLike;
  /** Editor URL for `tool` in this project, or null when it has no such file. */
  urlFor: (tool: ProbeTool) => string | null;
  /** window.open(url, "_blank"); null when the browser blocked it. */
  openWindow: (url: string) => Window | null;
  /** Run a received command in this tab's editor; false = not applied.
   *  `force`: KiCad's explicit "Select on …" (applies even with sync off). */
  exec: (cmd: string, force: boolean) => boolean;
  notify: (notice: CrossProbeNotice) => void;
  log: (message: string) => void;
  tabId?: string;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  /** How long a known peer gets to answer `hello` before it counts as gone. */
  verifyMs?: number;
  /** How long an explicit probe waits for its target tab to become ready. */
  pendingTtlMs?: number;
}

export interface CrossProbe {
  /** C++ SendCommand → here. */
  send(to: ProbeTool, cmd: string, explicit: boolean): boolean;
  /** Switch button (or a created counterpart file): bring up the other editor.
   *  False when `to` is this tab's own editor (nothing to do here). */
  openOrFocus(to: ProbeTool, url?: string): boolean;
  /** This tab's file open settled: accept probes, release waiting senders. */
  markReady(): void;
  /** Counters for the e2e specs (window.kicadCrossProbeStats). */
  stats(): { opened: number; focused: number; notices: number; executed: number };
  /** pagehide: tell peers we are gone (the page may still come back). */
  leave(): void;
  /** pageshow from the back/forward cache: announce ourselves again. */
  announce(): void;
  dispose(): void;
}

export const EDITOR_LABEL: Record<ProbeTool, string> = {
  pcbnew: "PCB editor",
  eeschema: "Schematic editor",
};

export function crossProbeChannelName(parts: {
  user: string | null;
  scope: string;
  slug: string;
  copy: string | null;
}): string {
  return ["pcbjam-xprobe", parts.user ?? "anon", parts.scope, parts.slug, parts.copy ?? ""].join(
    ":",
  );
}

export function createCrossProbe(opts: CrossProbeOptions): CrossProbe {
  const tabId = opts.tabId ?? crypto.randomUUID();
  const now = opts.now ?? Date.now;
  const setTimer = opts.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const verifyMs = opts.verifyMs ?? 300;
  const pendingTtlMs = opts.pendingTtlMs ?? 120_000;

  let state: TabState = "loading";
  let disposed = false;
  const peers = new Map<string, { tool: ProbeTool; state: TabState }>();
  // Tabs that spoke since the last liveness `hello` (null: no check running).
  let answered: Set<string> | null = null;
  const opened = new Map<ProbeTool, Window>();
  let pending: { to: ProbeTool; cmd: string; at: number } | null = null;
  const counts = { opened: 0, focused: 0, notices: 0, executed: 0 };
  const notify = (notice: CrossProbeNotice) => {
    counts.notices += 1;
    opts.notify(notice);
  };

  const post = (body: Record<string, unknown>) => {
    if (disposed) return;
    opts.channel.postMessage({ v: 1, tabId, tool: opts.tool, ...body });
  };

  const liveHandle = (to: ProbeTool): Window | undefined => {
    const handle = opened.get(to);
    if (handle && handle.closed) opened.delete(to);
    return handle && !handle.closed ? handle : undefined;
  };

  const peersOf = (to: ProbeTool) =>
    [...peers.entries()].filter(([, peer]) => peer.tool === to);

  const sendPending = () => {
    if (!pending) return;
    if (now() - pending.at > pendingTtlMs) {
      opts.log(`[cross-probe] dropped stale pending probe to ${pending.to}`);
      pending = null;
      return;
    }
    post({ type: "probe", to: pending.to, cmd: pending.cmd, explicit: true });
    opts.log(`[cross-probe] replayed pending probe to ${pending.to}`);
    pending = null;
  };

  const openNew = (to: ProbeTool, url: string | null) => {
    if (!url) {
      opts.log(`[cross-probe] no ${to} file in this project — nothing to open`);
      pending = null;
      return;
    }
    const handle = opts.openWindow(url);
    if (handle) {
      opened.set(to, handle);
      counts.opened += 1;
      opts.log(`[cross-probe] opened ${to} tab ${url}`);
      return;
    }
    // Popup blocked (the click's user activation was gone by now): a toast
    // button is a fresh gesture.
    notify({
      text: `Your browser blocked opening the ${EDITOR_LABEL[to]}.`,
      action: {
        label: `Open ${EDITOR_LABEL[to]}`,
        run: () => {
          const retry = opts.openWindow(url);
          if (retry) opened.set(to, retry);
        },
      },
    });
  };

  const bringUp = (to: ProbeTool, cmd: string | null, url: string | null) => {
    const handle = liveHandle(to);
    const known = peersOf(to);

    if (cmd && (known.length === 0 || known.every(([, peer]) => peer.state === "loading"))) {
      // Not ready (or not there) yet: the first `ready` from a `to` tab gets it.
      pending = { to, cmd, at: now() };
    }

    if (handle) {
      handle.focus();
      counts.focused += 1;
      return;
    }

    if (known.length === 0) {
      openNew(to, url);
      return;
    }

    // Known peers we can't focus: make sure they still exist (a crashed tab
    // never sent `bye`) before telling the user to switch tabs.
    answered = new Set();
    post({ type: "hello" });
    setTimer(() => {
      if (disposed) return;
      const spoke = answered ?? new Set<string>();
      answered = null;
      const alive = peersOf(to).filter(([id]) => spoke.has(id));
      for (const [id] of peersOf(to)) {
        if (!spoke.has(id)) peers.delete(id);
      }
      if (alive.length > 0) {
        notify({ text: `The ${EDITOR_LABEL[to]} is open in another tab.` });
      } else {
        openNew(to, url);
      }
    }, verifyMs);
  };

  opts.channel.onmessage = (event: MessageEvent) => {
    const msg = event.data as CrossProbeMessage | undefined;
    if (!msg || msg.v !== 1 || msg.tabId === tabId || !isProbeTool(msg.tool)) return;
    answered?.add(msg.tabId);

    switch (msg.type) {
      case "hello":
        if (!peers.has(msg.tabId)) peers.set(msg.tabId, { tool: msg.tool, state: "loading" });
        post({ type: "here", state });
        break;
      case "here":
        peers.set(msg.tabId, { tool: msg.tool, state: msg.state });
        break;
      case "ready":
        peers.set(msg.tabId, { tool: msg.tool, state: "ready" });
        if (pending && pending.to === msg.tool) sendPending();
        break;
      case "bye":
        peers.delete(msg.tabId);
        break;
      case "probe":
        if (msg.to !== opts.tool) break;
        if (state !== "ready") {
          opts.log("[cross-probe] probe ignored: file still opening");
          break;
        }
        if (opts.exec(msg.cmd, msg.explicit === true)) counts.executed += 1;
        else opts.log("[cross-probe] probe not applied");
        break;
    }
  };

  // Boot: say we exist (loading) and learn who else is here.
  post({ type: "here", state });
  post({ type: "hello" });

  return {
    send(to, cmd, explicit) {
      if (disposed || to === opts.tool) return false;
      post({ type: "probe", to, cmd, explicit });
      if (explicit) bringUp(to, cmd, opts.urlFor(to));
      return true;
    },
    openOrFocus(to, url) {
      if (disposed || to === opts.tool) return false;
      bringUp(to, null, url ?? opts.urlFor(to));
      return true;
    },
    markReady() {
      if (state === "ready") return;
      state = "ready";
      post({ type: "ready" });
    },
    stats() {
      return { ...counts };
    },
    leave() {
      post({ type: "bye" });
    },
    announce() {
      post({ type: "here", state });
    },
    dispose() {
      if (disposed) return;
      post({ type: "bye" });
      disposed = true;
      opts.channel.onmessage = null;
      opts.channel.close();
    },
  };
}

// ── Page wiring ─────────────────────────────────────────────────────────────

let active: CrossProbe | null = null;

/** The running editor's cross-probe, for the switch-button hook. */
export function activeCrossProbe(): CrossProbe | null {
  return active;
}

/**
 * Install for a schematic/PCB editor tab: the C++ send hook, the notice
 * event, and bye/here on page hide/show. Returns the instance (also exposed
 * through activeCrossProbe) and an uninstall.
 */
export function installCrossProbe(
  win: ToolWindow,
  opts: {
    tool: ProbeTool;
    channelName: string;
    urlFor: (tool: ProbeTool) => string | null;
    exec: (cmd: string, force: boolean) => boolean;
    log: (message: string) => void;
  },
): { crossProbe: CrossProbe; uninstall: () => void } | null {
  if (typeof win.BroadcastChannel !== "function") return null;

  const crossProbe = createCrossProbe({
    tool: opts.tool,
    channel: new win.BroadcastChannel(opts.channelName),
    urlFor: opts.urlFor,
    openWindow: (url) => win.open(url, "_blank"),
    exec: opts.exec,
    notify: (notice) =>
      win.dispatchEvent(new CustomEvent(CROSS_PROBE_NOTICE_EVENT, { detail: notice })),
    log: opts.log,
  });

  const onPageHide = () => crossProbe.leave();
  const onPageShow = (event: PageTransitionEvent) => {
    if (event.persisted) crossProbe.announce();
  };
  win.kicadCrossProbeSend = (to, cmd, explicit) =>
    isProbeTool(to) ? crossProbe.send(to, cmd, explicit) : false;
  win.kicadCrossProbeStats = () => crossProbe.stats();
  win.addEventListener("pagehide", onPageHide);
  win.addEventListener("pageshow", onPageShow);
  active = crossProbe;

  return {
    crossProbe,
    uninstall: () => {
      win.removeEventListener("pagehide", onPageHide);
      win.removeEventListener("pageshow", onPageShow);
      if (active === crossProbe) active = null;
      delete win.kicadCrossProbeSend;
      delete win.kicadCrossProbeStats;
      crossProbe.dispose();
    },
  };
}
