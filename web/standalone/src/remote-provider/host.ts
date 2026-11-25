// Remote-provider RPC host, DOM half. Owns the activation, the cross-origin
// iframe, the postMessage channel and the asset proxy calls; everything
// protocol-shaped is delegated to protocol.ts, everything library-shaped to
// the injected savePart (libs/save-part.ts in the app, a recorder in tests).
import { PROVIDER_LIMITS } from "@pcbjam/plugin-platform/remote-provider-contract.mjs";
import type { PartPack, SavePartOptions, SavePartResult } from "@/libs/save-part";
import { createProviderSession, manifestToPack, type HostActivity, type PartEffect, type ProviderSession } from "./protocol";
import { LOGIN_CHANNEL_PREFIX, authorizationUrl, judgeCallback, makePkcePair, randomToken, type PkcePair, type SignInConfig } from "./login";

export interface ProviderActivation {
  id: string;
  grants: string[];
  provider: {
    origin: string;
    panelUrl: string;
    panelOrigin: string;
    originSet: string[];
    providerName: string;
    providerVersion: string;
    maxDownloadBytes: number;
    supportedAssetTypes: string[];
    capabilities: { webUi: boolean; parts: boolean; directDownloads: boolean; inlinePayloads: boolean };
    /** Present when the provider signs its users in (plugins 0028): what the sign-in popup needs. */
    auth?: SignInConfig;
  };
}
export type HostStatus =
  | { state: "activating" }
  | { state: "loading"; provider: ProviderActivation["provider"] }
  | { state: "connecting"; provider: ProviderActivation["provider"]; attempt: number }
  | { state: "ready"; provider: ProviderActivation["provider"] }
  | { state: "busy"; provider: ProviderActivation["provider"]; message: string }
  /**
   * A sign-in is running. "popup": its window is open; "blocked": the browser did not open it,
   * PCBJam's chrome shows a button that calls `signIn()` from a real click; "exchanging": the
   * window came back and the server is finishing the sign-in.
   */
  | { state: "sign-in"; provider: ProviderActivation["provider"]; step: "popup" | "blocked" | "exchanging" }
  | { state: "failed"; message: string; provider?: ProviderActivation["provider"] };
export interface PartRequest {
  command: string;
  place: boolean;
  pack: PartPack;
  /** Assets the manifest listed that phase 1 does not keep (duplicate slots, 3D, SPICE). */
  skipped: string[];
  totalBytes: number;
}
export type SavePart = (
  pack: PartPack,
  options: SavePartOptions & { onSaved?: (result: SavePartResult) => void }
) => Promise<SavePartResult>;
export interface RemoteProviderMountOptions {
  plugin: { pluginId?: string; digest: string; generation?: number; manifest: { id: string; name: string } };
  projectId: string;
  document: string;
  apiBase: string;
  runtimeVersion: string;
  clientVersion: string;
  signal: AbortSignal;
  savePart: SavePart;
  /** Trusted confirmation rendered by the host chrome, never by the provider page. */
  confirmPart(request: PartRequest, signal: AbortSignal): Promise<boolean>;
  onStatus(status: HostStatus): void;
  onLog?(line: string): void;
  /** How a sign-in ended, for PCBJam's chrome: one of a few fixed texts, "" clears it. */
  onNotice?(message: string): void;
  /** Injection points for tests. */
  fetchImpl?: typeof fetch;
  uuid?: () => string;
  heartbeatMs?: number;
  /** Opens the sign-in window; a falsy answer means the browser blocked it. */
  openPopup?(url: string): unknown;
  signInTimeoutMs?: number;
}
export interface RemoteProviderHandle {
  dispose(): void;
  /** Opens the sign-in window of the pending sign-in. Call it from a click in PCBJam's chrome. */
  signIn(): void;
  /** Ends a running sign-in; whatever arrives for it later is dropped. */
  cancelSignIn(): void;
}

