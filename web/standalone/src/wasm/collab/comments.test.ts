import { describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { createComments } from "./comments";

describe("comments owner lifetime", () => {
  it("makes an accepted jump ticket inert when its controller is destroyed", async () => {
    const guards: Array<() => boolean> = [];
    const setViewport = Object.assign(vi.fn(), {
      __wxGuardedCall: vi.fn((_args: unknown[], isCurrent: () => boolean) => {
        guards.push(isCurrent);
        return Promise.resolve();
      }),
    });
    const doc = new Y.Doc();
    const controller = createComments({
      doc,
      mod: {
        kicadCollabSetPins: vi.fn(async () => undefined),
        kicadCollabSetViewport: setViewport,
        kicadCollabGetViewport: vi.fn(async () => "{}"),
      },
      user: { id: "me" },
      tool: "pcbnew",
      projectPins: async () => {},
    });
    const threadId = controller.create({ pos: { x: 12, y: 34 } }, "note");
    await new Promise((resolve) => setTimeout(resolve, 40));

    controller.jumpTo(threadId);
    expect(guards).toHaveLength(1);
    expect(guards[0]!()).toBe(true);
    controller.destroy();
    expect(guards[0]!()).toBe(false);
    expect(setViewport).not.toHaveBeenCalled();
    doc.destroy();
  });

  it("cannot let an old controller clear a newer sheet's pins", async () => {
    let generation = 1;
    const published: string[] = [];
    const projectPins = async (json: string, isCurrent: () => boolean) => {
      if (isCurrent()) published.push(json);
    };
    const module = {
      kicadCollabSetPins: vi.fn(async () => undefined),
      kicadCollabSetViewport: vi.fn(async () => undefined),
      kicadCollabGetViewport: vi.fn(async () => "{}"),
    };
    const oldDoc = new Y.Doc();
    const oldController = createComments({
      doc: oldDoc,
      mod: module,
      user: { id: "me" },
      tool: "pcbnew",
      isCurrent: () => generation === 1,
      projectPins,
    });

    generation = 2;
    const newDoc = new Y.Doc();
    const newController = createComments({
      doc: newDoc,
      mod: module,
      user: { id: "me" },
      tool: "pcbnew",
      isCurrent: () => generation === 2,
      projectPins,
    });
    const beforeOldDestroy = published.length;
    oldController.destroy();
    await Promise.resolve();

    expect(published).toHaveLength(beforeOldDestroy);
    newController.destroy();
    oldDoc.destroy();
    newDoc.destroy();
  });
});
