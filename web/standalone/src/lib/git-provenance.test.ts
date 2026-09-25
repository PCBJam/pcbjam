import { describe, expect, it, vi } from "vitest";
import {
  ancestryLabel,
  configureGitProvenance,
  createAncestryStore,
  dirtyAtWrite,
  markEditedInSession,
  parseAncestry,
  provenanceText,
  setChangedPaths,
} from "./git-provenance";

describe("ancestry labels", () => {
  it("maps every relation (design-comments §6.2)", () => {
    expect(ancestryLabel("same")).toBe("same revision");
    expect(ancestryLabel("before")).toBe("before this copy");
    expect(ancestryLabel("after")).toBe("after this copy");
    expect(ancestryLabel("divergent")).toBe("divergent");
    expect(ancestryLabel("unknown")).toBe("unknown");
    expect(ancestryLabel(null)).toBeNull();
  });

  it("renders the popover line, with the dirtyAtWrite caveat", () => {
    expect(provenanceText({ headCommit: "0123456789" }, "before")).toBe("introduced at 0123456 (before this copy)");
    expect(provenanceText({ headCommit: "0123456789", dirtyAtWrite: true }, "same")).toBe(
      "written on uncommitted changes based at 0123456 (same revision)",
    );
    expect(provenanceText({ headCommit: "0123456789" }, null)).toBe("introduced at 0123456");
    expect(provenanceText({}, "same")).toBeNull();
  });

  it("parses the server answer defensively", () => {
    expect(parseAncestry({ relations: { a: "same", b: "bogus", c: { relation: "after" } } })).toEqual({ a: "same", c: "after" });
    expect(parseAncestry({ head: "h", labels: { x: "divergent" } })).toEqual({ x: "divergent" });
    expect(parseAncestry(null)).toEqual({});
  });
});

describe("ancestry store", () => {
  it("batches lookups, caches, and treats missing answers as unknown", async () => {
    const fetcher = vi.fn(async (shas: string[]) => Object.fromEntries(shas.filter((s) => s !== "zz").map((s) => [s, "before" as const])));
    const queue: Array<() => void> = [];
    const store = createAncestryStore(fetcher, (fn) => queue.push(fn));
    const seen = vi.fn();
    store.subscribe(seen);
    expect(store.get("a")).toBeNull();
    expect(store.get("b")).toBeNull();
    expect(store.get("zz")).toBeNull();
    expect(queue).toHaveLength(1);
    queue.shift()!();
    await vi.waitFor(() => expect(seen).toHaveBeenCalled());
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0]![0].sort()).toEqual(["a", "b", "zz"]);
    expect(store.get("a")).toBe("before");
    expect(store.get("zz")).toBe("unknown");
    store.reset();
    expect(store.get("a")).toBeNull();
  });
});

describe("dirtyAtWrite", () => {
  it("is undefined without a connected copy, else from the changes list or a session edit", () => {
    configureGitProvenance(null);
    expect(dirtyAtWrite("board.kicad_pcb")).toBeUndefined();
    configureGitProvenance({ apiBase: "http://x", scope: "s", project: "p", copyId: "c" });
    expect(dirtyAtWrite("board.kicad_pcb")).toBe(false);
    setChangedPaths(["board.kicad_sch"]);
    expect(dirtyAtWrite("board.kicad_sch")).toBe(true);
    markEditedInSession("board.kicad_pcb");
    expect(dirtyAtWrite("board.kicad_pcb")).toBe(true);
    expect(dirtyAtWrite(undefined)).toBeUndefined();
    configureGitProvenance(null);
  });
});
