// Where the user put the live layer's tags, and how large the tags are drawn.
import { describe, expect, it } from "vitest";
import {
  MOST_TAGS, TAG_LEAST, TAG_MOST, loadTagShifts, parseTagShifts, saveTagShifts, shiftBox, tagScale, withTagShift, type TagShifts,
} from "./live-tag-places";

const store = (start: Record<string, string> = {}) => {
  const data = new Map(Object.entries(start));
  return {
    data,
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
    removeItem: (k: string) => void data.delete(k),
  };
};
const blocked = {
  getItem: (): string | null => {
    throw new Error("blocked");
  },
  setItem: (): void => {
    throw new Error("full");
  },
  removeItem: (): void => {
    throw new Error("blocked");
  },
};

describe("what the browser stored about the tags", () => {
  it("reads the shifts back", () => {
    expect(parseTagShifts('{"/:u1:0":[12.5,-3],"/Key 1/:u2:1":[0,40]}')).toEqual({ "/:u1:0": [12.5, -3], "/Key 1/:u2:1": [0, 40] });
  });

  it("is empty for nothing, and for what is not a list of shifts", () => {
    for (const raw of [null, undefined, "", "not json", "[]", "7", '"text"', "null"]) expect(parseTagShifts(raw)).toEqual({});
  });

  it("drops an entry that is not a shift, and keeps the others", () => {
    const raw = JSON.stringify({ a: [1, 2], b: [1], c: ["1", 2], d: [1, null], e: { x: 1 }, f: [1, 2, 3], g: [0, 0], h: [-4, 0] });
    expect(parseTagShifts(raw)).toEqual({ a: [1, 2], h: [-4, 0] });
    // a number that is none cannot be written as JSON at all, so it arrives as null
    expect(parseTagShifts(JSON.stringify({ a: [Infinity, 1] }))).toEqual({});
  });

  it("holds a shift inside the largest sheet, in hundredths of a millimetre", () => {
    expect(parseTagShifts('{"a":[1.23456,-0.004],"b":[99999,-99999]}')).toEqual({ a: [1.23, 0], b: [2000, -2000] });
  });

  it("keeps the newest when there are more than a project remembers", () => {
    const many = Object.fromEntries(Array.from({ length: MOST_TAGS + 3 }, (_, i) => [`k${i}`, [i + 1, 0]]));
    const read = parseTagShifts(JSON.stringify(many));
    expect(Object.keys(read)).toHaveLength(MOST_TAGS);
    expect(Object.keys(read)[0]).toBe("k3");
  });
});

describe("moving one tag", () => {
  const two: TagShifts = { a: [1, 1], b: [2, 2] };

  it("puts it at its new place, as the newest", () => {
    expect(withTagShift(two, "c", [5, -5])).toEqual({ a: [1, 1], b: [2, 2], c: [5, -5] });
    expect(Object.keys(withTagShift(two, "a", [9, 9]))).toEqual(["b", "a"]);
    expect(two, "the shifts it was given are not changed").toEqual({ a: [1, 1], b: [2, 2] });
  });

  it("puts it back: no shift is left of it", () => {
    expect(withTagShift(two, "a", null)).toEqual({ b: [2, 2] });
    expect(withTagShift(two, "a", [0.001, 0])).toEqual({ b: [2, 2] });
  });

  it("gives back the very same shifts when nothing changes", () => {
    expect(withTagShift(two, "a", [1, 1])).toBe(two);
    expect(withTagShift(two, "c", null)).toBe(two);
    expect(withTagShift(two, "c", [NaN, 1])).toBe(two);
  });

  it("forgets the tag that was moved longest ago when a project has too many", () => {
    let shifts: TagShifts = {};
    for (let i = 0; i < MOST_TAGS; i++) shifts = withTagShift(shifts, `k${i}`, [i + 1, 0]);
    const more = withTagShift(shifts, "new", [1, 1]);
    expect(Object.keys(more)).toHaveLength(MOST_TAGS);
    expect("k0" in more).toBe(false);
    expect(more.new).toEqual([1, 1]);
    // a tag that is already among them takes nobody's place
    expect(Object.keys(withTagShift(shifts, "k5", [7, 7]))).toHaveLength(MOST_TAGS);
  });
});

describe("remembering the tags of a project", () => {
  it("keeps one entry for a project, and reads it back", () => {
    const s = store();
    saveTagShifts("p1", { a: [3, 4] }, s);
    saveTagShifts("p2", { b: [5, 6] }, s);
    expect([...s.data.keys()]).toEqual(["pcbjam:live-tags:p1", "pcbjam:live-tags:p2"]);
    expect(loadTagShifts("p1", s)).toEqual({ a: [3, 4] });
    expect(loadTagShifts("p2", s)).toEqual({ b: [5, 6] });
    expect(loadTagShifts("p3", s)).toEqual({});
  });

  it("takes the entry away when every tag is back at its place", () => {
    const s = store({ "pcbjam:live-tags:p1": '{"a":[3,4]}' });
    saveTagShifts("p1", {}, s);
    expect(s.data.size).toBe(0);
  });

  it("does nothing without a project, and nothing breaks when the storage is blocked or full", () => {
    const s = store();
    saveTagShifts(undefined, { a: [1, 1] }, s);
    expect(s.data.size).toBe(0);
    expect(loadTagShifts(undefined, s)).toEqual({});
    expect(loadTagShifts("p1", blocked)).toEqual({});
    expect(() => saveTagShifts("p1", { a: [1, 1] }, blocked)).not.toThrow();
    expect(() => saveTagShifts("p1", {}, blocked)).not.toThrow();
    expect(loadTagShifts("p1", null)).toEqual({});
  });
});

describe("a tag on the sheet", () => {
  it("is moved by its shift, in the sheet's units", () => {
    const box = { x: 1000, y: 2000, anchor: "top-center" as const };
    expect(shiftBox(box, [2.5, -1], 10000)).toEqual({ x: 26000, y: -8000, anchor: "top-center" });
    expect(shiftBox(box, undefined, 10000)).toBe(box);
  });

  it("has its full size at the zooms a schematic is read at", () => {
    for (const pxPerMm of [5, 6.5, 8]) expect(tagScale(pxPerMm)).toBe(1);
  });

  it("shrinks with the sheet when that is zoomed out, down to a size that can be read", () => {
    expect(tagScale(4)).toBeCloseTo(0.8);
    expect(tagScale(2)).toBe(TAG_LEAST);
    expect(tagScale(0.1)).toBe(TAG_LEAST);
  });

  it("grows with the sheet when that is zoomed in close, and stops at some size", () => {
    expect(tagScale(12)).toBeCloseTo(1.5);
    expect(tagScale(40)).toBeCloseTo(5);
    expect(tagScale(64)).toBe(TAG_MOST);
    expect(tagScale(500)).toBe(TAG_MOST);
  });

  it("has its full size when the zoom is not known", () => {
    for (const none of [0, -3, NaN]) expect(tagScale(none)).toBe(1);
  });
});
