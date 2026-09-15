import { describe, expect, it } from "vitest";
import {
  MOBILE_MODE_KEY,
  mobileModeGateDecision,
  rememberMobileMode,
  rememberedMobileMode,
  type ModeStorage,
} from "./mobile-mode-choice";

function fakeStore(init: Record<string, string> = {}): ModeStorage & { m: Map<string, string> } {
  const m = new Map(Object.entries(init));
  return {
    m,
    getItem: (k) => m.get(k) ?? null,
    setItem: (k, v) => void m.set(k, v),
    removeItem: (k) => void m.delete(k),
  };
}

describe("mobileModeGateDecision", () => {
  it("passes on desktop, and whenever the URL already carries a mode", () => {
    expect(mobileModeGateDecision({ mobile: false, access: "write", requested: null, remembered: null }))
      .toEqual({ kind: "pass" });
    expect(mobileModeGateDecision({ mobile: true, access: "write", requested: "edit", remembered: "view" }))
      .toEqual({ kind: "pass" });
  });

  it("never asks a session the server already narrowed", () => {
    expect(mobileModeGateDecision({ mobile: true, access: "read", requested: null, remembered: null }))
      .toEqual({ kind: "pass" });
    expect(mobileModeGateDecision({ mobile: true, access: "comment", requested: null, remembered: "edit" }))
      .toEqual({ kind: "pass" });
  });

  it("asks a mobile writer (server access or authz-free), applies a remembered choice silently", () => {
    expect(mobileModeGateDecision({ mobile: true, access: "write", requested: null, remembered: null }))
      .toEqual({ kind: "ask" });
    expect(mobileModeGateDecision({ mobile: true, access: undefined, requested: null, remembered: null }))
      .toEqual({ kind: "ask" });
    expect(mobileModeGateDecision({ mobile: true, access: "write", requested: null, remembered: "comment" }))
      .toEqual({ kind: "apply", mode: "comment" });
  });
});

describe("remembered mode storage", () => {
  it("round-trips valid modes and ignores junk", () => {
    const s = fakeStore();
    expect(rememberedMobileMode(s)).toBe(null);
    rememberMobileMode("view", s);
    expect(s.m.get(MOBILE_MODE_KEY)).toBe("view");
    expect(rememberedMobileMode(s)).toBe("view");
    rememberMobileMode(null, s);
    expect(rememberedMobileMode(s)).toBe(null);
    expect(rememberedMobileMode(fakeStore({ [MOBILE_MODE_KEY]: "admin" }))).toBe(null);
  });

  it("survives a throwing storage (private mode)", () => {
    const bad: ModeStorage = {
      getItem: () => { throw new Error("nope"); },
      setItem: () => { throw new Error("nope"); },
      removeItem: () => { throw new Error("nope"); },
    };
    expect(rememberedMobileMode(bad)).toBe(null);
    expect(() => rememberMobileMode("edit", bad)).not.toThrow();
  });
});