export const HEARTBEAT_MS = 40000;
/** A sign-in window nobody came back from. */
export const SIGN_IN_TIMEOUT_MS = 5 * 60 * 1000;
/** The server gives itself 35 s for the exchange (plugins 0028 §6.8), so the browser normally hears the answer. */
export const SIGN_IN_EXCHANGE_MS = 45000;
/** Server answers that mean the activation is over for good (revoked, removed, unapproved, expired). */
const ENDED = new Set([401, 403, 404, 409]);
const SAVER_CODES = new Set(["NOT_SIGNED_IN", "NO_TEAM_WRITE", "INVALID_SYMBOL", "INVALID_FOOTPRINT", "TOO_LARGE", "PLACEMENT_UNAVAILABLE", "LIB_WRITE_FAILED"]);
const noop = () => {};

async function sha256(bytes: Uint8Array) {
  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function createPlatformClient(apiBase: string, fetchImpl: typeof fetch = fetch) {
  const base = apiBase + "/api/plugin-platform/v1/";
  const headers = { "Content-Type": "application/json", "X-PCBJam-Plugin-Platform": "1" };
  async function call(path: string, method: string, data?: unknown, signal?: AbortSignal, timeoutMs = 10000) {
    const deadline = AbortSignal.timeout(timeoutMs);
    return fetchImpl(base + path, {
      method, credentials: "include", redirect: "error", cache: "no-store", headers,
      signal: signal ? AbortSignal.any([signal, deadline]) : deadline,
      ...(data === undefined ? {} : { body: JSON.stringify(data) }),
    });
  }
  const failure = async (response: Response) => {
    let result: { error?: string; code?: string } = {};
    try { result = await response.json(); } catch { /* non-JSON error body */ }
    return Object.assign(new Error(result.error ?? "Plugin operation failed"), { status: response.status }, typeof result.code === "string" ? { code: result.code } : {});
  };
  return {
    async json<T>(path: string, method: string, data?: unknown, signal?: AbortSignal, timeoutMs?: number): Promise<T> {
      const response = await call(path, method, data, signal, timeoutMs);
      if (!response.ok) throw await failure(response);
      return response.json() as Promise<T>;
    },
    /** POST activations/:id/asset → verified bytes, re-checked here against the manifest entry. */
    async asset(activationId: string, entry: { url: string; contentType: string; sizeBytes: number; sha256: string }, signal?: AbortSignal) {
      const response = await call(`activations/${activationId}/asset`, "POST", entry, signal, PROVIDER_LIMITS.handshakeIntervalMs * 45);
      if (!response.ok) throw await failure(response);
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.length !== entry.sizeBytes || (await sha256(bytes)) !== entry.sha256) throw new Error("Remote asset did not match its manifest.");
      return bytes;
    },
  };
}

