import { matchPath } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { decodeRoutePath } from "./route-path";

describe("decodeRoutePath", () => {
  it("decodes percent-encoded spaces in every segment", () => {
    expect(
      decodeRoutePath("Repo-main/KiCad%20Projects/Arduino%20Mega%202560/Mega.kicad_pcb"),
    ).toBe("Repo-main/KiCad Projects/Arduino Mega 2560/Mega.kicad_pcb");
  });

  it("leaves an already-decoded path alone", () => {
    expect(decodeRoutePath("KiCad Projects/Mega.kicad_pcb")).toBe(
      "KiCad Projects/Mega.kicad_pcb",
    );
  });

  it("decodes non-ASCII names", () => {
    expect(decodeRoutePath("t%C3%A9st/b%C3%B6ard.kicad_sch")).toBe("tést/böard.kicad_sch");
  });

  it("keeps a malformed segment verbatim instead of throwing", () => {
    expect(decodeRoutePath("ok/100%/board.kicad_pcb")).toBe("ok/100%/board.kicad_pcb");
  });

  it("does not let an encoded separator become a path boundary", () => {
    // Per-segment decoding keeps the "/" inside the name rather than splitting
    // the path — the segment count must not change.
    expect(decodeRoutePath("dir/a%2Fb.kicad_pcb").split("/").length).toBe(3);
  });

  // The regression itself: the router hands ToolPage an ENCODED splat, so
  // without this decode `targetPath` matches no entry in the project file list.
  it("restores the path the router failed to decode", () => {
    const url =
      "/e2e-1/projects/arduino/Repo-main/KiCad%20Projects/Arduino%20Mega%202560/Mega.kicad_pcb";
    const match = matchPath("/:scope/projects/:name/*", url);
    const splat = match?.params["*"] ?? "";
    expect(splat).toContain("%20"); // router leaves the splat encoded…
    expect(match?.params.name).toBe("arduino"); // …while named params are decoded
    expect(decodeRoutePath(splat)).toBe(
      "Repo-main/KiCad Projects/Arduino Mega 2560/Mega.kicad_pcb",
    );
  });
});
