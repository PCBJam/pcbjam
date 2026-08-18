import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as syncProtocol from "y-protocols/sync";
import * as Y from "yjs";
import {
  parseGatewayClientMsg,
  tagGatewayFrame,
  untagGatewayFrame,
  type GatewayClientMsg,
} from "@pcbjam/shared";
import { CollabSubRejectedError, GatewayDocFacade } from "./gateway";

/**
 * The gateway facade is a mini y-websocket client over one shared multiplexed
 * socket (load-path-rework 0003 §6). These tests script the socket directly:
 * what a passive vs active subscription puts on the wire is the laziness
 * contract — a passive warm-pool sheet must never emit a doc frame.
 */

// --- scripted WebSocket ------------------------------------------------------

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  static OPEN = 1;
  static CLOSED = 3;
  readyState = 0;
  binaryType = "blob";
  sent: Array<string | ArrayBuffer | Uint8Array> = [];
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(public url: string) {
    FakeWebSocket.instances.push(this);
  }
  send(data: string | ArrayBuffer | Uint8Array): void {
    this.sent.push(data);
  }
  close(): void {
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.();
  }
  // test drivers
  open(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.();
  }
  receiveText(text: string): void {
    this.onmessage?.({ data: text });
  }
  receiveFrame(ch: number, frame: Uint8Array): void {
    const tagged = tagGatewayFrame(ch, frame);
    const buf = new ArrayBuffer(tagged.length);
    new Uint8Array(buf).set(tagged);
    this.onmessage?.({ data: buf });
  }
  drop(): void {
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.();
  }
  controls(): GatewayClientMsg[] {
    return this.sent
      .filter((d): d is string => typeof d === "string")
      .map((d) => parseGatewayClientMsg(d)!)
      .filter(Boolean);
  }
  frames(): Array<{ ch: number; type: number; frame: Uint8Array }> {
    return this.sent
      .filter((d): d is ArrayBuffer | Uint8Array => typeof d !== "string")
      .map((d) => {
        const bytes = d instanceof ArrayBuffer ? new Uint8Array(d) : d;
        const tagged = untagGatewayFrame(bytes)!;
        const dec = decoding.createDecoder(tagged.frame.slice());
        return {
          ch: tagged.ch,
          type: decoding.readVarUint(dec),
          frame: tagged.frame.slice(),
        };
      });
  }
}

vi.stubGlobal("WebSocket", FakeWebSocket);

let projSeq = 0;
function facadeOpts(docPath: string, passive = false) {
  return {
    endpoint: "http://localhost:3055",
    scopeId: "scope-x",
    // Fresh project per call site keeps the module-global connection registry
    // from leaking one test's socket into the next.
    projectId: `proj-${projSeq}`,
    docPath,
    passive,
  };
}

function newProject(): void {
  projSeq++;
}

const step2From = (serverDoc: Y.Doc, clientStep1?: Uint8Array): Uint8Array => {
  // Answer a client Step1 the way a BoardRoom would.
  let sv: Uint8Array | undefined;
  if (clientStep1) {
    const dec = decoding.createDecoder(clientStep1.slice());
    decoding.readVarUint(dec); // MESSAGE_SYNC
    decoding.readVarUint(dec); // messageYjsSyncStep1
    sv = decoding.readVarUint8Array(dec);
  }
  const enc = encoding.createEncoder();
  encoding.writeVarUint(enc, 0);
  syncProtocol.writeSyncStep2(enc, serverDoc, sv);
  return encoding.toUint8Array(enc);
};

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups.splice(0)) c();
  FakeWebSocket.instances = [];
});

function track(facade: GatewayDocFacade, ...docs: Y.Doc[]): void {
  cleanups.push(() => {
    try {
      facade.destroy();
    } catch {
      /* already destroyed */
    }
    for (const d of docs) d.destroy();
  });
}

