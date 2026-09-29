import { afterEach, describe, expect, it } from "vitest";
import {
  __setToolActionsSourceForTests,
  parseToolActions,
  pickToolByAction,
  toolActionsFor,
  toolKey,
} from "./tool-actions";

const tool = (over: Partial<WxRenderedElementInfo>): WxRenderedElementInfo => ({
  id: "100:tool:0",
  parentId: "100",
  elementType: "tool",
  subType: "button",
  label: "",
  tooltip: "",
  screenX: 0,
  screenY: 0,
  width: 24,
  height: 24,
  centerX: 12,
  centerY: 12,
  enabled: true,
  index: 0,
  ...over,
});

const PLACE = "eeschema.InteractiveDrawing.placeSymbol";

describe("parseToolActions", () => {
  it("keys rows by toolbar and tool id, skipping junk", () => {
    const map = parseToolActions(
      JSON.stringify([
        { toolbar: "100", toolId: 7, action: PLACE },
        { toolbar: 100, toolId: 8, action: "x" },
        { toolbar: "100", toolId: "9", action: "y" },
        null,
      ]),
    );
    expect([...map]).toEqual([[toolKey("100", 7), PLACE]]);
    expect(parseToolActions("{")).toEqual(new Map());
    expect(parseToolActions('{"a":1}')).toEqual(new Map());
    expect(parseToolActions(undefined)).toEqual(new Map());
  });
});

describe("pickToolByAction", () => {
  const actions = new Map([
    [toolKey("100", 7), PLACE],
    [toolKey("200", 7), PLACE],
  ]);

  it("joins registry entries to actions by toolbar + tool id", () => {
    const other = tool({ userId: 8 });
    const hit = tool({ id: "100:tool:3", userId: 7 });
    expect(pickToolByAction([other, hit], undefined, actions, PLACE)).toBe(hit);
  });

  it("ignores entries without an id, zero-size tools and hidden toolbars", () => {
    const noId = tool({});
    const empty = tool({ userId: 7, width: 0 });
    const hidden = tool({ parentId: "200", userId: 7 });
    const windows = new Map([["200", { visible: false } as WxElementInfo]]);
    expect(pickToolByAction([noId, empty, hidden], windows, actions, PLACE)).toBeNull();
  });
});

describe("toolActionsFor", () => {
  afterEach(() => __setToolActionsSourceForTests(null));

  it("reads once, re-reads for unknown tools at most once per registry version", () => {
    let reads = 0;
    let rows = [{ toolbar: "100", toolId: 7, action: PLACE }];
    __setToolActionsSourceForTests(() => {
      reads++;
      return JSON.stringify(rows);
    });
    const known = [tool({ userId: 7 })];
    expect(toolActionsFor(known, 1).get(toolKey("100", 7))).toBe(PLACE);
    expect(toolActionsFor(known, 2).size).toBe(1);
    expect(reads).toBe(1);

    const fresh = [...known, tool({ parentId: "300", userId: 1 })];
    rows = [...rows, { toolbar: "300", toolId: 1, action: "a" }];
    toolActionsFor(fresh, 2);
    toolActionsFor(fresh, 2);
    expect(reads).toBe(2);
    expect(toolActionsFor(fresh, 3).get(toolKey("300", 1))).toBe("a");
  });

  it("survives a throwing engine read", () => {
    __setToolActionsSourceForTests(() => {
      throw new Error("busy");
    });
    expect(toolActionsFor([tool({ userId: 7 })], 1).size).toBe(0);
  });
});
