import { describe, expect, it } from "vitest";
import {
  canChooseMode,
  requestedMode,
  resolveCommentAccess,
  resolveReadOnly,
  type ReadOnlyWindow,
} from "./read-only-mode";

/**
 * Read-only session resolution (read-only-viewer): the server-granted
 * `access` capability decides; `?readonly=1` can only NARROW (force viewer
 * mode for tests / authz-free deployments), never widen.
 */

function fakeWin(search = ""): ReadOnlyWindow {
  return { location: { search } };
}

describe("resolveReadOnly", () => {
  it("follows the server capability", () => {
    expect(resolveReadOnly("read", fakeWin())).toBe(true);
    expect(resolveReadOnly("write", fakeWin())).toBe(false);
  });

  it("treats an absent capability as writable (authz-free backends)", () => {
    expect(resolveReadOnly(undefined, fakeWin())).toBe(false);
  });

  it("?readonly=1 forces viewer mode regardless of capability", () => {
    expect(resolveReadOnly(undefined, fakeWin("?readonly=1"))).toBe(true);
    expect(resolveReadOnly("write", fakeWin("?foo=bar&readonly=true"))).toBe(true);
  });

  it("has no ?readonly=0 escape — a URL never widens a server grant", () => {
    expect(resolveReadOnly("read", fakeWin("?readonly=0"))).toBe(true);
    expect(resolveReadOnly("read", fakeWin("?readonly=false"))).toBe(true);
  });

  it("a commenter session (comments-ux 0003) is read-only for the frame", () => {
    expect(resolveReadOnly("comment", fakeWin())).toBe(true);
  });
});

describe("resolveCommentAccess", () => {
  it("writers comment into the ydoc, commenters through the REST route, readers not at all", () => {
    expect(resolveCommentAccess("write", false)).toBe("write");
    expect(resolveCommentAccess(undefined, false)).toBe("write");
    expect(resolveCommentAccess("comment", true)).toBe("comment");
    expect(resolveCommentAccess("read", true)).toBe("none");
  });

  it("?readonly=1 on a writer never yields comment access (no widening, no REST for members)", () => {
    expect(resolveCommentAccess("write", true)).toBe("none");
  });
});

describe("?mode= (mobile 0002)", () => {
  it("view/comment narrow a writer; edit does not", () => {
    expect(resolveReadOnly("write", fakeWin("?mode=view"))).toBe(true);
    expect(resolveReadOnly("write", fakeWin("?mode=comment"))).toBe(true);
    expect(resolveReadOnly("write", fakeWin("?mode=edit"))).toBe(false);
    expect(resolveReadOnly(undefined, fakeWin("?mode=comment"))).toBe(true);
  });

  it("never widens: mode=edit on a reader/commenter stays read-only", () => {
    expect(resolveReadOnly("read", fakeWin("?mode=edit"))).toBe(true);
    expect(resolveReadOnly("comment", fakeWin("?mode=edit"))).toBe(true);
    expect(resolveCommentAccess("read", true, fakeWin("?mode=comment"))).toBe("none");
  });

  it("mode=comment keeps a writer's ydoc comment path with the frame locked", () => {
    expect(resolveCommentAccess("write", true, fakeWin("?mode=comment"))).toBe("write");
    expect(resolveCommentAccess(undefined, true, fakeWin("?mode=comment"))).toBe("write");
    // mode=view: a pure viewer, comments only behind the reader opt-in.
    expect(resolveCommentAccess("write", true, fakeWin("?mode=view"))).toBe("none");
    // A server-side commenter keeps the REST route whatever the URL says.
    expect(resolveCommentAccess("comment", true, fakeWin("?mode=comment"))).toBe("comment");
  });

  it("requestedMode: explicit mode wins over the legacy readonly alias", () => {
    expect(requestedMode(fakeWin(""))).toBe(null);
    expect(requestedMode(fakeWin("?readonly=1"))).toBe("view");
    expect(requestedMode(fakeWin("?readonly=1&mode=comment"))).toBe("comment");
    expect(requestedMode(fakeWin("?mode=bogus"))).toBe(null);
  });

  it("only writers can choose", () => {
    expect(canChooseMode(undefined)).toBe(true);
    expect(canChooseMode("write")).toBe(true);
    expect(canChooseMode("comment")).toBe(false);
    expect(canChooseMode("read")).toBe(false);
  });
});
