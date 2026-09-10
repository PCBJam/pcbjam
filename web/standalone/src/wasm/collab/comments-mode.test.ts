import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { createThread, addMessage, listThreads } from "@pcbjam/shared";
import { createComments, type CommentPinsModule } from "./comments";

/**
 * Comment capability modes (comments-ux 0003 §4.5): "comment" sessions post
 * one REST op per action (never touching the ydoc — their socket would drop
 * the write anyway) under the commenter doc rules; "read" sessions are inert.
 */

function stubMod(): CommentPinsModule {
  return {
    kicadCollabSetPins() {},
    kicadCollabSetViewport() {},
    kicadCollabGetViewport: () => JSON.stringify({ scale: 1, cx: 0, cy: 0, w: 100, h: 100 }),
  };
}

const rest = { apiBase: "http://api.test", scope: "team", project: "board", docPath: "a/b.kicad_pcb" };

function seed(doc: Y.Doc) {
  const own = createThread(doc, { anchor: { pos: { x: 1, y: 1 } }, author: "guest", body: "mine", now: 1 });
  const theirs = createThread(doc, { anchor: { pos: { x: 2, y: 2 } }, author: "owner", body: "theirs", now: 2 });
  const reply = addMessage(doc, own, { author: "owner", body: "owner reply", now: 3 })!;
  return { own, theirs, reply };
}

describe("comment mode (REST writer)", () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    fetchMock.mockReset();
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({}) });
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  const lastOp = () => JSON.parse(fetchMock.mock.calls.at(-1)![1].body as string).op;

  it("posts ops to the document's comment route with credentials, never writing the ydoc", () => {
    const doc = new Y.Doc();
    const ctl = createComments({ doc, mod: stubMod(), user: { id: "guest" }, tool: "pcbnew", mode: "comment", rest });
    const id = ctl.create({ pos: { x: 5, y: 5 } }, "hello", ["owner"]);
    expect(id).toMatch(/^[A-Za-z0-9_-]{8,40}$/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("http://api.test/api/scopes/team/projects/board/files/a/b.kicad_pcb/comments");
    expect(init.method).toBe("POST");
    expect(init.credentials).toBe("include");
    expect(lastOp()).toEqual({ type: "createThread", anchor: { pos: { x: 5, y: 5 } }, body: "hello", mentions: ["owner"], id });
    // The local doc is untouched — the echo is the only way the thread appears.
    expect(listThreads(doc).length).toBe(0);
    ctl.destroy();
  });

  it("applies the commenter doc rules locally before posting", () => {
    const doc = new Y.Doc();
    const { own, theirs, reply } = seed(doc);
    const errors: string[] = [];
    const ctl = createComments({ doc, mod: stubMod(), user: { id: "guest" }, tool: "pcbnew", mode: "comment", rest });
    ctl.subscribeErrors((m) => errors.push(m));

    const ownThread = listThreads(doc).find((t) => t.id === own)!;
    const theirThread = listThreads(doc).find((t) => t.id === theirs)!;
    expect(ctl.canManageThread(ownThread)).toBe(true);
    expect(ctl.canManageThread(theirThread)).toBe(false);
    expect(ctl.canEditMessage(ownThread, ownThread.rootId)).toBe(true);
    expect(ctl.canEditMessage(ownThread, reply)).toBe(false);

    // Others' message: refused locally, nothing posted.
    expect(ctl.edit(own, reply, "x")).toBe(false);
    expect(ctl.remove(own, reply)).toBe(false);
    ctl.setResolved(theirs, true);
    ctl.moveThread(theirs, { pos: { x: 0, y: 0 } });
    expect(fetchMock).not.toHaveBeenCalled();

    // Own root with a foreign reply: can't be deleted (mirrors the server's 409).
    expect(ctl.remove(own, ownThread.rootId)).toBe(false);
    ctl.deleteThread(own);
    expect(errors.length).toBe(2);
    expect(fetchMock).not.toHaveBeenCalled();

    // Allowed ops post the matching op shapes.
    expect(ctl.edit(own, ownThread.rootId, "edited")).toBe(true);
    expect(lastOp()).toMatchObject({ type: "editMessage", threadId: own, messageId: ownThread.rootId, body: "edited" });
    ctl.setResolved(own, true);
    expect(lastOp()).toEqual({ type: "setResolved", threadId: own, resolved: true });
    ctl.moveThread(own, { pos: { x: 9, y: 9 } });
    expect(lastOp()).toEqual({ type: "setAnchor", threadId: own, anchor: { pos: { x: 9, y: 9 } } });
    ctl.reply(theirs, "a reply", []);
    expect(lastOp()).toMatchObject({ type: "addMessage", threadId: theirs, body: "a reply" });
    ctl.toggleReaction(theirs, theirThread.rootId, "👍");
    expect(lastOp()).toEqual({ type: "toggleReaction", threadId: theirs, messageId: theirThread.rootId, emoji: "👍" });
    ctl.markSeen(theirs);
    expect(lastOp()).toEqual({ type: "markSeen", threadId: theirs });
    ctl.destroy();
  });

  it("surfaces REST rejections through subscribeErrors", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 429,
      json: async () => ({ message: "too many comment operations" }),
    });
    const doc = new Y.Doc();
    const errors: Array<[string, number]> = [];
    const ctl = createComments({ doc, mod: stubMod(), user: { id: "guest" }, tool: "pcbnew", mode: "comment", rest });
    ctl.subscribeErrors((m, s) => errors.push([m, s]));
    ctl.create({ pos: { x: 1, y: 1 } }, "x");
    await vi.waitFor(() => expect(errors).toEqual([["too many comment operations", 429]]));
    ctl.destroy();
  });
});

describe("read mode", () => {
  it("renders threads but every mutator is inert", () => {
    const doc = new Y.Doc();
    const { own } = seed(doc);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const ctl = createComments({ doc, mod: stubMod(), user: { id: "local-user" }, tool: "pcbnew", mode: "read" });
    expect(ctl.mode()).toBe("read");
    expect(ctl.threads().length).toBe(2);
    expect(ctl.create({ pos: { x: 1, y: 1 } }, "nope")).toBe("");
    ctl.reply(own, "nope");
    ctl.setResolved(own, true);
    ctl.deleteThread(own);
    expect(ctl.canManageThread(ctl.threads()[0]!)).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(listThreads(doc).length).toBe(2);
    expect(listThreads(doc).find((t) => t.id === own)!.resolved).toBe(false);
    ctl.destroy();
    vi.unstubAllGlobals();
  });
});

describe("write mode (unchanged)", () => {
  it("writes straight into the ydoc", () => {
    const doc = new Y.Doc();
    const ctl = createComments({ doc, mod: stubMod(), user: { id: "owner", name: "Owner" }, tool: "pcbnew" });
    expect(ctl.mode()).toBe("write");
    const id = ctl.create({ pos: { x: 1, y: 1 } }, "direct");
    expect(listThreads(doc).find((t) => t.id === id)?.messages[0]?.authorName).toBe("Owner");
    ctl.destroy();
  });
});