describe("gateway facade — active documents", () => {
  it("subscribes, syncs via Step1/Step2, and pushes local updates", async () => {
    newProject();
    const doc = new Y.Doc();
    const facade = new GatewayDocFacade(doc, facadeOpts("a.kicad_sch"));
    track(facade, doc);
    const ws = FakeWebSocket.instances.at(-1)!;
    expect(ws.url).toContain("/parties/project-room/project%3Ascope-x%3A");

    ws.open();
    const [sub] = ws.controls();
    expect(sub).toEqual({
      t: "sub",
      ch: expect.any(Number) as number,
      doc: "a.kicad_sch",
      mode: "active",
    });
    const step1 = ws.frames().find((f) => f.type === 0);
    expect(step1).toBeTruthy();

    // Server state lands via Step2 → whenSynced resolves, doc holds it.
    const serverDoc = new Y.Doc();
    serverDoc.getMap("m").set("k", "v");
    cleanups.push(() => serverDoc.destroy());
    ws.receiveFrame(sub!.ch, step2From(serverDoc, step1!.frame));
    await facade.whenSynced();
    expect(doc.getMap("m").get("k")).toBe("v");

    // A local edit goes out as a sync update frame.
    ws.sent = [];
    doc.getMap("m").set("mine", 1);
    expect(ws.frames().some((f) => f.type === 0)).toBe(true);
  });

  it("re-sends Step1 on a resync prompt", () => {
    newProject();
    const doc = new Y.Doc();
    const facade = new GatewayDocFacade(doc, facadeOpts("a.kicad_sch"));
    track(facade, doc);
    const ws = FakeWebSocket.instances.at(-1)!;
    ws.open();
    const ch = ws.controls()[0]!.ch;
    ws.sent = [];
    ws.receiveText(JSON.stringify({ t: "resync", ch }));
    expect(ws.frames().filter((f) => f.type === 0).length).toBe(1);
  });
});

describe("gateway facade — passive warm pool (the laziness contract)", () => {
  it("puts NO doc frame on the wire, and whenSynced resolves on subscribe", async () => {
    newProject();
    const doc = new Y.Doc();
    const facade = new GatewayDocFacade(doc, facadeOpts("b.kicad_sch", true));
    track(facade, doc);
    const ws = FakeWebSocket.instances.at(-1)!;
    ws.open();
    expect(ws.controls()[0]).toMatchObject({ t: "sub", mode: "passive" });
    // Awareness/query frames are allowed (they're not demand); sync is not.
    expect(ws.frames().filter((f) => f.type === 0)).toEqual([]);
    await facade.whenSynced(); // resolves without any doc state
    expect(doc.share.size).toBe(0);
  });

  it("touched marks dirty via callback; activate() upgrades and truly syncs", async () => {
    newProject();
    const doc = new Y.Doc();
    const facade = new GatewayDocFacade(doc, facadeOpts("b.kicad_sch", true));
    track(facade, doc);
    const ws = FakeWebSocket.instances.at(-1)!;
    ws.open();
    const ch = ws.controls()[0]!.ch;

    let touched = 0;
    facade.onTouched(() => touched++);
    ws.receiveText(JSON.stringify({ t: "touched", ch }));
    expect(touched).toBe(1);

    ws.sent = [];
    const syncing = facade.activate();
    expect(ws.controls()).toEqual([{ t: "act", ch }]);
    const step1 = ws.frames().find((f) => f.type === 0);
    expect(step1).toBeTruthy();
    const serverDoc = new Y.Doc();
    serverDoc.getMap("m").set("from", "server");
    cleanups.push(() => serverDoc.destroy());
    ws.receiveFrame(ch, step2From(serverDoc, step1!.frame));
    await syncing;
    expect(doc.getMap("m").get("from")).toBe("server");
  });

  it("a local write into a passive doc auto-activates instead of silently desyncing", () => {
    newProject();
    const doc = new Y.Doc();
    const facade = new GatewayDocFacade(doc, facadeOpts("b.kicad_sch", true));
    track(facade, doc);
    const ws = FakeWebSocket.instances.at(-1)!;
    ws.open();
    ws.sent = [];
    doc.getMap("m").set("stray", true);
    expect(ws.controls().some((m) => m.t === "act")).toBe(true);
    expect(ws.frames().some((f) => f.type === 0)).toBe(true);
  });
});

