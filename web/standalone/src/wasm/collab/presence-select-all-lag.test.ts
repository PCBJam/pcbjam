import { afterEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { Awareness, encodeAwarenessUpdate } from "y-protocols/awareness";
import { createPresence, resetPresenceColorClaims, type PresencePeer } from "./presence";
import { bindKicadPresence, type PresenceKicadWindow } from "./presence-kicad";

/**
 * REPRO (findings: "if user A selects everything, user B gets slow/laggy").
 *
 * Two amplifications stack on a big selection:
 *  1. WIRE — awareness is a single JSON blob per client. Every cursor tick
 *     (≤20/s) re-encodes the WHOLE state, selection included, so N selected
 *     items cost ~N×40 bytes per tick on the wire, per peer.
 *  2. BRIDGE — every awareness change (any peer's cursor move) rebuilds the
 *     full `kicadCollabSetRemote` snapshot (all peers' full selections) and
 *     the wasm side clears + redraws EVERY selection outline (pcbnew even
 *     recomputes hulls / polygons per item). The 30ms trailing throttle only
 *     coalesces bursts; a steady 20Hz cursor stream still means ~20 full
 *     redraws of N outlines per second on B.
 */

const uuids = (n: number): string[] =>
  Array.from({ length: n }, (_, i) => `${i.toString(16).padStart(8, "0")}-0000-0000-0000-000000000000`);

afterEach(() => {
  vi.useRealTimers();
  resetPresenceColorClaims();
});

describe("select-all amplification", () => {
  it("WIRE: one second of cursor motion after select-all stays inside the publish budget", () => {
    vi.useFakeTimers();
    const doc = new Y.Doc();
    const awareness = new Awareness(doc);
    const presence = createPresence({
      awareness,
      user: { id: "alice", name: "alice", color: "#000" },
      tool: "eeschema",
    });
    let bytes = 0;
    let updates = 0;
    awareness.on("update", ({ updated }: { updated: number[] }) => {
      if (!updated.includes(awareness.clientID)) return;
      updates++;
      bytes += encodeAwarenessUpdate(awareness, [awareness.clientID]).byteLength;
    });

    const drive = () => {
      bytes = 0;
      updates = 0;
      for (let i = 0; i < 20; i++) {
        presence.setCursor({ x: i, y: i });
        vi.advanceTimersByTime(50);
      }
      vi.advanceTimersByTime(2500);
      return { bytes, updates };
    };

    presence.setSelection([]);
    const small = drive();
    // No selection: every tick publishes as before (unthrottled).
    expect(small.updates).toBe(20);

    presence.setSelection(uuids(3000)); // select-all on a mid-size board
    const big = drive();
    // eslint-disable-next-line no-console
    console.log(`awareness cursor motion/s: empty sel ${small.updates}×=${small.bytes}B, 3000-item sel ${big.updates}×=${big.bytes}B`);
    // Was 20 × 117 KB ≈ 2.3 MB/s. The size-aware trailing throttle keeps a
    // select-all peer's cursor traffic near the 128 KB/s budget while the
    // last cursor position still lands (trailing edge).
    expect(big.bytes).toBeLessThan(400 * 1024);
    expect(big.updates).toBeGreaterThanOrEqual(1);
    expect(big.updates).toBeLessThan(6);
    expect((awareness.getLocalState() as { cursor: { x: number } }).cursor.x).toBe(19);
    presence.destroy();
    awareness.destroy();
  });

  it("BRIDGE: every peer cursor move re-pushes all N selection uuids to wasm", () => {
    vi.useFakeTimers();
    const setRemote = vi.fn<(json: string) => void>();
    const setCursors = vi.fn<(json: string) => void>();
    const mod = {
      kicadCollabPresenceStart: vi.fn(),
      kicadCollabSetRemote: setRemote,
      kicadCollabSetRemoteCursors: setCursors,
      kicadCollabGetViewport: vi.fn(() => '{"cx":0,"cy":0,"scale":1,"w":800,"h":600}'),
      kicadCollabGetSelection: vi.fn(() => "[]"),
    };
    const subscribers = new Set<(p: PresencePeer[]) => void>();
    let peers: PresencePeer[] = [];
    const presence = {
      peers: () => peers,
      clients: () => peers,
      self: () => ({ userId: "bob", clientId: 100 }),
      subscribe(cb: (p: PresencePeer[]) => void) {
        subscribers.add(cb);
        return () => subscribers.delete(cb);
      },
      setCursor: vi.fn(),
      setSelection: vi.fn(),
      setViewport: vi.fn(),
      colorOf: () => "#000",
      destroy: vi.fn(),
    };
    const win: PresenceKicadWindow = {};
    bindKicadPresence({ mod, win, presence });
    setRemote.mockClear();

    const selection = uuids(3000);
    const alice = (cursor: { x: number; y: number }): PresencePeer => ({
      clientId: 1,
      user: { id: "alice", name: "alice", color: "#000" },
      tool: "eeschema",
      cursor,
      selection,
      updatedAt: Date.now(),
    });

    // alice moves her mouse for one second at the 20Hz emit cadence.
    for (let i = 0; i < 20; i++) {
      peers = [alice({ x: i, y: i })];
      for (const cb of subscribers) cb(peers);
      vi.advanceTimersByTime(50);
    }
    vi.advanceTimersByTime(100);

    const pushes = setRemote.mock.calls.length;
    const bytes = setRemote.mock.calls.reduce((s, [json]) => s + json.length, 0);
    const uuidsPushed = setRemote.mock.calls.reduce(
      (s, [json]) => s + (JSON.parse(json) as { peers: { selection: string[] }[] }).peers[0]!.selection.length,
      0,
    );
    // eslint-disable-next-line no-console
    console.log(`bridge: ${pushes} full setRemote pushes (${bytes}B JSON, ${uuidsPushed} uuids), ${setCursors.mock.calls.length} cursor-only pushes per second of cursor motion`);

    // Cursor-only changes must not re-ship (and the wasm side re-resolve +
    // redraw) the unchanged 3000-item selection 20×/s: ONE full snapshot
    // introduces the selection, the ticks ride the cursor-only entry point.
    expect(uuidsPushed).toBeLessThan(selection.length * 2);
    expect(setCursors.mock.calls.length).toBeGreaterThanOrEqual(15);
    const last = JSON.parse(setCursors.mock.calls.at(-1)![0]) as { cursors: { id: string; cursor: { x: number } }[] };
    expect(last.cursors[0]).toEqual({ id: "alice", cursor: { x: 19, y: 19 } });
  });
});
