import { describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { createThread, fileToDoc, kicadItemsMap, listThreads, docToY } from "@pcbjam/shared";
import { createComments, type CommentPinsModule } from "./comments";

/**
 * git-integration 0001: one controller per session bound to the PROJECT
 * comments document (threads) and the current FILE doc (items). Threads are
 * filtered by the bound document, new anchors are stamped with it, a sheet
 * switch rebinds without recreating the controller, and detached pins stay
 * off the canvas until asked for.
 */

const BOARD = `(kicad_pcb (version 20240108) (generator "pcbnew")
  (footprint "R" (layer "F.Cu") (uuid "aaaaaaaa-0000-0000-0000-000000000001") (at 10 20))
)
`;

function itemsDocFrom(text: string, path: string): Y.Doc {
  const doc = new Y.Doc();
  void path;
  docToY(fileToDoc(text), doc);
  return doc;
}

function stubMod() {
  const pushes: Array<Array<{ id: string }>> = [];
  const mod: CommentPinsModule = {
    kicadCollabSetPins(json) {
      pushes.push((JSON.parse(json) as { pins: Array<{ id: string }> }).pins);
    },
    kicadCollabSetViewport() {},
    kicadCollabGetViewport: () => JSON.stringify({ scale: 1, cx: 0, cy: 0, w: 100, h: 100 }),
  };
  return { mod, pushes, last: () => pushes[pushes.length - 1] ?? [] };
}

describe("project comments document binding", () => {
  it("lists only the bound document's threads and stamps new anchors with it", () => {
    const project = new Y.Doc();
    const board = itemsDocFrom(BOARD, "board.kicad_pcb");
    createThread(project, { anchor: { pos: { x: 1, y: 1 }, filePath: "root.kicad_sch" }, author: "a", body: "sch" });
    const { mod } = stubMod();
    const ctl = createComments({
      doc: project,
      itemsDoc: board,
      filePath: "board.kicad_pcb",
      mod,
      user: { id: "alice" },
      tool: "pcbnew",
    });
    expect(ctl.document()).toEqual({ filePath: "board.kicad_pcb" });
    expect(ctl.threads()).toEqual([]);

    const anchor = ctl.anchorAt({ x: 10e6, y: 20e6 }, 1e6);
    expect(anchor).toMatchObject({ itemUuid: "aaaaaaaa-0000-0000-0000-000000000001", filePath: "board.kicad_pcb" });
    const id = ctl.create({ pos: { x: 5, y: 5 } }, "on the board");
    const all = listThreads(project);
    expect(all).toHaveLength(2);
    expect(all.find((t) => t.id === id)?.anchor).toEqual({ pos: { x: 5, y: 5 }, filePath: "board.kicad_pcb" });
    ctl.destroy();
  });

  it("a drag keeps the thread's document even though the drop hands back a bare anchor", () => {
    const project = new Y.Doc();
    const board = itemsDocFrom(BOARD, "board.kicad_pcb");
    const { mod } = stubMod();
    const ctl = createComments({ doc: project, itemsDoc: board, filePath: "board.kicad_pcb", mod, user: { id: "a" }, tool: "pcbnew" });
    const id = ctl.create({ pos: { x: 1, y: 1 } }, "x");
    ctl.moveThread(id, { pos: { x: 9, y: 9 } });
    expect(listThreads(project)[0]!.anchor).toEqual({ pos: { x: 9, y: 9 }, filePath: "board.kicad_pcb" });
    ctl.destroy();
  });

  it("setDocument rebinds items + filter, keeps subscribers, notifies document listeners", () => {
    vi.useFakeTimers();
    try {
      const project = new Y.Doc();
      const a = itemsDocFrom(BOARD, "a.kicad_sch");
      const b = new Y.Doc();
      createThread(project, { anchor: { pos: { x: 1, y: 1 }, filePath: "a.kicad_sch" }, author: "a", body: "on a" });
      createThread(project, { anchor: { pos: { x: 2, y: 2 }, filePath: "b.kicad_sch" }, author: "a", body: "on b" });
      const { mod } = stubMod();
      const ctl = createComments({ doc: project, itemsDoc: a, filePath: "a.kicad_sch", mod, user: { id: "a" }, tool: "eeschema" });
      const seen: number[] = [];
      ctl.subscribe((t) => seen.push(t.length));
      const docs: Array<string | undefined> = [];
      ctl.subscribeDocument((f) => docs.push(f?.filePath));
      expect(ctl.threads().map((t) => t.messages[0]!.body)).toEqual(["on a"]);

      ctl.setDocument(b, "b.kicad_sch");
      expect(ctl.threads().map((t) => t.messages[0]!.body)).toEqual(["on b"]);
      expect(docs).toEqual(["b.kicad_sch"]);
      expect(seen).toEqual([1]);
      // Same document again → no-op.
      ctl.setDocument(b, "b.kicad_sch");
      expect(docs).toEqual(["b.kicad_sch"]);

      // Items observer follows the new doc: an item change on `b` schedules a push.
      kicadItemsMap(b).set("x", new Y.Map());
      vi.advanceTimersByTime(50);
      expect(seen.length).toBe(2);
      ctl.destroy();
    } finally {
      vi.useRealTimers();
    }
  });

  it("detached pins are left out of the GAL feed until setDetachedPinsVisible(true)", () => {
    vi.useFakeTimers();
    try {
      const project = new Y.Doc();
      const board = itemsDocFrom(BOARD, "board.kicad_pcb");
      const { mod, last } = stubMod();
      const ctl = createComments({ doc: project, itemsDoc: board, filePath: "board.kicad_pcb", mod, user: { id: "a" }, tool: "pcbnew" });
      const anchored = ctl.create(ctl.anchorAt({ x: 10e6, y: 20e6 }, 1e6), "tracked");
      const gone = ctl.create({ itemUuid: "nope", pos: { x: 3, y: 3 } }, "orphan");
      vi.advanceTimersByTime(50);
      const states = Object.fromEntries(ctl.threads().map((t) => [t.id, t.state]));
      expect(states).toEqual({ [anchored]: "anchored", [gone]: "detached" });
      expect(last().map((p) => p.id)).toEqual([anchored]);
      expect(ctl.detachedPinsVisible()).toBe(false);
      ctl.setDetachedPinsVisible(true);
      expect(last().map((p) => p.id).sort()).toEqual([anchored, gone].sort());
      ctl.setDetachedPinsVisible(false);
      expect(last().map((p) => p.id)).toEqual([anchored]);
      ctl.destroy();
    } finally {
      vi.useRealTimers();
    }
  });

  it("legacy single-doc shape (no itemsDoc / filePath) keeps every thread and bare anchors", () => {
    const doc = itemsDocFrom(BOARD, "board.kicad_pcb");
    createThread(doc, { anchor: { pos: { x: 1, y: 1 } }, author: "a", body: "legacy" });
    createThread(doc, { anchor: { pos: { x: 1, y: 1 }, filePath: "elsewhere.kicad_sch" }, author: "a", body: "other" });
    const { mod } = stubMod();
    const ctl = createComments({ doc, mod, user: { id: "a" }, tool: "pcbnew" });
    expect(ctl.document()).toBeUndefined();
    expect(ctl.threads()).toHaveLength(2);
    const id = ctl.create({ pos: { x: 2, y: 2 } }, "bare");
    expect(listThreads(doc).find((t) => t.id === id)?.anchor).toEqual({ pos: { x: 2, y: 2 } });
    ctl.destroy();
  });
});
