import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { docToFile, EMBEDDED_FILES_ROOM_BUDGET, fileToDoc, seedDocToY, yToDoc } from "@pcbjam/shared";
import { EMBEDDED_TOO_LARGE_EVENT, type EmbeddedTooLargeDetail } from "./sync-limits";
import { pcbHeaderAdapter, startLayoutSync, type HeaderModule, type HeaderWindow } from "./header-sync";

const L2 = `(layers (0 "F.Cu" signal) (2 "B.Cu" signal) (25 "Edge.Cuts" user))`;
const L4 = `(layers (0 "F.Cu" signal) (4 "In1.Cu" signal) (6 "In2.Cu" signal) (2 "B.Cu" signal) (25 "Edge.Cuts" user))`;
const header = (o: { layers?: string; title?: string; paper?: string } = {}) =>
  `(kicad_pcb (version 20241229) (generator "pcbnew") (general (thickness 1.6)) (paper "${o.paper ?? "A4"}") (title_block (title "${o.title ?? "T"}")) ${o.layers ?? L2} (setup (pad_to_mask_clearance 0)))`;
const board = (o: Parameters<typeof header>[0] = {}) =>
  header(o).slice(0, -1) +
  ` (segment (start 0 0) (end 1 1) (width 0.25) (layer "F.Cu") (uuid "seg-1")))`;

/** A native pcbnew stand-in: its header text, the apply export, the dialog guard. */
function nativeBoard(initial: string) {
  let text = initial;
  let blocked = false;
  const win: HeaderWindow = {};
  const mod: HeaderModule & { applied: string[] } = {
    applied: [],
    kicadCollabHeaderText: () => text,
    kicadCollabApplyHeader: (t) => {
      mod.applied.push(t);
      text = t;
    },
    kicadCollabHeaderBlocked: () => blocked,
  };
  return {
    win,
    mod,
    /** A local Board Setup / Page Settings edit: OnModify → onHeader. */
    edit(next: string) {
      text = next;
      win.kicadCollab?.onHeader?.(next);
    },
    setBlocked: (b: boolean) => void (blocked = b),
    text: () => text,
  };
}

function pair() {
  const a = new Y.Doc();
  const b = new Y.Doc();
  a.on("update", (u: Uint8Array) => Y.applyUpdate(b, u, "relay"));
  b.on("update", (u: Uint8Array) => Y.applyUpdate(a, u, "relay"));
  return { a, b };
}

const flush = () => new Promise<void>((r) => queueMicrotask(r));

afterEach(() => vi.useRealTimers());

