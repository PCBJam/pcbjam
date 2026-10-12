import { describe, expect, it } from "vitest";
import { fakeMemfs } from "../fake-memfs";
import { installLibDocPlaceholders } from "./lib-docs";

const enc = new TextEncoder();
const dec = new TextDecoder();
const ROOT = "/pcbjam/libroots/MYPARTS_DIR";

function setup() {
  const fs = fakeMemfs();
  const urls: string[] = [];
  const lazy = installLibDocPlaceholders({
    fs: fs as unknown as Parameters<typeof installLibDocPlaceholders>[0]["fs"],
    lib: { id: "lib-a", paths: { pathVar: "MYPARTS_DIR", docsDir: "datasheets/" } },
    names: ["sot23.pdf", "vendor/x.pdf"],
    itemUrl: (libId, kind, name) => `/items/${libId}/${kind}/${name}`,
    log: () => {},
    request: (url) => {
      urls.push(url);
      return { status: 200, body: enc.encode(`pdf ${url}`), header: () => null };
    },
  });
  return { fs, lazy, urls };
}

describe("library datasheet placeholders (libs 0020 F)", () => {
  it("creates the datasheet folders under the variable root without fetching", () => {
    const { fs, lazy, urls } = setup();
    expect(fs.analyzePath(`${ROOT}/datasheets/vendor`).exists).toBe(true);
    expect(urls).toEqual([]);
    expect(lazy?.pending().sort()).toEqual(["datasheets", "datasheets/vendor"]);
  });

  it("opening one datasheet fetches its folder's docs by item name", () => {
    const { fs, urls } = setup();
    expect(dec.decode(fs.readFile(`${ROOT}/datasheets/sot23.pdf`))).toBe("pdf /items/lib-a/doc/sot23.pdf");
    expect(urls).toEqual(["/items/lib-a/doc/sot23.pdf"]);
  });

  it("does nothing for a library without docs", () => {
    const fs = fakeMemfs();
    expect(
      installLibDocPlaceholders({
        fs: fs as unknown as Parameters<typeof installLibDocPlaceholders>[0]["fs"],
        lib: { id: "l", paths: { pathVar: "L_DIR", docsDir: "docs" } },
        names: [],
        itemUrl: () => "",
        log: () => {},
      }),
    ).toBeNull();
  });
});
