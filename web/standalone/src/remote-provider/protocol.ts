// Remote-provider RPC host, protocol half. Pure: no DOM, no network, no
// timers. The DOM adapter (host.ts) feeds it raw messages and posts back the
// envelopes it returns; asynchronous work (downloads, saving, placement) is
// surfaced as effects and completed through reply()/error().
//
// Wire format and semantics mirror desktop KiCad 10
// (eeschema/widgets/panel_remote_symbol.cpp), so a provider page written for
// the desktop panel works here once it uses window.parent.postMessage.
import {
  PROVIDER_LIMITS,
  RPC_VERSION,
  validateEnvelope,
  validateInlineBundle,
  validatePlaceManifest,
  type Envelope,
  type InlineEntry,
  type PlaceManifest,
} from "@pcbjam/plugin-platform/remote-provider-contract.mjs";
import type { PartPack } from "@/libs/save-part";

export const CLIENT_NAME = "PCBJam";
export const SUPPORTED_COMMANDS = [
  "NEW_SESSION", "GET_KICAD_VERSION", "LIST_SUPPORTED_VERSIONS", "CAPABILITIES", "GET_SOURCE_INFO",
  "REMOTE_LOGIN", "DL_SYMBOL", "DL_COMPONENT", "DL_FOOTPRINT", "DL_SPICE", "DL_3DMODEL", "PLACE_COMPONENT",
] as const;
/** Only uncompressed payloads: advertising NONE lets a well-behaved provider negotiate. */
export const SUPPORTED_COMPRESSION = ["NONE"] as const;

export interface ProviderSessionOptions {
  clientVersion: string;
  providerId: string;
  providerName: string;
  providerOrigin: string;
  panelUrl: string;
  originSet: string[];
  supportedAssetTypes: readonly string[];
  maxDownloadBytes: number;
  supportsDirectDownloads: boolean;
  supportsInlinePayloads: boolean;
  /** How the provider signs its users in; "oauth2" turns REMOTE_LOGIN on (plugins 0028). */
  authType?: "none" | "oauth2";
  uuid?: () => string;
}
/**
 * What the host is doing when a message arrives. Sign-in and part saving share this one state,
 * so they never overlap: the reload after a sign-in would otherwise start a new session under
 * a running save.
 *  - "saving": a part request is being downloaded, confirmed or saved;
 *  - "pending": a sign-in was started and its popup has not come back;
 *  - "exchanging": the popup came back and the server is finishing the sign-in.
 */
export type HostActivity = "idle" | "saving" | "pending" | "exchanging";
/**
 * Work a message asks of the host. A part request is answered when its work is done; the two
 * sign-in effects are answered at once (the reply is in `outbound`) and the host acts on them
 * in the same task: "login" opens the sign-in popup, "sign-out" ends a running sign-in and
 * reloads the panel.
 */
export type PartEffect =
  | { kind: "place"; requestId: number; command: string; manifest: PlaceManifest }
  | { kind: "inline-part"; requestId: number; command: string; place: boolean; pack: PartPack; skipped: string[] };
export type Effect = PartEffect | { kind: "login" } | { kind: "sign-out" };
export interface Handled {
  /** Envelopes to post to the page, in order. */
  outbound: object[];
  effect?: Effect;
  /** Handshake became ready with this incoming message. */
  ready?: boolean;
  /** A message was dropped; the reason is for the host's log only. */
  dropped?: string;
}
export type HandshakeState = "idle" | "pending" | "ready" | "failed";

const ERRORS = {
  UNSUPPORTED_VERSION: (v: number) => `Unsupported RPC version ${v}.`,
  INVALID_PARAMETERS: "Missing session identifier.",
  SESSION_MISMATCH: "Session identifier did not match the active provider session.",
  LOGIN_IN_PROGRESS: "A sign-in is already in progress.",
  UNKNOWN_COMMAND: (c: string) => `Command '${c}' is not supported.`,
  BUSY: "PCBJam is still handling the previous part. Try again when it has finished.",
  SIGNING_IN: "PCBJam is signing you in. Try again when it has finished.",
};

