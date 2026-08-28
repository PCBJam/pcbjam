import { describe, expect, it, vi } from "vitest";
import type { GatewayFileChange } from "@pcbjam/shared";
import { createFilesHintRouter, startFilesWatch, type FilesWatchOptions } from "./files-watch";

const ch = (over: Partial<GatewayFileChange>): GatewayFileChange => ({
  path: "x.kicad_pro",
  revision: 2,
  origin: "editor",
  ...over,
});

function makeRouter(over: Partial<FilesWatchOptions> = {}) {
  const observed = new Map<string, number>();
  const restaged: string[] = [];
  const fetched: string[] = [];
  const events: string[] = [];
  const opts: FilesWatchOptions = {
    scopeId: "s",
    projectId: "p",
    provider: { kind: "none" },
    targetPath: "board.kicad_pcb",
    selfUser: "me",
    isRoomBacked: (p) => p.endsWith(".kicad_sch"),
    observedRevision: (p) => observed.get(p),
    rememberObserved: (p, r) => void observed.set(p, r),
    fetchBytes: async (p) => {
      fetched.push(p);
      return new Uint8Array([1]);
    },
    restage: (p) => void restaged.push(p),
    onNewPath: (p) => events.push(`new:${p}`),
    onTargetChanged: (c) => events.push(`target:${c.path}@${c.revision}`),
    onListingStale: () => events.push("stale"),
    log: () => {},
    debounceMs: 0,
    ...over,
  };
  const router = createFilesHintRouter(opts);
  router.seedKnown(["board.kicad_pcb", "x.kicad_pro", "root.kicad_sch"]);
  return { router, observed, restaged, fetched, events };
}

const tick = () => new Promise((r) => setTimeout(r, 5));

describe("files hint router (project-sync 0002 §3)", () => {
  it("Tier 1: a plain sibling is refetched + restaged once (debounced)", async () => {
    const { router, restaged, fetched, observed } = makeRouter();
    router.handle(1, [ch({ revision: 2, by: "peer" })]);
    router.handle(2, [ch({ revision: 3, by: "peer" })]);
    await tick();
    expect(fetched).toEqual(["x.kicad_pro"]);
    expect(restaged).toEqual(["x.kicad_pro"]);
    expect(observed.get("x.kicad_pro")).toBe(3);
  });

  it("own echo (by me, revision already observed from the PUT ack) is ignored", async () => {
    const { router, restaged, observed } = makeRouter();
    observed.set("x.kicad_pro", 2);
    router.handle(1, [ch({ revision: 2, by: "me" })]);
    await tick();
    expect(restaged).toEqual([]);
    // Same user, a DIFFERENT revision (another tab) is not an echo.
    router.handle(2, [ch({ revision: 3, by: "me" })]);
    await tick();
    expect(restaged).toEqual(["x.kicad_pro"]);
  });

  it("room-backed paths are never restaged from an EDITOR-origin row", async () => {
    const { router, restaged, events } = makeRouter();
    router.handle(1, [ch({ path: "root.kicad_sch", revision: 9, by: "peer" })]);
    await tick();
    expect(restaged).toEqual([]);
    expect(events).toEqual([]);
  });

  it("an upload/job over a room-backed path IS restaged and announced (0004 §2.5)", async () => {
    const events: string[] = [];
    const { router, restaged } = makeRouter({
      onRoomBackedChanged: (p) => events.push(`replaced:${p}`),
    });
    router.handle(1, [ch({ path: "root.kicad_sch", revision: 9, origin: "upload", by: "peer" })]);
    router.handle(2, [ch({ path: "root.kicad_sch", revision: 10, origin: "job" })]);
    await tick();
    expect(restaged).toEqual(["root.kicad_sch"]);
    expect(events).toEqual(["replaced:root.kicad_sch", "replaced:root.kicad_sch"]);
  });

  it("an upload over the room-backed open target only notifies", async () => {
    const { router, restaged, events } = makeRouter({
      targetPath: "root.kicad_sch",
      isRoomBacked: () => true,
    });
    router.handle(1, [ch({ path: "root.kicad_sch", revision: 9, origin: "upload", by: "peer" })]);
    await tick();
    expect(restaged).toEqual([]);
    expect(events).toEqual(["target:root.kicad_sch@9"]);
  });

  it("Tier 2: the open target on the PUT channel only notifies", async () => {
    const { router, restaged, events } = makeRouter({ isRoomBacked: () => false });
    router.handle(1, [ch({ path: "board.kicad_pcb", revision: 4, by: "peer" })]);
    await tick();
    expect(restaged).toEqual([]);
    expect(events).toEqual(["target:board.kicad_pcb@4"]);
  });

  it("a seq gap flags the listing stale; a new path is announced", async () => {
    const { router, events, restaged } = makeRouter();
    router.handle(5, [ch({ path: "sub.kicad_pro", revision: 1, by: "peer" })]);
    router.handle(8, []); // gap + oversized-batch shape
    await tick();
    expect(events).toEqual(["new:sub.kicad_pro", "stale"]);
    expect(restaged).toEqual(["sub.kicad_pro"]);
  });

  it("deleted rows are logged, not restaged", async () => {
    const log = vi.fn();
    const { router, restaged } = makeRouter({ log });
    router.handle(1, [ch({ revision: 0, deleted: true, origin: "job" })]);
    await tick();
    expect(restaged).toEqual([]);
    expect(log.mock.calls.some((c) => String(c[0]).includes("deleted"))).toBe(true);
  });

  it("destroy cancels pending restages", async () => {
    const { router, restaged } = makeRouter({ debounceMs: 20 });
    router.handle(1, [ch({ by: "peer" })]);
    router.destroy();
    await new Promise((r) => setTimeout(r, 40));
    expect(restaged).toEqual([]);
  });
});

describe("startFilesWatch", () => {
  it("wires the hint source to the router and tears both down", async () => {
    let cb: ((seq: number, c: GatewayFileChange[]) => void) | undefined;
    const destroy = vi.fn();
    const restaged: string[] = [];
    const handle = await startFilesWatch({
      scopeId: "s",
      projectId: "p",
      provider: { kind: "none" },
      knownPaths: [],
      isRoomBacked: () => false,
      observedRevision: () => undefined,
      rememberObserved: () => {},
      fetchBytes: async () => new Uint8Array(),
      restage: (p) => void restaged.push(p),
      log: () => {},
      debounceMs: 0,
      connect: async () => ({ onFiles: (f) => void (cb = f), destroy }),
    });
    expect(handle).toBeDefined();
    cb!(1, [ch({ path: "n.kicad_pro", by: "peer" })]);
    await tick();
    expect(restaged).toEqual(["n.kicad_pro"]);
    handle!.destroy();
    expect(destroy).toHaveBeenCalledTimes(1);
  });

  it("is a no-op without the gateway transport", async () => {
    const handle = await startFilesWatch({
      scopeId: "s",
      projectId: "p",
      provider: { kind: "broadcastchannel" },
      knownPaths: [],
      isRoomBacked: () => false,
      observedRevision: () => undefined,
      rememberObserved: () => {},
      fetchBytes: async () => new Uint8Array(),
      restage: () => {},
      log: () => {},
    });
    expect(handle).toBeUndefined();
  });
});
