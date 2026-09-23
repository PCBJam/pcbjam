import { describe, expect, it } from "vitest";
import { PROVIDER_LIMITS } from "@pcbjam/plugin-platform/remote-provider-contract.mjs";
import { createProviderSession, decodeBase64, inlineToPack, manifestToPack, type Effect } from "./protocol";

const ORIGIN = "https://kicad.acme-parts.example";
const options = {
  clientVersion: "10.0.4", providerId: "acme", providerName: "Acme", providerOrigin: ORIGIN, panelUrl: ORIGIN + "/panel",
  originSet: [ORIGIN], supportedAssetTypes: ["symbol", "footprint", "3dmodel", "spice"], maxDownloadBytes: 1 << 20,
  supportsDirectDownloads: true, supportsInlinePayloads: true, uuid: () => "session-1",
};
const b64 = (s: string) => Buffer.from(s).toString("base64");
const SYMBOL = '(kicad_symbol_lib (symbol "R"))';
const FOOTPRINT = '(footprint "R_0603")';
const page = (session: ReturnType<typeof createProviderSession>) => {
  let id = 100;
  return (command: string, extra: Record<string, unknown> = {}) =>
    session.handleIncoming(JSON.stringify({ version: 1, session_id: session.sessionId, message_id: ++id, command, parameters: {}, data: "", ...extra }));
};
const asset = (patch: Record<string, unknown> = {}) => ({
  asset_type: "symbol", name: "r.kicad_sym", target_library: "Device", target_name: "R", content_type: "application/x-kicad-symbol",
  size_bytes: SYMBOL.length, sha256: "a".repeat(64), download_url: ORIGIN + "/downloads/r.kicad_sym", required: true, ...patch,
});

describe("handshake", () => {
  it("posts NEW_SESSION with a fresh session, retries a bounded number of times, and completes on the page's reply", () => {
    const s = createProviderSession(options);
    expect(s.handshake).toBe("idle");
    const hello = s.begin();
    expect(hello).toMatchObject({ version: 1, session_id: "session-1", message_id: 1, command: "NEW_SESSION", status: "OK",
      parameters: { client_name: "PCBJam", client_version: "10.0.4", supported_versions: [1] } });
    expect(s.handshake).toBe("pending");
    for (let i = 2; i <= PROVIDER_LIMITS.handshakeAttempts; i++) expect(s.retry()).toMatchObject({ message_id: i, command: "NEW_SESSION" });
    expect(s.retry()).toBeNull();
    expect(s.handshake).toBe("failed");
    const again = createProviderSession(options);
    const h = again.begin();
    const reply = again.handleIncoming({ version: 1, session_id: "session-1", message_id: 1, response_to: h.message_id, command: "NEW_SESSION", status: "OK", parameters: { server_name: "x" } });
    expect(reply).toEqual({ outbound: [], ready: true });
    expect(again.handshake).toBe("ready");
    expect(again.retry()).toBeNull();
    // A NEW_SESSION request from the page (not a reply) is answered.
    const asked = page(again)("NEW_SESSION");
    expect(asked.outbound[0]).toMatchObject({ command: "NEW_SESSION", status: "OK", parameters: { client_name: "PCBJam" } });
    expect(asked.ready).toBe(false);
  });
});

describe("envelope gates", () => {
  it("mirrors desktop KiCad's refusals", () => {
    const s = createProviderSession(options);
    s.begin();
    expect(s.handleIncoming("not json")).toMatchObject({ outbound: [], dropped: expect.stringContaining("JSON") });
    expect(s.handleIncoming({ message_id: 1, command: "CAPABILITIES" }).outbound[0]).toMatchObject({ status: "ERROR", error_code: "UNSUPPORTED_VERSION", error_message: "Unsupported RPC version 0.", response_to: 1 });
    expect(s.handleIncoming({ version: 2, message_id: 1, session_id: "session-1", command: "CAPABILITIES" }).outbound[0]).toMatchObject({ error_code: "UNSUPPORTED_VERSION" });
    expect(s.handleIncoming({ version: 1, message_id: 1, command: "CAPABILITIES" }).outbound[0]).toMatchObject({ error_code: "INVALID_PARAMETERS" });
    expect(s.handleIncoming({ version: 1, message_id: 1, session_id: "nope", command: "CAPABILITIES" }).outbound[0]).toMatchObject({ error_code: "SESSION_MISMATCH" });
    expect(page(s)("FROBNICATE").outbound[0]).toMatchObject({ error_code: "UNKNOWN_COMMAND", error_message: "Command 'FROBNICATE' is not supported.", command: "FROBNICATE" });
    // Message ids from the host are monotonic across replies and errors.
    const ids = [page(s)("CAPABILITIES"), page(s)("FROBNICATE")].map((h) => (h.outbound[0] as { message_id: number }).message_id);
    expect(ids[1]).toBe(ids[0]! + 1);
  });
});