export function createProviderSession(options: ProviderSessionOptions) {
  const uuid = options.uuid ?? (() => crypto.randomUUID());
  let sessionId = "";
  let counter = 0;
  let handshake: HandshakeState = "idle";
  let attempts = 0;
  let helloId = 0;

  const envelope = (command: string, extra: Record<string, unknown>) => ({
    version: RPC_VERSION, session_id: sessionId, message_id: ++counter, command, status: "OK", ...extra,
  });
  const reply = (requestId: number, command: string, parameters?: Record<string, unknown>) =>
    envelope(command, { response_to: requestId, ...(parameters && Object.keys(parameters).length ? { parameters } : {}) });
  const error = (requestId: number, command: string, code: string, message: string) =>
    envelope(command, { response_to: requestId, status: "ERROR", error_code: code, error_message: message });
  const hello = () => {
    const env = envelope("NEW_SESSION", {
      parameters: { client_name: CLIENT_NAME, client_version: options.clientVersion, supported_versions: [RPC_VERSION] },
    });
    helloId = env.message_id;
    return env;
  };

  return {
    get sessionId() { return sessionId; },
    get handshake() { return handshake; },
    get attempts() { return attempts; },
    /** New session for a freshly loaded page. Returns the NEW_SESSION notification to post. */
    begin() {
      sessionId = uuid();
      counter = 0;
      attempts = 1;
      handshake = "pending";
      return hello();
    },
    /** Re-post NEW_SESSION while the page has not answered; null once attempts are exhausted. */
    retry() {
      if (handshake !== "pending") return null;
      if (attempts >= PROVIDER_LIMITS.handshakeAttempts) { handshake = "failed"; return null; }
      attempts++;
      return hello();
    },
    reply,
    error,
    /**
     * `activity`: what the host is doing (see HostActivity). While it is not idle, part
     * commands are refused before their payload is decoded, so a page cannot pile up work
     * (or memory) behind a pending confirmation or a sign-in.
     */
    handleIncoming(raw: unknown, { activity = "idle" }: { activity?: HostActivity } = {}): Handled {
      let m: Envelope;
      try { m = validateEnvelope(raw); } catch (e) { return { outbound: [], dropped: (e as Error).message }; }
      if (m.version !== RPC_VERSION) return { outbound: [error(m.messageId, m.command, "UNSUPPORTED_VERSION", ERRORS.UNSUPPORTED_VERSION(m.version))] };
      if (!m.sessionId) return { outbound: [error(m.messageId, m.command, "INVALID_PARAMETERS", ERRORS.INVALID_PARAMETERS)] };
      if (m.sessionId !== sessionId) return { outbound: [error(m.messageId, m.command, "SESSION_MISMATCH", ERRORS.SESSION_MISMATCH)] };
      const p = m.parameters;
      switch (m.command) {
        case "NEW_SESSION": {
          // The page's reply to our notification completes the handshake; a NEW_SESSION
          // request from the page is answered like desktop KiCad does.
          const ready = handshake !== "ready";
          handshake = "ready";
          if (m.responseTo === helloId) return { outbound: [], ready };
          return { outbound: [reply(m.messageId, m.command, { client_name: CLIENT_NAME, client_version: options.clientVersion, supported_versions: [RPC_VERSION] })], ready };
        }
        case "GET_KICAD_VERSION":
          return { outbound: [reply(m.messageId, m.command, { kicad_version: options.clientVersion })] };
        case "LIST_SUPPORTED_VERSIONS":
          return { outbound: [reply(m.messageId, m.command, { supported_versions: [RPC_VERSION] })] };
        case "CAPABILITIES":
          return { outbound: [reply(m.messageId, m.command, { commands: [...SUPPORTED_COMMANDS], compression: [...SUPPORTED_COMPRESSION], max_message_size: PROVIDER_LIMITS.messageBytes })] };
        case "GET_SOURCE_INFO":
          return { outbound: [reply(m.messageId, m.command, {
            provider_id: options.providerId, provider_name: options.providerName, panel_url: options.panelUrl,
            // Always false: with sign-in the provider's page keeps the session, PCBJam holds no
            // token (desktop KiCad answers true once it has one). A panel decides from its own session.
            authenticated: false, auth_type: options.authType ?? "none",
            supports_direct_downloads: options.supportsDirectDownloads, supports_inline_payloads: options.supportsInlinePayloads,
          })] };
        case "REMOTE_LOGIN": {
          // Answers follow desktop KiCad (panel_remote_symbol.cpp): sign-out first, then a
          // provider without sign-in, then a request that may not open anything.
          const oauth = options.authType === "oauth2";
          if (p.sign_out === true)
            return { outbound: [reply(m.messageId, m.command, { authenticated: false, signed_out: true })], ...(oauth ? { effect: { kind: "sign-out" } as const } : {}) };
          if (!oauth) return { outbound: [reply(m.messageId, m.command, { authenticated: false, auth_type: "none" })] };
          if (p.interactive === false) return { outbound: [reply(m.messageId, m.command, { authenticated: false, started: false })] };
          if (activity === "saving") return { outbound: [error(m.messageId, m.command, "LOGIN_FAILED", ERRORS.BUSY)] };
          if (activity === "exchanging") return { outbound: [error(m.messageId, m.command, "LOGIN_FAILED", ERRORS.LOGIN_IN_PROGRESS)] };
          // Idle, or a popup is open: a new request replaces that attempt (the user may have
          // closed the popup, which the editor cannot see).
          return { outbound: [reply(m.messageId, m.command, { authenticated: false, started: true })], effect: { kind: "login" } };
        }
        case "PLACE_COMPONENT":
        case "DL_COMPONENT":
        case "DL_SYMBOL":
        case "DL_FOOTPRINT":
        case "DL_3DMODEL":
        case "DL_SPICE": {
          if (activity !== "idle") return { outbound: [error(m.messageId, m.command, "IMPORT_FAILED", activity === "saving" ? ERRORS.BUSY : ERRORS.SIGNING_IN)] };
          const place = m.command === "PLACE_COMPONENT" || String(p.mode ?? "").toUpperCase() === "PLACE";
          const isComponent = m.command === "PLACE_COMPONENT" || m.command === "DL_COMPONENT";
          try {
            if (isComponent && Array.isArray(p.assets)) {
              const manifest = validatePlaceManifest(p, {
                supportedAssetTypes: options.supportedAssetTypes as never,
                maxDownloadBytes: options.maxDownloadBytes,
                originSet: options.originSet,
              });
              if (!manifest.assets.some((a) => a.assetType === "symbol")) throw new Error("Manifest has no symbol asset to place.");
              return { outbound: [], effect: { kind: "place", requestId: m.messageId, command: m.command, manifest: { ...manifest, place } } };
            }
            const compression = String(p.compression ?? "NONE").toUpperCase();
            if (compression !== "NONE") return { outbound: [error(m.messageId, m.command, "INVALID_PAYLOAD", `${compression} compression is not supported by this client; send NONE.`)] };
            const entries = isComponent
              ? validateInlineBundle(JSON.parse(decodeUtf8(decodeBase64(m.data))))
              : [{ type: m.command.slice(3).toLowerCase() === "3dmodel" ? "3dmodel" : m.command.slice(3).toLowerCase(), name: String(p.name ?? ""), content: m.data, compression: "NONE" } as InlineEntry];
            const { pack, skipped } = inlineToPack(entries, options, String(p.library ?? ""), p);
            return { outbound: [], effect: { kind: "inline-part", requestId: m.messageId, command: m.command, place, pack, skipped } };
          } catch (e) {
            const message = (e as Error).message || "Unable to process provider payload.";
            const code = /base64|JSON|Component list|Component entry|compression/i.test(message) ? "INVALID_PAYLOAD" : "IMPORT_FAILED";
            return { outbound: [error(m.messageId, m.command, code, message)] };
          }
        }
        default:
          return { outbound: [error(m.messageId, m.command, "UNKNOWN_COMMAND", ERRORS.UNKNOWN_COMMAND(m.command))] };
      }
    },
  };
}
export type ProviderSession = ReturnType<typeof createProviderSession>;

