import { describe, expect, it } from "vitest";
import { dump, mark, resetTrace } from "./load-trace";

describe("load-trace", () => {
  it("records marks and renders a timeline block", () => {
    resetTrace();
    mark("fs:ready");
    mark("open:start", "board.kicad_pcb");
    mark("open:settled", "result=programmatic");
    const out = dump();
    expect(out).toContain("load timeline (3 marks");
    expect(out).toContain("open:start board.kicad_pcb");
    expect(out).toContain("open:settled result=programmatic");
  });

  it("says so rather than throwing when nothing was recorded", () => {
    resetTrace();
    expect(dump()).toBe("[trace] (no entries)");
  });

  it("is bounded, so a pathological load cannot grow it without limit", () => {
    resetTrace();
    for (let i = 0; i < 260; i++) mark(`p${i}`);
    const out = dump();
    expect(out).toContain("load timeline (200 marks");
    expect(out).not.toContain(" p0 "); // oldest evicted
    expect(out).toContain("p259");
  });
});
