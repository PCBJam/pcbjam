import { describe, expect, it, vi } from "vitest";
import * as Y from "yjs";

const { restageFile } = vi.hoisted(() => ({ restageFile: vi.fn() }));
vi.mock("../kicad-runner", () => ({ restageFile }));

import { memfsFilePath } from "../constants";
import { sidecarPathsFor, startSidecarRooms } from "./sidecar-rooms";

/** One shared room per path, two tabs; updates relay synchronously between docs. */
function roomHub() {
  const docs = new Map<string, Y.Doc[]>();
  return (tabDocs: Map<string, Y.Doc>) =>
    async ({ room }: { room: string }) => {
      const doc = new Y.Doc();
      const peers = docs.get(room) ?? [];
      for (const p of peers) Y.applyUpdate(doc, Y.encodeStateAsUpdate(p));
      doc.on("update", (u: Uint8Array, origin: unknown) => {
        if (origin === "relay") return;
        for (const p of docs.get(room) ?? []) if (p !== doc) Y.applyUpdate(p, u, "relay");
      });
      peers.push(doc);
      docs.set(room, peers);
      tabDocs.set(room, doc);
      return { doc, provider: { destroy: () => {}, awareness: { setLocalState: () => {} } } } as never;
    };
}

const PRO = (clearance: string, severity: string) =>
  `{\n  "erc": {\n    "pin_not_connected": "${severity}"\n  },\n  "net_settings": {\n    "classes": [\n      {\n        "clearance": ${clearance},\n        "name": "Default"\n      }\n    ]\n  }\n}\n`;

function tab(hub: ReturnType<typeof roomHub>, staged: string) {
  const files = new Map([[memfsFilePath("s", "p/b.kicad_pro"), staged]]);
  const restaged: string[] = [];
  const docs = new Map<string, Y.Doc>();
  const start = () =>
    startSidecarRooms({
      win: {
        FS: {
          readFile: (p: string) => {
            const f = files.get(p);
            if (f === undefined) throw new Error("ENOENT");
            return f;
          },
        },
      },
      slug: "s",
      scopeId: "S",
      projectId: "P",
      paths: ["p/b.kicad_pro"],
      provider: { kind: "none" } as never,
      log: () => {},
      onRestaged: (_p, text) => restaged.push(text),
      connect: hub(docs) as never,
    });
  return { start, restaged };
}

describe("project sidecar rooms (proposal 21 WP5)", () => {
  it("derives the sidecars of a board and a schematic", () => {
    expect(sidecarPathsFor("pcbnew", "p/b.kicad_pcb")).toEqual(["p/b.kicad_pro", "p/b.kicad_dru"]);
    expect(sidecarPathsFor("eeschema", "p/b.kicad_sch")).toEqual(["p/b.kicad_pro"]);
    expect(sidecarPathsFor("pl_editor", "p/x.kicad_wks")).toEqual([]);
  });

  it("a save seeds/patches the room; the open peer gets it restaged + reloaded, per key", async () => {
    vi.useFakeTimers();
    const hub = roomHub();
    const a = tab(hub, PRO("0.2", "error"));
    const b = tab(hub, PRO("0.2", "error"));
    const ra = await a.start();
    const rb = await b.start();
    expect(ra.isRoomPath("p/b.kicad_pro")).toBe(true);

    // A: Board Setup netclass change (first save seeds the empty room).
    expect(ra.onSaved("p/b.kicad_pro", PRO("0.3", "error"))).toBe(true);
    await vi.advanceTimersByTimeAsync(400);
    expect(b.restaged.at(-1)).toBe(PRO("0.3", "error"));

    // B (native now 0.3): ERC severity change, merged per key.
    rb.onSaved("p/b.kicad_pro", PRO("0.3", "warning"));
    await vi.advanceTimersByTimeAsync(400);
    expect(a.restaged.at(-1)).toBe(PRO("0.3", "warning"));
    vi.useRealTimers();
  });

  it("a stale writer's other-key edit does not revert the peer's (per-key merge)", async () => {
    vi.useFakeTimers();
    const hub = roomHub();
    const a = tab(hub, PRO("0.2", "error"));
    const b = tab(hub, PRO("0.2", "error"));
    const ra = await a.start();
    const rb = await b.start();
    ra.onSaved("p/b.kicad_pro", PRO("0.2", "error")); // seed
    ra.onSaved("p/b.kicad_pro", PRO("0.3", "error"));
    // B saves BEFORE its debounced restage ran — still holding clearance 0.2.
    rb.onSaved("p/b.kicad_pro", PRO("0.2", "warning"));
    await vi.advanceTimersByTimeAsync(400);
    expect(a.restaged.at(-1)).toBe(PRO("0.3", "warning"));
    vi.useRealTimers();
  });

  it("paths it does not watch are left to the upload path", async () => {
    const hub = roomHub();
    const r = await tab(hub, PRO("0.2", "error")).start();
    expect(r.onSaved("p/other.kicad_pro", "{}")).toBe(false);
    expect(r.isRoomPath("p/b.kicad_dru")).toBe(false);
  });
});
