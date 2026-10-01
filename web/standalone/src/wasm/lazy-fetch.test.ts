import { describe, expect, it } from "vitest";
import { encodeFolder } from "@pcbjam/shared";
import { makeSyncFolderFetch } from "./lazy-fetch";

const enc = new TextEncoder();

function folder(files: Array<[string, string, number]>, omitted: string[] = []): Uint8Array {
  return encodeFolder({
    revisions: Object.fromEntries(files.map(([path, , revision]) => [path, revision])),
    omitted,
    files: files.map(([path, text]) => [path, enc.encode(text)]),
  });
}

function harness(respond: (url: string) => { status: number; body?: Uint8Array; revision?: number }) {
  const urls: string[] = [];
  const revisions: Array<[string, number]> = [];
  const fetchFolder = makeSyncFolderFetch({
    folderUrl: "https://api.test/p/sync/folder",
    fileUrl: (p) => `https://api.test/p/files/${p}`,
    withParams: (u) => `${u}${u.includes("?") ? "&" : "?"}copy=c1`,
    onRevision: (p, r) => revisions.push([p, r]),
    log: () => {},
    request: (url) => {
      urls.push(url);
      const r = respond(url);
      return {
        status: r.status,
        body: r.body ?? new Uint8Array(),
        header: (name) => (name === "x-pcbjam-file-revision" && r.revision ? String(r.revision) : null),
      };
    },
  });
  return { fetchFolder, urls, revisions };
}

describe("makeSyncFolderFetch", () => {
  it("one request for the folder; only the asked files come back, with their revisions", () => {
    const { fetchFolder, urls, revisions } = harness(() => ({
      status: 200,
      body: folder([["docs/a.png", "A", 3], ["docs/b.pdf", "B", 1], ["docs/staged.txt", "S", 9]]),
    }));
    const got = fetchFolder("docs", ["docs/a.png", "docs/b.pdf"]);
    expect(got.map(([p]) => p)).toEqual(["docs/a.png", "docs/b.pdf"]);
    expect(urls).toEqual(["https://api.test/p/sync/folder?dir=docs&copy=c1"]);
    expect(revisions).toEqual([["docs/a.png", 3], ["docs/b.pdf", 1]]);
  });

  it("files the response left out are fetched one by one", () => {
    const { fetchFolder, urls } = harness((url) =>
      url.includes("/sync/folder")
        ? { status: 200, body: folder([["m/a.step", "A", 1]], ["m/big.step"]) }
        : { status: 200, body: enc.encode("BIG"), revision: 4 },
    );
    const got = fetchFolder("m", ["m/a.step", "m/big.step"]);
    expect(got.map(([p, b]) => [p, new TextDecoder().decode(b)])).toEqual([["m/a.step", "A"], ["m/big.step", "BIG"]]);
    expect(urls[1]).toBe("https://api.test/p/files/m/big.step");
  });

  it("a backend without the folder route falls back to per-file requests; a gone file is skipped", () => {
    const { fetchFolder, revisions } = harness((url) =>
      url.includes("/sync/folder")
        ? { status: 404 }
        : url.endsWith("gone.txt")
          ? { status: 404 }
          : { status: 200, body: enc.encode("X"), revision: 2 },
    );
    expect(fetchFolder("d", ["d/a.txt", "d/gone.txt"]).map(([p]) => p)).toEqual(["d/a.txt"]);
    expect(revisions).toEqual([["d/a.txt", 2]]);
  });

  it("a server error is an error (the folder is retried later), not an empty folder", () => {
    const { fetchFolder } = harness(() => ({ status: 503 }));
    expect(() => fetchFolder("d", ["d/a.txt"])).toThrow(/503/);
  });
});
