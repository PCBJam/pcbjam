/**
 * Editor tab census — standalone-hardening 0009.
 *
 * Firefox runs every cross-origin-isolated page of a site in ONE content
 * process (`webCOOP+COEP=https://pcbjam.com`), so all open editor tabs share one
 * memory budget and keep that process alive. The census lets a tab (or the
 * /recover airlock page) ask which other editor tabs are open, to tell the user
 * which ones to close.
 *
 * Protocol on `BroadcastChannel("pcbjam:editor-tabs")`: a `ping` carries a
 * nonce; every joined editor tab answers with a `pong` carrying its info. The
 * channel is per origin, so tabs on other pcbjam.com hosts (demo, www) are not
 * seen even though Firefox puts them in the same process.
 *
 * Platform access goes through an injectable channel factory for tests.
 */

export const CENSUS_CHANNEL = "pcbjam:editor-tabs";
/** How long a census waits for answers. Same-browser BroadcastChannel replies
 *  arrive within a few ms; a busy tab (wasm on the main thread) may lag. */
export const CENSUS_TIMEOUT_MS = 600;

export interface EditorTabInfo {
  tabId: string;
  /** "pcbnew" | "eeschema" | … */
  tool: string;
  /** document.title at answer time ("demo — PCB Editor"). */
  title: string;
  /** location.href at answer time. */
  url: string;
}

type CensusMessage =
  | { type: "ping"; nonce: string; from: string }
  | { type: "pong"; nonce: string; info: EditorTabInfo };

export interface CensusChannel {
  postMessage(msg: unknown): void;
  addEventListener(type: "message", fn: (e: MessageEvent) => void): void;
  removeEventListener(type: "message", fn: (e: MessageEvent) => void): void;
  close(): void;
}

export type ChannelFactory = (name: string) => CensusChannel | null;

const defaultFactory: ChannelFactory = (name) => {
  try {
    return typeof BroadcastChannel === "undefined" ? null : new BroadcastChannel(name);
  } catch {
    return null;
  }
};

export function newTabId(): string {
  try {
    if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID();
  } catch {
    /* fall through */
  }
  return `${Date.now().toString(36)}-${Math.floor(Math.random() * 1e9).toString(36)}`;
}

/**
 * Join the census as an editor tab: answer every ping with `info()`. Returns
 * the leave function. A no-op when BroadcastChannel is unavailable.
 */
export function joinCensus(
  info: () => Omit<EditorTabInfo, "tabId">,
  opts: { tabId?: string; channelFactory?: ChannelFactory } = {},
): () => void {
  const tabId = opts.tabId ?? newTabId();
  const ch = (opts.channelFactory ?? defaultFactory)(CENSUS_CHANNEL);
  if (!ch) return () => {};
  const onMessage = (e: MessageEvent) => {
    const msg = e.data as CensusMessage | undefined;
    if (msg?.type !== "ping" || msg.from === tabId) return;
    const reply: CensusMessage = { type: "pong", nonce: msg.nonce, info: { ...info(), tabId } };
    ch.postMessage(reply);
  };
  ch.addEventListener("message", onMessage);
  return () => {
    ch.removeEventListener("message", onMessage);
    ch.close();
  };
}

/**
 * Ask which editor tabs are open. `selfId` (an editor tab's own census id) is
 * excluded; the airlock page passes none. Resolves after `timeoutMs` with the
 * answers, de-duplicated by tabId. Resolves `[]` without BroadcastChannel.
 */
export function takeCensus(
  opts: { selfId?: string; timeoutMs?: number; channelFactory?: ChannelFactory } = {},
): Promise<EditorTabInfo[]> {
  const ch = (opts.channelFactory ?? defaultFactory)(CENSUS_CHANNEL);
  if (!ch) return Promise.resolve([]);
  const nonce = newTabId();
  const from = opts.selfId ?? `census-${nonce}`;
  const seen = new Map<string, EditorTabInfo>();
  const onMessage = (e: MessageEvent) => {
    const msg = e.data as CensusMessage | undefined;
    if (msg?.type !== "pong" || msg.nonce !== nonce) return;
    if (msg.info.tabId === opts.selfId) return;
    seen.set(msg.info.tabId, msg.info);
  };
  ch.addEventListener("message", onMessage);
  const ping: CensusMessage = { type: "ping", nonce, from };
  ch.postMessage(ping);
  return new Promise((resolve) => {
    setTimeout(() => {
      ch.removeEventListener("message", onMessage);
      ch.close();
      resolve([...seen.values()]);
    }, opts.timeoutMs ?? CENSUS_TIMEOUT_MS);
  });
}

/** Firefox puts all isolated pages of a site in one process; Chromium does not
 *  share them the same way, so the shared-budget notice is Firefox-only. */
export function isFirefox(ua: string = typeof navigator !== "undefined" ? navigator.userAgent : ""): boolean {
  return /Firefox\//.test(ua);
}
