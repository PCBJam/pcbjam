import { afterEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { docToFile, fileToDoc, seedDocToY, yToDoc } from "@pcbjam/shared";
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
    lb.syncFromSave(fileToDoc(board({ layers: L4, title: "Mine" })));
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
