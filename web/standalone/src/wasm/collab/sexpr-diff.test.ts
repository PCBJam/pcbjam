import { describe, expect, it } from "vitest";
import {
  KICAD_WRITER_NORMALIZED_SEXPR_ORDER,
  parseSexpr,
  sexprDiff,
} from "./sexpr-diff";

// A tiny item helper: a list node `(type (uuid "ID") <props…>)` as text.
const item = (type: string, id: string, ...props: string[]) =>
  `(${type} (uuid "${id}") ${props.join(" ")})`;

describe("parseSexpr", () => {
  it("parses nested lists and atoms", () => {
    expect(parseSexpr("(a b (c 1))")).toEqual([["a", "b", ["c", "1"]]]);
  });

  it("keeps quoted strings (with quotes) as single atoms, spaces preserved", () => {
    expect(parseSexpr('(text "hello world")')).toEqual([["text", '"hello world"']]);
  });

  it("handles escaped quotes inside strings", () => {
    expect(parseSexpr('(t "a\\"b")')).toEqual([["t", '"a\\"b"']]);
  });

  it("throws on unbalanced parens", () => {
    expect(() => parseSexpr("(a (b)")).toThrow(/unbalanced/);
  });

  it("throws on an unterminated string", () => {
    expect(() => parseSexpr('(a "oops)')).toThrow(/unterminated/);
  });
});

describe("sexprDiff — equality", () => {
  it("identical text is equal", () => {
    const a = `(root ${item("seg", "u1", "(x 1)", "(y 2)")})`;
    expect(sexprDiff(a, a).equal).toBe(true);
  });

  it("is exact by default when uuid-bearing siblings are reordered", () => {
    const a = `(root ${item("seg", "u1", "(x 1)")} ${item("seg", "u2", "(x 2)")})`;
    const b = `(root ${item("seg", "u2", "(x 2)")} ${item("seg", "u1", "(x 1)")})`;
    expect(sexprDiff(a, b).equal).toBe(false);
  });

  it("can ignore the audited UUID-bearing sibling writer normalization", () => {
    const a = `(root ${item("seg", "u1", "(x 1)")} ${item("seg", "u2", "(x 2)")})`;
    const b = `(root ${item("seg", "u2", "(x 2)")} ${item("seg", "u1", "(x 1)")})`;
    expect(
      sexprDiff(a, b, {
        ignoreOrderClasses: KICAD_WRITER_NORMALIZED_SEXPR_ORDER,
      }).equal,
    ).toBe(true);
  });

  it("is exact by default when properties within an item are reordered", () => {
    const a = `(root ${item("seg", "u1", "(x 1)", "(y 2)", "(layer F)")})`;
    const b = `(root ${item("seg", "u1", "(layer F)", "(y 2)", "(x 1)")})`;
    expect(sexprDiff(a, b).equal).toBe(false);
    expect(
      sexprDiff(a, b, {
        ignoreOrderClasses: KICAD_WRITER_NORMALIZED_SEXPR_ORDER,
      }).equal,
      "UUID sibling normalization must not widen to anonymous properties",
    ).toBe(false);
  });

  it("whitespace differences are irrelevant", () => {
    const a = `(root ${item("seg", "u1", "(x 1)")})`;
    const b = `(root\n   (seg   (uuid "u1")\n     (x 1)  )\n)`;
    expect(sexprDiff(a, b).equal).toBe(true);
  });
});