describe("live board-header sync (proposal 21 WP4)", () => {
  it("a Board Setup layer change reaches the room WITHOUT a save, and the open peer's board", async () => {
    const { a, b } = pair();
    const initial = fileToDoc(board());
    seedDocToY(initial, a, "seed", "n");
    const na = nativeBoard(header());
    const nb = nativeBoard(header());
    startLayoutSync({ doc: a, header: pcbHeaderAdapter(na.mod), win: na.win, baseline: initial });
    startLayoutSync({ doc: b, header: pcbHeaderAdapter(nb.mod), win: nb.win, baseline: initial });

    na.edit(header({ layers: L4 }));
    expect(docToFile(yToDoc(a))).toContain('"In1.Cu"'); // the room has it (case 1)
    await flush();
    expect(nb.mod.applied).toHaveLength(1); // the peer's native board got it (case 2)
    expect(nb.text()).toContain('"In1.Cu"');
    expect(na.mod.applied).toHaveLength(0); // no echo to the author
    // Items are untouched by a header-only sync.
    expect(yToDoc(b).items["seg-1"]).toBeDefined();
  });

  it("the peer's later save does not revert the applied header (shared baseline)", async () => {
    const { a, b } = pair();
    const initial = fileToDoc(board());
    seedDocToY(initial, a, "seed", "n");
    const na = nativeBoard(header());
    const nb = nativeBoard(header());
    startLayoutSync({ doc: a, header: pcbHeaderAdapter(na.mod), win: na.win, baseline: initial });
    const lb = startLayoutSync({ doc: b, header: pcbHeaderAdapter(nb.mod), win: nb.win, baseline: initial });
    na.edit(header({ layers: L4 }));
    await flush();
    // B saves (its native now carries L4) with a title change of its own.
    lb.syncFromSave(fileToDoc(board({ layers: L4, title: "Mine" })), "board.kicad_pcb");
    const text = docToFile(yToDoc(a));
    expect(text).toContain('"In1.Cu"');
    expect(text).toContain('(title "Mine")');
  });

  it("paper/title edits (Page Settings) sync the same way (SYNC-06a)", async () => {
    const { a, b } = pair();
    const initial = fileToDoc(board());
    seedDocToY(initial, a, "seed", "n");
    const na = nativeBoard(header());
    const nb = nativeBoard(header());
    startLayoutSync({ doc: a, header: pcbHeaderAdapter(na.mod), win: na.win, baseline: initial });
    startLayoutSync({ doc: b, header: pcbHeaderAdapter(nb.mod), win: nb.win, baseline: initial });
    na.edit(header({ paper: "A3", title: "Remote title" }));
    await flush();
    expect(nb.text()).toContain('(paper "A3")');
    expect(nb.text()).toContain("Remote title");
  });

  it("stale title vs revision: both survive (SYNC-06b through the live path)", async () => {
    const { a, b } = pair();
    const initial = fileToDoc(board());
    seedDocToY(initial, a, "seed", "n");
    const na = nativeBoard(header());
    const nb = nativeBoard(header());
    startLayoutSync({ doc: a, header: pcbHeaderAdapter(na.mod), win: na.win, baseline: initial });
    startLayoutSync({ doc: b, header: pcbHeaderAdapter(nb.mod), win: nb.win, baseline: initial });
    nb.setBlocked(true); // B has a dialog open: the peer title waits…
    na.edit(header({ title: "Remote title" }));
    await flush();
    // …B edits another field of its (stale) title block meanwhile.
    nb.edit(header().replace('(title "T")', '(title "T") (rev "2")'));
    const text = docToFile(yToDoc(a));
    expect(text).toContain('(title "Remote title")');
    expect(text).toContain('(rev "2")');
  });

  it("an apply waits while Board Setup is open, then lands", async () => {
    vi.useFakeTimers();
    const { a, b } = pair();
    const initial = fileToDoc(board());
    seedDocToY(initial, a, "seed", "n");
    const na = nativeBoard(header());
    const nb = nativeBoard(header());
    startLayoutSync({ doc: a, header: pcbHeaderAdapter(na.mod), win: na.win, baseline: initial });
    startLayoutSync({ doc: b, header: pcbHeaderAdapter(nb.mod), win: nb.win, baseline: initial });
    nb.setBlocked(true);
    na.edit(header({ layers: L4 }));
    await vi.runAllTicks();
    expect(nb.mod.applied).toHaveLength(0);
    nb.setBlocked(false);
    await vi.advanceTimersByTimeAsync(1000);
    expect(nb.mod.applied).toHaveLength(1);
  });

  it("a read-only session never emits or applies", async () => {
    const { a, b } = pair();
    const initial = fileToDoc(board());
    seedDocToY(initial, a, "seed", "n");
    const na = nativeBoard(header());
    const nb = nativeBoard(header());
    startLayoutSync({ doc: a, header: pcbHeaderAdapter(na.mod), win: na.win, baseline: initial });
    startLayoutSync({ doc: b, header: pcbHeaderAdapter(nb.mod), win: nb.win, baseline: initial, readOnly: true });
    na.edit(header({ layers: L4 }));
    await flush();
    expect(nb.mod.applied).toHaveLength(0);
    expect(nb.win.kicadCollab?.onHeader).toBeUndefined();
  });
});

describe("decodeSchHeader (eeschema apply payload)", () => {
  it("decodes paper and title block into the setters' shape", async () => {
    const { decodeSchHeader } = await import("./header-sync");
    expect(
      decodeSchHeader(
        `(kicad_sch (version 20250114) (generator "eeschema") (paper "User" 200 100 portrait) (title_block (title "T") (rev "2") (comment 1 "one") (comment 3 "three")))`,
      ),
    ).toEqual({
      paper: { type: "User", w: 200, h: 100, portrait: true },
      title: { title: "T", rev: "2", comments: [[1, "one"], [3, "three"]] },
    });
  });
});

