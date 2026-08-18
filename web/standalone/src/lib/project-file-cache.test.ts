import { describe, expect, it } from "vitest";
import type { ProjectFile } from "@pcbjam/shared";
import {
  fileCacheValidator,
  isYdocValidator,
  pruneProjectFileCache,
  readCachedFileBytes,
  writeCachedFileBytes,
} from "./project-file-cache";

const base: ProjectFile = {
  id: "0b7a4bfa-0000-5000-8000-000000000001",
  projectId: "0b7a4bfa-0000-5000-8000-000000000002",
  path: "boards/main.kicad_pcb",
  size: 10,
  contentType: "text/plain",
  revision: 3,
  createdAt: "2026-08-01T00:00:00.000Z",
  updatedAt: "2026-08-15T12:00:00.000Z",
};

describe("fileCacheValidator", () => {
  it("derives revision:updatedAt for a published, non-collab file", () => {
    expect(fileCacheValidator(base)).toBe("3:2026-08-15T12:00:00.000Z");
  });

  it("changes when only updatedAt moves (equivalent resave body swap)", () => {
    // The backend's resave normalization swaps the stored body WITHOUT
    // advancing revision — updatedAt is the only signal, so it must be
    // part of the validator or the cache would serve pre-normalization bytes.
    const swapped = { ...base, updatedAt: "2026-08-16T09:30:00.000Z" };
    expect(fileCacheValidator(swapped)).not.toBe(fileCacheValidator(base));
  });

  it("rejects revision 0 and absent revision (no published CAS row)", () => {
    expect(fileCacheValidator({ ...base, revision: 0 })).toBeNull();
    expect(fileCacheValidator({ ...base, revision: undefined })).toBeNull();
  });

  it("ydoc-backed + cold: the blob fingerprint is the validator", () => {
    const v = fileCacheValidator({ ...base, hasYdoc: true, ydocTag: "etag-1" });
    expect(v).toBe("y1:etag-1");
    expect(isYdocValidator(v!)).toBe(true);
    expect(isYdocValidator(fileCacheValidator(base)!)).toBe(false);
    // Collab-only rows (revision 0 — never uploaded) are cacheable too: the
    // blob IS their only source of truth.
    expect(
      fileCacheValidator({ ...base, revision: 0, hasYdoc: true, ydocTag: "e2" }),
    ).toBe("y1:e2");
  });

  it("ydoc-backed but LIVE or untagged stays uncacheable", () => {
    // Live: bytes are moving under an open room, no fingerprint can vouch.
    expect(
      fileCacheValidator({ ...base, hasYdoc: true, ydocTag: "e", isLive: true }),
    ).toBeNull();
    // Older backend without the ydocTag field: exactly the old behavior.
    expect(fileCacheValidator({ ...base, hasYdoc: true })).toBeNull();
  });
});

describe("without IndexedDB (node, private mode)", () => {
  // The vitest environment is node: no indexedDB global. Every operation must
  // degrade to a no-op — a broken cache may never break a load.
  it("read resolves null, write and prune resolve without throwing", async () => {
    expect(typeof indexedDB).toBe("undefined");
    await expect(readCachedFileBytes("p", "a", "1:x")).resolves.toBeNull();
    await expect(
      writeCachedFileBytes("p", "a", "1:x", new Uint8Array([1])),
    ).resolves.toBeUndefined();
    await expect(
      pruneProjectFileCache("p", new Map([["a", "1:x"]])),
    ).resolves.toBeUndefined();
  });
});