describe("sexprDiff — changes", () => {
  it("catches non-UUID document structure instead of comparing item sets only", () => {
    const a = `(root (paper "A4") ${item("seg", "u1", "(x 1)")})`;
    const b = `(root (paper "A3") ${item("seg", "u1", "(x 1)")})`;
    const r = sexprDiff(a, b);
    expect(r.equal).toBe(false);
    expect(r.changed).toContainEqual({
      uuid: "·document",
      path: "·document",
      a,
      b,
    });
  });

  it("catches a positional tuple swap", () => {
    const a = `(root ${item("footprint", "u1", "(at 1 2)")})`;
    const b = `(root ${item("footprint", "u1", "(at 2 1)")})`;
    const r = sexprDiff(a, b);
    expect(r.equal).toBe(false);
    expect(r.changed.some((change) => change.uuid === "u1" && change.path === "at")).toBe(
      true,
    );
  });

  it("catches a reorder of anonymous repeated heads", () => {
    const a = `(root ${item("poly", "u1", "(pts (xy 0 0) (xy 5 0))")})`;
    const b = `(root ${item("poly", "u1", "(pts (xy 5 0) (xy 0 0))")})`;
    const r = sexprDiff(a, b);
    expect(r.equal).toBe(false);
    expect(r.changed.some((change) => change.uuid === "u1" && change.path === "pts")).toBe(
      true,
    );
    expect(
      sexprDiff(a, b, {
        ignoreOrderClasses: KICAD_WRITER_NORMALIZED_SEXPR_ORDER,
      }).equal,
      "UUID sibling normalization must not widen to anonymous xy children",
    ).toBe(false);
  });

  it("catches a single changed value with uuid + path + a/b", () => {
    const a = `(root ${item("seg", "u1", "(x 1)", "(y 2)")})`;
    const b = `(root ${item("seg", "u1", "(x 1)", "(y 9)")})`;
    const r = sexprDiff(a, b);
    expect(r.equal).toBe(false);
    expect(r.changed).toHaveLength(1);
    expect(r.changed[0]).toMatchObject({ uuid: "u1", path: "y", a: "(y 2)", b: "(y 9)" });
  });

  it("distinguishes a quoted string from the same bare token", () => {
    const a = `(root ${item("t", "u1", '(val "5")')})`;
    const b = `(root ${item("t", "u1", "(val 5)")})`;
    const r = sexprDiff(a, b);
    expect(r.equal).toBe(false);
    expect(r.changed[0]).toMatchObject({ uuid: "u1", path: "val" });
  });

  it("detects an added item (present only in B)", () => {
    const a = `(root ${item("seg", "u1", "(x 1)")})`;
    const b = `(root ${item("seg", "u1", "(x 1)")} ${item("seg", "u2", "(x 2)")})`;
    const r = sexprDiff(a, b);
    expect(r.equal).toBe(false);
    expect(r.added).toEqual(["u2"]);
    expect(r.removed).toEqual([]);
  });

  it("detects a removed item (present only in A)", () => {
    const a = `(root ${item("seg", "u1", "(x 1)")} ${item("seg", "u2", "(x 2)")})`;
    const b = `(root ${item("seg", "u1", "(x 1)")})`;
    const r = sexprDiff(a, b);
    expect(r.equal).toBe(false);
    expect(r.removed).toEqual(["u2"]);
    expect(r.added).toEqual([]);
  });

  it("compares nested blob items by their own uuids", () => {
    const a = `(root (fp (uuid "f1") (at 0 0) ${item("pad", "p1", "(size 1)")}))`;
    const b = `(root (fp (uuid "f1") (at 0 0) ${item("pad", "p1", "(size 2)")}))`;
    const r = sexprDiff(a, b);
    expect(r.equal).toBe(false);
    // The nested pad's value change surfaces under its own uuid…
    expect(r.changed.some((c) => c.uuid === "p1" && c.path === "size")).toBe(true);
    // …without duplicating the child-body change under the parent footprint.
    expect(r.changed.some((c) => c.uuid === "f1")).toBe(false);
  });
});

describe("sexprDiff — ignoreTokens", () => {
  it("ignores a volatile token so equal-but-for-version compares equal", () => {
    const a = `(root ${item("seg", "u1", '(generator_version "8.0")', "(x 1)")})`;
    const b = `(root ${item("seg", "u1", '(generator_version "9.9")', "(x 1)")})`;
    expect(sexprDiff(a, b).equal).toBe(false); // by default the version diff shows
    expect(sexprDiff(a, b, { ignoreTokens: ["generator_version"] }).equal).toBe(true);
  });
});