describe("informational commands", () => {
  it("answers versions, capabilities (NONE compression only), source info and refuses login", () => {
    const s = createProviderSession(options);
    s.begin();
    const send = page(s);
    expect(send("GET_KICAD_VERSION").outbound[0]).toMatchObject({ parameters: { kicad_version: "10.0.4" } });
    expect(send("LIST_SUPPORTED_VERSIONS").outbound[0]).toMatchObject({ parameters: { supported_versions: [1] } });
    const caps = (send("CAPABILITIES").outbound[0] as { parameters: { commands: string[]; compression: string[] } }).parameters;
    expect(caps.compression).toEqual(["NONE"]);
    expect(caps.commands).toContain("PLACE_COMPONENT");
    expect(send("GET_SOURCE_INFO").outbound[0]).toMatchObject({ parameters: { provider_id: "acme", provider_name: "Acme", panel_url: ORIGIN + "/panel", authenticated: false, auth_type: "none", supports_direct_downloads: true, supports_inline_payloads: true } });
    expect(send("REMOTE_LOGIN", { parameters: { interactive: true } }).outbound[0]).toMatchObject({ status: "ERROR", error_code: "LOGIN_FAILED" });
    expect(send("REMOTE_LOGIN", { parameters: { sign_out: true } }).outbound[0]).toMatchObject({ status: "OK", parameters: { authenticated: false, signed_out: true } });
  });
});

describe("PLACE_COMPONENT manifests", () => {
  it("validates against the provider's origin set and limits, then surfaces a place effect", () => {
    const s = createProviderSession(options);
    s.begin();
    const send = page(s);
    const ok = send("PLACE_COMPONENT", { parameters: { part_id: "acme-r", display_name: "R 10k", mode: "PLACE", assets: [asset(), asset({ asset_type: "footprint", name: "R_0603.kicad_mod", target_name: "R_0603", sha256: "b".repeat(64), required: false })] } });
    expect(ok.outbound).toEqual([]);
    const effect = ok.effect as Extract<Effect, { kind: "place" }>;
    expect(effect.kind).toBe("place");
    expect(effect.requestId).toBe(101);
    expect(effect.manifest.place).toBe(true);
    expect(effect.manifest.assets.map((a) => a.assetType)).toEqual(["symbol", "footprint"]);
    // DL_COMPONENT with assets and mode SAVE is the same path without placement.
    const save = send("DL_COMPONENT", { parameters: { part_id: "acme-r", display_name: "R", mode: "SAVE", assets: [asset()] } });
    expect((save.effect as Extract<Effect, { kind: "place" }>).manifest.place).toBe(false);
    const cases: [Record<string, unknown>, string, RegExp][] = [
      [{ part_id: "x", display_name: "x", assets: [asset({ download_url: "https://cdn.other.example/r" })] }, "IMPORT_FAILED", /origin must match/],
      [{ part_id: "x", display_name: "x", assets: [asset({ sha256: "zz" })] }, "IMPORT_FAILED", /sha256/],
      [{ part_id: "x", display_name: "x", assets: [asset({ asset_type: "footprint" })] }, "IMPORT_FAILED", /no symbol asset/],
      [{ part_id: "x", display_name: "x", assets: [asset({ size_bytes: (1 << 20) + 1 })] }, "IMPORT_FAILED", /download limit|size limit/],
      [{ part_id: "x", display_name: "x", assets: [] }, "IMPORT_FAILED", /non-empty/],
      [{ part_id: "x", display_name: "x", mode: "STREAM", assets: [asset()] }, "IMPORT_FAILED", /Unsupported transfer mode/],
    ];
    for (const [parameters, code, message] of cases) {
      const out = send("PLACE_COMPONENT", { parameters }).outbound[0] as { error_code: string; error_message: string };
      expect(out.error_code, JSON.stringify(parameters)).toBe(code);
      expect(out.error_message).toMatch(message);
    }
  });
  it("turns verified bytes into a PartPack, first footprint wins, 3D and spice ride along", () => {
    const s = createProviderSession(options);
    s.begin();
    const effect = page(s)("PLACE_COMPONENT", { parameters: { part_id: "acme-r", display_name: "R 10k", symbol_name: "R_custom", assets: [
      asset(), asset({ asset_type: "footprint", name: "a.kicad_mod", target_name: "A", download_url: ORIGIN + "/a", required: false }),
      asset({ asset_type: "footprint", name: "b.kicad_mod", target_name: "B", download_url: ORIGIN + "/b", required: false }),
      asset({ asset_type: "3dmodel", name: "r.step", target_name: "", content_type: "model/step", download_url: ORIGIN + "/r.step", required: false }),
      asset({ asset_type: "spice", name: "r.cir", target_name: "", download_url: ORIGIN + "/r.cir", required: false }),
    ] } }).effect as Extract<Effect, { kind: "place" }>;
    const bytes = new Map(effect.manifest.assets.map((a) => [a.downloadUrl, new TextEncoder().encode(a.name)]));
    const { pack, skipped } = manifestToPack(effect.manifest, bytes, options);
    expect(pack).toMatchObject({ providerOrigin: ORIGIN, providerId: "acme", partId: "acme-r", displayName: "R 10k" });
    expect(pack.symbol?.name).toBe("R_custom");
    expect(pack.footprint?.name).toBe("A");
    expect(pack.model3d).toMatchObject({ name: "r", contentType: "model/step" });
    expect(pack.spice?.name).toBe("r");
    expect(skipped).toEqual(["footprint B"]);
    bytes.delete(ORIGIN + "/downloads/r.kicad_sym");
    expect(() => manifestToPack(effect.manifest, bytes, options)).toThrow(/Required asset r.kicad_sym/);
  });
});