describe("live embedded fonts (fonts 0001, embedded_sync.h)", () => {
  const FONT = `(file (name "Zapfino.ttf") (type font) (data |KLUv/QBYAQ==|) (checksum "AB"))`;
  const emitted = (files = FONT) =>
    `(kicad_pcb (version 20241229) (generator "pcbnew") (embedded_fonts yes) (embedded_files ${files}))`;

  it("a font embedded as a text uses it reaches the room without a save; the peer's save keeps it", () => {
    const { a, b } = pair();
    const initial = fileToDoc(board());
    seedDocToY(initial, a, "seed", "n");
    const na = nativeBoard(header());
    const nb = nativeBoard(header());
    startLayoutSync({ doc: a, header: pcbHeaderAdapter(na.mod), win: na.win, baseline: initial, embedded: true });
    const peer = startLayoutSync({ doc: b, header: pcbHeaderAdapter(nb.mod), win: nb.win, baseline: initial, embedded: true });

    na.win.kicadCollab!.onEmbedded!("/p/board.kicad_pcb", emitted());
    expect(docToFile(yToDoc(b))).toContain('(name "Zapfino.ttf")');
    expect(docToFile(yToDoc(b))).toContain("(embedded_fonts yes)");

    // The peer never loaded the font; its save carries neither head and removes nothing.
    peer.syncFromSave(fileToDoc(board()), "board.kicad_pcb");
    expect(docToFile(yToDoc(a))).toContain('(name "Zapfino.ttf")');
  });

  describe("past the room budget (EMBEDDED_FILES_ROOM_BUDGET)", () => {
    const BIG = `(file (name "big.ttf") (type font) (data |${"A".repeat(EMBEDDED_FILES_ROOM_BUDGET + 1024)}|) (checksum "CD"))`;
    const notices: EmbeddedTooLargeDetail[] = [];
    let prevWindow: unknown;
    beforeEach(() => {
      notices.length = 0;
      prevWindow = (globalThis as { window?: unknown }).window;
      const win = new EventTarget();
      win.addEventListener(EMBEDDED_TOO_LARGE_EVENT, (e) => notices.push((e as CustomEvent<EmbeddedTooLargeDetail>).detail));
      (globalThis as { window?: unknown }).window = win;
    });
    afterEach(() => {
      (globalThis as { window?: unknown }).window = prevWindow;
    });
    const roomFiles = (doc: Y.Doc) => [...docToFile(yToDoc(doc)).matchAll(/\(name "([^"]+\.ttf)"\)/g)].map((m) => m[1]);

    it("live: the room keeps its files and the user is told; the files that fit sync once some are removed", () => {
      const { a } = pair();
      const initial = fileToDoc(board());
      seedDocToY(initial, a, "seed", "n");
      const na = nativeBoard(header());
      startLayoutSync({ doc: a, header: pcbHeaderAdapter(na.mod), win: na.win, baseline: initial, embedded: true });

      na.win.kicadCollab!.onEmbedded!("/p/board.kicad_pcb", emitted(FONT + BIG));
      expect(roomFiles(a)).toEqual([]);
      expect(notices).toEqual([
        { docPath: "/p/board.kicad_pcb", bytes: expect.any(Number) as number, budget: EMBEDDED_FILES_ROOM_BUDGET },
      ]);
      expect(notices[0]!.bytes).toBeGreaterThan(EMBEDDED_FILES_ROOM_BUDGET);

      // The user removes the big file: the font that fits reaches the room.
      na.win.kicadCollab!.onEmbedded!("/p/board.kicad_pcb", emitted(FONT));
      expect(roomFiles(a)).toEqual(["Zapfino.ttf"]);
      expect(notices).toHaveLength(1);
    });

    it("save: the rest of the save syncs, the embedded files do not; a later save that fits does", () => {
      const { a } = pair();
      const initial = fileToDoc(board());
      seedDocToY(initial, a, "seed", "n");
      const na = nativeBoard(header());
      const sync = startLayoutSync({ doc: a, header: pcbHeaderAdapter(na.mod), win: na.win, baseline: initial });
      const withFiles = (files: string) =>
        fileToDoc(board({ title: "Saved" }).replace(/\)\s*$/, ` (embedded_fonts yes) (embedded_files ${files}))`));

      sync.syncFromSave(withFiles(FONT + BIG), "board.kicad_pcb");
      expect(docToFile(yToDoc(a))).toContain('(title "Saved")');
      expect(roomFiles(a)).toEqual([]);
      expect(notices.map((n) => n.docPath)).toEqual(["board.kicad_pcb"]);

      sync.syncFromSave(withFiles(FONT), "board.kicad_pcb");
      expect(roomFiles(a)).toEqual(["Zapfino.ttf"]);
    });
  });

  it("is off unless asked for, and off for a read-only session", () => {
    const off = nativeBoard(header());
    startLayoutSync({ doc: new Y.Doc(), header: pcbHeaderAdapter(off.mod), win: off.win });
    expect(off.win.kicadCollab?.onEmbedded).toBeUndefined();
    const ro = nativeBoard(header());
    startLayoutSync({ doc: new Y.Doc(), header: pcbHeaderAdapter(ro.mod), win: ro.win, embedded: true, readOnly: true });
    expect(ro.win.kicadCollab?.onEmbedded).toBeUndefined();
  });

  it("destroy unregisters the hook", () => {
    const n = nativeBoard(header());
    const sync = startLayoutSync({ doc: new Y.Doc(), header: pcbHeaderAdapter(n.mod), win: n.win, embedded: true });
    expect(n.win.kicadCollab?.onEmbedded).toBeTypeOf("function");
    sync.destroy();
    expect(n.win.kicadCollab?.onEmbedded).toBeUndefined();
  });
});