describe("gateway facade — suberr is terminal", () => {
  it("rejects pending and future syncs with CollabSubRejectedError", async () => {
    newProject();
    const doc = new Y.Doc();
    const facade = new GatewayDocFacade(doc, facadeOpts("bad.kicad_sch"));
    track(facade, doc);
    const ws = FakeWebSocket.instances.at(-1)!;
    ws.open();
    const ch = ws.controls()[0]!.ch;
    const pending = facade.whenSynced();
    ws.receiveText(
      JSON.stringify({ t: "suberr", ch, status: 409, message: "flagged" }),
    );
    await expect(pending).rejects.toBeInstanceOf(CollabSubRejectedError);
    await expect(facade.activate()).rejects.toMatchObject({ status: 409 });
  });
});

describe("gateway facade — presence channel", () => {
  it("never speaks sync; publishes and receives awareness", async () => {
    newProject();
    const doc = new Y.Doc();
    const facade = new GatewayDocFacade(doc, facadeOpts("~presence"));
    track(facade, doc);
    const ws = FakeWebSocket.instances.at(-1)!;
    ws.open();
    await facade.whenSynced();
    expect(ws.frames().filter((f) => f.type === 0)).toEqual([]);
    // Query for peers went out on open.
    expect(ws.frames().some((f) => f.type === 3)).toBe(true);

    ws.sent = [];
    facade.awareness.setLocalState({ user: { id: "me" } });
    expect(ws.frames().some((f) => f.type === 1)).toBe(true);

    // An inbound query is answered with our own state.
    const ch = 0;
    ws.sent = [];
    ws.receiveFrame(ch, new Uint8Array([3]));
    expect(ws.frames().some((f) => f.type === 1)).toBe(true);
  });
});

describe("gateway connection — mux + reconnect", () => {
  it("facades of one project share one socket with distinct channels", () => {
    newProject();
    const docA = new Y.Doc();
    const docB = new Y.Doc();
    const a = new GatewayDocFacade(docA, facadeOpts("a.kicad_sch"));
    const b = new GatewayDocFacade(docB, facadeOpts("b.kicad_sch", true));
    track(a, docA);
    track(b, docB);
    expect(FakeWebSocket.instances.length).toBe(1);
    const ws = FakeWebSocket.instances[0]!;
    ws.open();
    const subs = ws.controls().filter((m) => m.t === "sub");
    expect(subs.length).toBe(2);
    expect(new Set(subs.map((m) => m.ch)).size).toBe(2);
  });

  it("reconnect re-subscribes with the CURRENT mode and re-syncs actives", async () => {
    newProject();
    const doc = new Y.Doc();
    const facade = new GatewayDocFacade(doc, facadeOpts("a.kicad_sch", true));
    track(facade, doc);
    const ws1 = FakeWebSocket.instances.at(-1)!;
    ws1.open();
    const ch = ws1.controls()[0]!.ch;
    // Activate (and settle the sync) on socket 1.
    const syncing = facade.activate();
    const step1 = ws1.frames().find((f) => f.type === 0)!;
    const serverDoc = new Y.Doc();
    cleanups.push(() => serverDoc.destroy());
    ws1.receiveFrame(ch, step2From(serverDoc, step1.frame));
    await syncing;

    vi.useFakeTimers();
    cleanups.push(() => vi.useRealTimers());
    ws1.drop();
    vi.advanceTimersByTime(1_000); // past the reconnect backoff
    const ws2 = FakeWebSocket.instances.at(-1)!;
    expect(ws2).not.toBe(ws1);
    ws2.open();
    // The once-passive sub comes back as ACTIVE, followed by a fresh Step1.
    expect(ws2.controls()[0]).toMatchObject({ t: "sub", mode: "active" });
    expect(ws2.frames().some((f) => f.type === 0)).toBe(true);
  });

  it("destroying the last facade closes the shared socket", () => {
    newProject();
    const doc = new Y.Doc();
    const facade = new GatewayDocFacade(doc, facadeOpts("a.kicad_sch"));
    const ws = FakeWebSocket.instances.at(-1)!;
    ws.open();
    facade.destroy();
    doc.destroy();
    expect(ws.readyState).toBe(FakeWebSocket.CLOSED);
  });
});