describe("inline payloads", () => {
  it("decodes DL_COMPONENT bundles and single DL_* payloads into a PartPack; ZSTD is refused", () => {
    const s = createProviderSession(options);
    s.begin();
    const send = page(s);
    const bundle = b64(JSON.stringify([
      { type: "symbol", name: "R", content: b64(SYMBOL), compression: "NONE" },
      { type: "footprint", name: "R_0603", content: b64(FOOTPRINT), compression: "NONE" },
      { type: "spice", name: "r", content: b64("* r"), compression: "NONE" },
    ]));
    const inline = send("DL_COMPONENT", { parameters: { compression: "NONE", library: "Passives", mode: "PLACE" }, data: bundle }).effect as Extract<Effect, { kind: "inline-part" }>;
    expect(inline.kind).toBe("inline-part");
    expect(inline.place).toBe(true);
    expect(new TextDecoder().decode(inline.pack.symbol!.bytes)).toBe(SYMBOL);
    expect(inline.pack.footprint?.name).toBe("R_0603");
    expect(inline.pack.spice?.name).toBe("r");
    expect(inline.pack.partId).toBe("R");
    const single = send("DL_SYMBOL", { parameters: { name: "R", content_type: "KICAD_SYMBOL_V1", mode: "SAVE" }, data: b64(SYMBOL) }).effect as Extract<Effect, { kind: "inline-part" }>;
    expect(single.place).toBe(false);
    expect(single.pack.symbol?.name).toBe("R");
    expect(single.pack.footprint).toBeUndefined();
    const fp = send("DL_FOOTPRINT", { parameters: { name: "R_0603" }, data: b64(FOOTPRINT) }).effect as Extract<Effect, { kind: "inline-part" }>;
    expect(fp.pack.footprint?.name).toBe("R_0603");
    expect(send("DL_COMPONENT", { parameters: { compression: "ZSTD" }, data: bundle }).outbound[0]).toMatchObject({ error_code: "INVALID_PAYLOAD", error_message: expect.stringContaining("ZSTD") });
    expect(send("DL_COMPONENT", { parameters: {}, data: "%%%" }).outbound[0]).toMatchObject({ error_code: "INVALID_PAYLOAD" });
    expect(send("DL_COMPONENT", { parameters: {}, data: b64("[]") }).outbound[0]).toMatchObject({ error_code: "INVALID_PAYLOAD", error_message: expect.stringContaining("non-empty") });
    expect(send("DL_3DMODEL", { parameters: { name: "r" }, data: b64("STEP") }).outbound[0]).toMatchObject({ error_code: "IMPORT_FAILED", error_message: expect.stringContaining("neither a symbol nor a footprint") });
  });
  it("enforces the byte budget and duplicate slots", () => {
    const big = { type: "symbol", name: "R", content: b64("x".repeat(PROVIDER_LIMITS.assetBytes + 1)), compression: "NONE" };
    expect(() => inlineToPack([big] as never, options, "", {})).toThrow(/size limit/);
    const { pack, skipped } = inlineToPack([
      { type: "symbol", name: "A", content: b64(SYMBOL), compression: "NONE" },
      { type: "symbol", name: "B", content: b64(SYMBOL), compression: "NONE" },
    ], options, "", { part_id: "p", display_name: "P" });
    expect(pack.symbol?.name).toBe("A");
    expect(skipped).toEqual(["symbol B"]);
    expect(decodeBase64("aGVs bG8=")).toEqual(new TextEncoder().encode("hello"));
    expect(() => decodeBase64("a")).toThrow(/base64/);
  });
});

describe("busy host", () => {
  it("refuses part commands without decoding them while an earlier part is pending; other commands still answer", () => {
    const s = createProviderSession(options);
    s.begin();
    let id = 500;
    const send = (command: string, extra: Record<string, unknown>, busy: boolean) =>
      s.handleIncoming({ version: 1, session_id: s.sessionId, message_id: ++id, command, parameters: {}, ...extra }, { busy });
    // Not even valid base64: a busy host must refuse before looking at it.
    for (const command of ["DL_SYMBOL", "DL_COMPONENT", "PLACE_COMPONENT"]) {
      const handled = send(command, { data: "%%%" }, true);
      expect(handled.effect).toBeUndefined();
      expect(handled.outbound[0]).toMatchObject({ status: "ERROR", error_code: "IMPORT_FAILED", error_message: expect.stringContaining("still handling"), response_to: id });
    }
    expect(send("CAPABILITIES", {}, true).outbound[0]).toMatchObject({ status: "OK", command: "CAPABILITIES" });
    const free = send("DL_SYMBOL", { data: b64(SYMBOL), parameters: { name: "R" } }, false);
    expect(free.effect).toMatchObject({ kind: "inline-part", command: "DL_SYMBOL" });
  });
});