export function decodeBase64(text: string): Uint8Array {
  const clean = text.replace(/\s+/g, "");
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(clean) || clean.length % 4 === 1) throw new Error("Failed to decode base64 payload.");
  const binary = atob(clean);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
const decodeUtf8 = (bytes: Uint8Array) => {
  try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { throw new Error("Failed to parse component list: payload is not UTF-8 JSON."); }
};
// One slot per asset type; false when that slot is already taken.
function assign(pack: PartPack, type: string, name: string, bytes: Uint8Array, contentType: string) {
  switch (type) {
    case "symbol": if (pack.symbol) return false; pack.symbol = { name, bytes }; return true;
    case "footprint": if (pack.footprint) return false; pack.footprint = { name, bytes }; return true;
    case "3dmodel": if (pack.model3d) return false; pack.model3d = { name, bytes, contentType }; return true;
    case "spice": if (pack.spice) return false; pack.spice = { name, bytes }; return true;
    default: throw new Error(`Unsupported component type '${type}'.`);
  }
}
const stem = (name: string) => name.replace(/\.(kicad_sym|kicad_mod|step|stp|wrl|cir|lib|mod)$/i, "");

/** DL_COMPONENT / DL_* entries → PartPack. First symbol and first footprint win; extras are reported. */
export function inlineToPack(
  entries: InlineEntry[],
  options: Pick<ProviderSessionOptions, "providerOrigin" | "providerId">,
  library: string,
  params: Record<string, unknown>
): { pack: PartPack; skipped: string[] } {
  const skipped: string[] = [];
  const pack: PartPack = { providerOrigin: options.providerOrigin, providerId: options.providerId, partId: "", displayName: "" };
  let total = 0;
  for (const entry of entries) {
    const bytes = decodeBase64(entry.content);
    total += bytes.length;
    if (bytes.length > PROVIDER_LIMITS.assetBytes || total > PROVIDER_LIMITS.partBytes) throw new Error("Remote asset exceeds the PCBJam asset size limit");
    const name = entry.name || stem(String(params.name ?? "")) || entry.type;
    if (!assign(pack, entry.type, name, bytes, "model/step")) skipped.push(`${entry.type} ${name}`);
  }
  if (!pack.symbol && !pack.footprint) throw new Error("Payload contains neither a symbol nor a footprint.");
  pack.partId = String(params.part_id ?? pack.symbol?.name ?? pack.footprint?.name ?? "");
  pack.displayName = String(params.display_name ?? pack.symbol?.name ?? pack.footprint?.name ?? library ?? "");
  return { pack, skipped };
}

/** PLACE_COMPONENT manifest + bytes the proxy verified → PartPack. */
export function manifestToPack(
  manifest: PlaceManifest,
  bytes: Map<string, Uint8Array>,
  options: Pick<ProviderSessionOptions, "providerOrigin" | "providerId">
): { pack: PartPack; skipped: string[] } {
  const skipped: string[] = [];
  const pack: PartPack = {
    providerOrigin: options.providerOrigin, providerId: options.providerId,
    partId: manifest.partId, displayName: manifest.displayName,
  };
  for (const asset of manifest.assets) {
    const content = bytes.get(asset.downloadUrl);
    if (!content) { if (asset.required) throw new Error(`Required asset ${asset.name} was not downloaded.`); continue; }
    const name = asset.targetName || stem(asset.name);
    if (!assign(pack, asset.assetType, name, content, asset.contentType)) skipped.push(`${asset.assetType} ${name}`);
  }
  if (!pack.symbol) throw new Error("Manifest has no symbol asset to place.");
  if (manifest.symbolName) pack.symbol.name = manifest.symbolName;
  return { pack, skipped };
}