export function mountRemoteProvider(container: HTMLElement, options: RemoteProviderMountOptions): RemoteProviderHandle {
  const api = createPlatformClient(options.apiBase, options.fetchImpl);
  const log = options.onLog ?? noop;
  const notice = (message: string) => { if (!disposed && !ended) options.onNotice?.(message); };
  // A separate window, never a tab of the editor's browsing context group: the editor's COOP
  // gives it no opener either way. No "noopener": that makes window.open answer null always,
  // and null is how a blocked popup is seen.
  const openPopup = options.openPopup ?? ((url: string) => window.open(url, "_blank", "popup,width=520,height=720"));
  const abort = new AbortController();
  const signal = AbortSignal.any([abort.signal, options.signal]);
  let activation: ProviderActivation | undefined;
  let session: ProviderSession | undefined;
  let frame: HTMLIFrameElement | undefined;
  let handshakeTimer: ReturnType<typeof setInterval> | undefined;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  // One part request at a time: later ones are refused (protocol BUSY) rather
  // than queued behind a confirmation the user has not answered yet.
  let working = false;
  // Sign-in (plugins 0028 §6.6). One attempt per panel, numbered, so the late answer of an
  // ended attempt (its popup, or the server) is dropped. Without that a late address could
  // sign the panel in again after a sign-out.
  //  - `pair`: the next unused PKCE pair, made ahead so the popup opens without an await;
  //  - `pending`: a sign-in was started and its window has not come back;
  //  - `exchanging`: the attempt whose code the server is exchanging.
  let pair: PkcePair | undefined;
  let pending: { id: number; state: string; pair?: PkcePair; channel: BroadcastChannel; timer: ReturnType<typeof setTimeout>; opened: boolean } | undefined;
  let exchanging: number | undefined;
  let attempts = 0;
  // A sign-out that arrived while a part was being saved: the panel reloads when the save has settled.
  let reloadAfterSave = false;
  let disposed = false;
  // Access ended: the frame is gone and nothing the page sent earlier may still land.
  let ended = false;

  const status = (s: HostStatus) => { if (!disposed && !ended) options.onStatus(s); };
  const fail = (message: string) => {
    log("failed: " + message);
    status({ state: "failed", message, provider: activation?.provider });
    stopTimers();
  };
  const stopTimers = () => {
    if (handshakeTimer) clearInterval(handshakeTimer);
    if (heartbeat) clearInterval(heartbeat);
    handshakeTimer = heartbeat = undefined;
  };
  const teardown = () => {
    stopTimers();
    endSignIn();
    abort.abort();
    window.removeEventListener("message", onMessage);
    frame?.removeEventListener("load", onLoad);
    frame?.remove();
    frame = undefined;
  };
  /** The server said this activation is over: show why, then close the panel. */
  const end = (message: string) => {
    if (ended || disposed) return;
    fail(message);
    ended = true;
    teardown();
  };
  const denied = (error: unknown) => ENDED.has((error as { status?: number }).status ?? 0);
  const post = (envelope: object) => {
    if (!frame?.contentWindow || !activation) return;
    frame.contentWindow.postMessage(JSON.stringify(envelope), activation.provider.panelOrigin);
  };

  const activity = (): HostActivity => (working ? "saving" : pending ? "pending" : exchanging !== undefined ? "exchanging" : "idle");
  /** Back to what the panel showed before a sign-in. */
  const settle = () => { if (activation && session?.handshake === "ready") status({ state: "ready", provider: activation.provider }); };
  /** Ends the running attempt, if any: its channel closes and whatever arrives later is dropped. */
  function endSignIn() {
    if (pending) { clearTimeout(pending.timer); pending.channel.close(); pending = undefined; }
    exchanging = undefined;
  }
  const failSignIn = (message: string) => {
    endSignIn();
    log("sign-in: " + message);
    notice(message);
    settle();
  };
  /** Makes the next PKCE pair; an attempt that started without one gets it. */
  const preparePair = () => {
    void makePkcePair().then((made) => {
      if (disposed || ended) return;
      if (pending && !pending.pair) { pending.pair = made; preparePair(); }
      else pair = made;
    }, noop);
  };
  /**
   * Opens the sign-in window of the pending attempt. Runs in the task of the page's message or
   * of a click in PCBJam's chrome, with no await before window.open: the browser lets a popup
   * through only while that click is fresh.
   */
  const openSignIn = () => {
    const auth = activation?.provider.auth;
    if (!auth || !pending?.pair) return false;
    let opened: unknown = null;
    try { opened = openPopup(authorizationUrl(auth, pending.state, pending.pair.challenge)); } catch { /* treated as blocked */ }
    if (!opened) return false;
    pending.opened = true;
    return true;
  };
  const startSignIn = () => {
    if (!activation?.provider.auth) return;
    const provider = activation.provider, auth = activation.provider.auth;
    // A new request replaces a pending attempt: the user may have closed its window, which the editor cannot see.
    endSignIn();
    notice("");
    // The sign-in server sends the window back to the editor address the server is set up for.
    // On another address (a preview) the answer would never reach this page.
    if (new URL(auth.redirectUri).origin !== location.origin) { failSignIn("Sign-in is not available on this address of PCBJam."); return; }
    const id = ++attempts;
    const state = randomToken();
    // The channel is open before the window is.
    const channel = new BroadcastChannel(LOGIN_CHANNEL_PREFIX + state);
    channel.onmessage = (event) => onCallback(id, event.data);
    const timer = setTimeout(() => { if (pending?.id === id) failSignIn("Sign-in did not finish. Try again."); }, options.signInTimeoutMs ?? SIGN_IN_TIMEOUT_MS);
    // A pair is used for one attempt only; the next one is made right away.
    pending = { id, state, pair, channel, timer, opened: false };
    if (pair) { pair = undefined; preparePair(); }
    log("sign-in: started");
    status({ state: "sign-in", provider, step: openSignIn() ? "popup" : "blocked" });
  };
  /** The callback page's message (plugins 0028 §6.6 "Accepting a callback"). One per attempt. */
  const onCallback = (id: number, data: unknown) => {
    const auth = activation?.provider.auth;
    if (!auth || !pending || pending.id !== id || !pending.opened || !pending.pair) return;
    const verdict = judgeCallback(data, { state: pending.state, issuer: auth.issuer });
    if (verdict.kind === "ignore") return;
    const verifier = pending.pair.verifier;
    endSignIn();
    if (verdict.kind !== "code") { failSignIn(verdict.kind === "error" ? verdict.text : "Sign-in failed"); return; }
    exchanging = id;
    status({ state: "sign-in", provider: activation!.provider, step: "exchanging" });
    void exchange(id, verdict.code, verifier);
  };
  /** The server trades the code for the provider's one-time panel address; the panel loads it. */
  async function exchange(id: number, code: string, codeVerifier: string) {
    const provider = activation!.provider;
    try {
      const answer = await api.json<{ nonceUrl?: unknown }>(`activations/${activation!.id}/login`, "POST", { code, codeVerifier }, signal, SIGN_IN_EXCHANGE_MS);
      // Ended meanwhile (sign-out, cancel, a reload of the panel): the answer is dropped.
      if (exchanging !== id) return;
      exchanging = undefined;
      let onPanelOrigin = false;
      try { onPanelOrigin = typeof answer.nonceUrl === "string" && new URL(answer.nonceUrl).origin === provider.panelOrigin; } catch { /* not a URL */ }
      if (!onPanelOrigin || !frame) { failSignIn("Sign-in failed"); return; }
      // The address carries a one-time secret: it is never logged.
      log("sign-in: signed in");
      notice("");
      status({ state: "loading", provider });
      // onLoad starts a new NEW_SESSION handshake with the signed-in page.
      frame.src = answer.nonceUrl as string;
    } catch (error) {
      if (exchanging !== id) return;
      exchanging = undefined;
      const e = error as Error & { status?: number; code?: string };
      // A LOGIN_ code carries one of the server's fixed texts and is about this sign-in only;
      // every other refusal is about the activation, as for any call.
      if (typeof e.code === "string" && e.code.startsWith("LOGIN_") && e.code !== "LOGIN_UNSUPPORTED") failSignIn(e.message);
      else if (denied(e)) end("Provider access ended: " + e.message + ". Reopen the panel to continue.");
      else if (e.status === 429) failSignIn("Too many sign-in attempts. Try again in a minute.");
      else if (e.status === 400) failSignIn("Sign-in failed");
      // No answer (the network lost it, or the deadline passed): PCBJam cannot know whether the sign-in went through.
      else if (!signal.aborted) failSignIn("Sign-in did not finish. Try again.");
    }
  }
  const reloadPanel = () => {
    if (!frame || !activation) return;
    status({ state: "loading", provider: activation.provider });
    frame.src = activation.provider.panelUrl;
  };
  /** PCBJam holds nothing to delete: the page clears its own session, the panel loads afresh like in KiCad. */
  const signOut = () => {
    endSignIn();
    notice("");
    log("sign-in: signed out");
    if (working) reloadAfterSave = true;
    else reloadPanel();
  };

  const onLoad = () => {
    if (!session || !activation) return;
    // A page that loaded anew has a new session: a sign-in the old page asked for ends with it.
    endSignIn();
    if (handshakeTimer) clearInterval(handshakeTimer);
    post(session.begin());
    status({ state: "connecting", provider: activation.provider, attempt: 1 });
    handshakeTimer = setInterval(() => {
      const again = session!.retry();
      if (again) { post(again); status({ state: "connecting", provider: activation!.provider, attempt: session!.attempts }); return; }
      clearInterval(handshakeTimer);
      handshakeTimer = undefined;
      if (session!.handshake === "failed")
        fail("The provider page did not answer PCBJam's handshake. It needs the PCBJam bridge shim and the Cross-Origin-Embedder-Policy/Resource-Policy headers.");
    }, PROVIDER_LIMITS.handshakeIntervalMs);
  };

  const onMessage = (event: MessageEvent) => {
    if (!frame || !session || !activation) return;
    if (event.source !== frame.contentWindow || event.origin !== activation.provider.panelOrigin) return;
    const raw = typeof event.data === "string" ? event.data : event.data && typeof event.data === "object" ? event.data : null;
    if (raw === null) return;
    if (typeof raw === "string" && raw.length > PROVIDER_LIMITS.messageBytes) { log("dropped: message too large"); return; }
    const handled = session.handleIncoming(raw, { activity: activity() });
    if (handled.dropped) log("dropped: " + handled.dropped);
    for (const out of handled.outbound) post(out);
    if (handled.ready) { if (handshakeTimer) clearInterval(handshakeTimer); handshakeTimer = undefined; status({ state: "ready", provider: activation.provider }); }
    const effect = handled.effect;
    if (!effect) return;
    // The two sign-in effects run in this task: the popup needs the click that sent the message.
    if (effect.kind === "login") startSignIn();
    else if (effect.kind === "sign-out") signOut();
    else {
      working = true;
      void runEffect(effect).finally(() => {
        working = false;
        if (reloadAfterSave) { reloadAfterSave = false; reloadPanel(); }
      });
    }
  };

  async function runEffect(effect: PartEffect) {
    if (!session || !activation) return;
    const { requestId, command } = effect;
    const provider = activation.provider;
    try {
      let request: PartRequest;
      if (effect.kind === "place") {
        status({ state: "busy", provider, message: `Downloading ${effect.manifest.displayName}…` });
        const bytes = new Map<string, Uint8Array>();
        for (const asset of effect.manifest.assets) {
          bytes.set(asset.downloadUrl, await api.asset(activation.id, { url: asset.downloadUrl, contentType: asset.contentType, sizeBytes: asset.sizeBytes, sha256: asset.sha256 }, signal));
        }
        const { pack, skipped } = manifestToPack(effect.manifest, bytes, { providerOrigin: provider.origin, providerId: options.plugin.manifest.id });
        request = { command, place: effect.manifest.place, pack, skipped, totalBytes: effect.manifest.totalBytes };
      } else {
        const total = [effect.pack.symbol, effect.pack.footprint, effect.pack.model3d, effect.pack.spice].reduce((n, a) => n + (a?.bytes.length ?? 0), 0);
        request = { command, place: effect.place, pack: effect.pack, skipped: effect.skipped, totalBytes: total };
      }
      status({ state: "busy", provider, message: `Confirm ${request.pack.displayName}` });
      if (!(await options.confirmPart(request, signal))) {
        post(session.error(requestId, command, "IMPORT_FAILED", "Cancelled in PCBJam."));
        log(`${command} ${request.pack.displayName}: cancelled in PCBJam`);
        status({ state: "ready", provider });
        return;
      }
      // The confirmation may have waited a long time: re-check access right
      // before anything is written, so a revoked provider cannot save a part.
      await api.json(`activations/${activation.id}/check`, "POST", { method: "provider.asset" }, signal);
      status({ state: "busy", provider, message: `Saving ${request.pack.displayName}…` });
      // Reply as soon as the library write is done (onSaved, if the saver
      // supports it) so the page's RPC timeout never races the canvas click.
      let replied = false;
      const ok = () => { if (!replied) { replied = true; post(session!.reply(requestId, command)); } };
      const result = await options.savePart(request.pack, { place: request.place, signal, onSaved: ok });
      ok();
      const placement = result.placement === "cancelled" ? "placement cancelled" : result.placement === "placed" ? "placed" : "saved";
      log(`${command} ${request.pack.displayName}: ${placement} in ${result.libNickname}${result.skipped.length ? `; skipped ${result.skipped.join(", ")}` : ""}`);
      status({ state: "ready", provider });
    } catch (error) {
      const e = error as Error & { code?: string };
      const code = e.code === "NOT_SIGNED_IN" || e.code === "NO_TEAM_WRITE" ? "ACCESS_DENIED" : e.code === "PLACEMENT_UNAVAILABLE" ? null : "IMPORT_FAILED";
      // Saver codes are already mapped; a proxy code (DIGEST_MISMATCH, …) is the
      // actionable part for the provider, so it travels in the message.
      // LIB_WRITE_FAILED (0015): the live team-lib push was refused, the part may be
      // partly stored; a second Place is safe because saves overwrite. Never retried here.
      const message = (e.message || "Unable to process provider payload.")
        + (e.code && !SAVER_CODES.has(e.code) ? ` (${e.code})` : "")
        + (e.code === "LIB_WRITE_FAILED" ? " Click Place again to retry." : "");
      if (code === null) post(session.reply(requestId, command));
      else post(session.error(requestId, command, denied(e) ? "ACCESS_DENIED" : code, message));
      log(`${command} failed: ${message}`);
      if (denied(e)) end("Provider access ended: " + e.message + ". Reopen the panel to continue.");
      else if (!signal.aborted) status({ state: "ready", provider });
    }
  }

  (async () => {
    try {
      status({ state: "activating" });
      if (!options.plugin.pluginId) throw new Error("Open a saved project to use this provider");
      activation = await api.json<ProviderActivation>("activations", "POST", {
        pluginId: options.plugin.pluginId, digest: options.plugin.digest, generation: options.plugin.generation,
        projectId: options.projectId, document: options.document, surface: "editor:eeschema",
        runtimeVersion: options.runtimeVersion, protocolVersion: 1,
      }, signal);
      if (!activation.provider) throw new Error("This package is not a remote provider");
      signal.throwIfAborted();
      const provider = activation.provider;
      session = createProviderSession({
        clientVersion: options.clientVersion, providerId: options.plugin.manifest.id, providerName: provider.providerName,
        providerOrigin: provider.origin, panelUrl: provider.panelUrl, originSet: provider.originSet,
        supportedAssetTypes: provider.supportedAssetTypes, maxDownloadBytes: provider.maxDownloadBytes,
        supportsDirectDownloads: provider.capabilities.directDownloads, supportsInlinePayloads: provider.capabilities.inlinePayloads,
        authType: provider.auth ? "oauth2" : "none",
        uuid: options.uuid,
      });
      if (provider.auth) preparePair();
      window.addEventListener("message", onMessage);
      frame = document.createElement("iframe");
      frame.title = provider.providerName + " parts";
      // A real origin (allow-same-origin) is required so event.origin can be
      // checked and the provider's own cookies work; navigation of the top
      // window, downloads and modal dialogs stay blocked.
      frame.setAttribute("sandbox", "allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox");
      frame.referrerPolicy = "strict-origin";
      frame.setAttribute("allow", "");
      frame.style.cssText = "border:0;width:100%;height:100%;display:block;background:transparent";
      frame.addEventListener("load", onLoad);
      status({ state: "loading", provider });
      frame.src = provider.panelUrl;
      container.appendChild(frame);
      // A refusal ends the panel; a network blip or 429/503 only skips a beat
      // (two missed beats let the activation expire, which is a refusal).
      heartbeat = setInterval(() => {
        api.json(`activations/${activation!.id}/check`, "POST", { method: "provider.asset" }, signal).catch((e: Error) => {
          if (denied(e)) end("Provider access ended: " + e.message + ". Reopen the panel to continue.");
          else if (!signal.aborted) log("access check failed, retrying: " + e.message);
        });
      }, options.heartbeatMs ?? HEARTBEAT_MS);
    } catch (error) {
      if (!signal.aborted) fail((error as Error).message);
    }
  })();

  const dispose = () => {
    if (disposed) return;
    disposed = true;
    teardown();
    if (activation) void api.json(`activations/${activation.id}`, "DELETE").catch(noop);
  };
  options.signal.addEventListener("abort", dispose, { once: true });
  return {
    dispose,
    signIn() {
      if (disposed || ended || !activation || !pending || pending.opened) return;
      if (openSignIn()) status({ state: "sign-in", provider: activation.provider, step: "popup" });
    },
    cancelSignIn() {
      if (disposed || ended || (!pending && exchanging === undefined)) return;
      endSignIn();
      notice("");
      log("sign-in: stopped in PCBJam");
      settle();
    },
  };
}
