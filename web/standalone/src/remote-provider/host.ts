// Remote-provider RPC host, DOM half. Owns the activation, the cross-origin
// iframe, the postMessage channel and the asset proxy calls; everything
// protocol-shaped is delegated to protocol.ts, everything library-shaped to
// the injected savePart (libs/save-part.ts in the app, a recorder in tests).
import { PROVIDER_LIMITS } from "@pcbjam/plugin-platform/remote-provider-contract.mjs";
import type { PartPack, SavePartOptions, SavePartResult } from "@/libs/save-part";
import { createProviderSession, manifestToPack, type Effect, type ProviderSession } from "./protocol";

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
  };
}
export type HostStatus =
  | { state: "activating" }
  | { state: "loading"; provider: ProviderActivation["provider"] }
  | { state: "connecting"; provider: ProviderActivation["provider"]; attempt: number }
  | { state: "ready"; provider: ProviderActivation["provider"] }
  | { state: "busy"; provider: ProviderActivation["provider"]; message: string }
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
  /** Injection points for tests. */
  fetchImpl?: typeof fetch;
  uuid?: () => string;
  heartbeatMs?: number;
}

export const HEARTBEAT_MS = 40000;
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
    async json<T>(path: string, method: string, data?: unknown, signal?: AbortSignal): Promise<T> {
      const response = await call(path, method, data, signal);
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

export function mountRemoteProvider(container: HTMLElement, options: RemoteProviderMountOptions): { dispose(): void } {
  const api = createPlatformClient(options.apiBase, options.fetchImpl);
  const log = options.onLog ?? noop;
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

  const onLoad = () => {
    if (!session || !activation) return;
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
    const handled = session.handleIncoming(raw, { busy: working });
    if (handled.dropped) log("dropped: " + handled.dropped);
    for (const out of handled.outbound) post(out);
    if (handled.ready) { if (handshakeTimer) clearInterval(handshakeTimer); handshakeTimer = undefined; status({ state: "ready", provider: activation.provider }); }
    if (handled.effect) {
      working = true;
      void runEffect(handled.effect).finally(() => { working = false; });
    }
  };

  async function runEffect(effect: Effect) {
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
        uuid: options.uuid,
      });
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
  return { dispose };
}
