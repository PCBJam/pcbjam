import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  __setViewportSourceForTests,
  getViewport,
  getViewportVersion,
  parseViewport,
  publishViewport,
  pullViewport,
  subscribeViewport,
} from "./viewport-store";

const A = { cx: 1, cy: 2, scale: 0.5, w: 800, h: 600 };
const B = { cx: 5, cy: 2, scale: 0.5, w: 800, h: 600 };

describe("viewport-store", () => {
  let raw: string | null = null;
  let reads = 0;

  beforeEach(() => {
    vi.useFakeTimers();
    raw = null;
    reads = 0;
    __setViewportSourceForTests(() => {
      reads++;
      return raw;
    });
  });
  afterEach(() => {
    vi.useRealTimers();
    __setViewportSourceForTests(null);
  });

  it("parses only complete, positive-size viewports", () => {
    expect(parseViewport(JSON.stringify(A))).toEqual(A);
    expect(parseViewport(JSON.stringify({ ...A, w: 0 }))).toBeNull();
    expect(parseViewport(JSON.stringify({ cx: 1 }))).toBeNull();
    expect(parseViewport("null")).toBeNull();
    expect(parseViewport("{")).toBeNull();
    expect(parseViewport(undefined)).toBeNull();
  });

  it("publishes pushes and dedupes identical ones", () => {
    const cb = vi.fn();
    const off = subscribeViewport(cb);
    publishViewport(A);
    publishViewport({ ...A });
    expect(cb).toHaveBeenCalledTimes(1);
    expect(getViewport()).toEqual(A);
    off();
  });

  it("polls the engine only while subscribed", () => {
    raw = JSON.stringify(A);
    const off = subscribeViewport(() => {});
    expect(getViewport()).toEqual(A); // immediate seed pull
    raw = JSON.stringify(B);
    vi.advanceTimersByTime(100);
    expect(getViewport()).toEqual(B);
    off();
    const before = reads;
    vi.advanceTimersByTime(1000);
    expect(reads).toBe(before);
  });

  it("skips pulls while the push feed is fresh", () => {
    raw = JSON.stringify(B);
    publishViewport(A, 1000);
    pullViewport(1500);
    expect(getViewport()).toEqual(A);
    pullViewport(2500);
    expect(getViewport()).toEqual(B);
  });

  it("bumps the version on every change", () => {
    const v0 = getViewportVersion();
    publishViewport(A);
    publishViewport(B);
    expect(getViewportVersion()).toBe(v0 + 2);
  });

  it("survives a throwing engine read", () => {
    __setViewportSourceForTests(() => {
      throw new Error("busy");
    });
    expect(() => pullViewport()).not.toThrow();
    expect(getViewport()).toBeNull();
  });
});
