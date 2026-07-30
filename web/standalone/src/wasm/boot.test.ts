import { describe, expect, it } from "vitest";
import { hasWritableLib } from "./boot";
import type { LibInfo } from "./libs/source";

const lib = (type?: string): LibInfo => ({ id: `id-${type}`, name: `n-${type}`, type });

describe("hasWritableLib", () => {
  it("sees an example-backend 'user' lib", () => {
    expect(hasWritableLib([[lib("origin"), lib("user")]])).toBe(true);
  });

  it("sees a private-platform 'org' lib (renamed from 'user') — the My Symbols 409", () => {
    expect(hasWritableLib([[lib("origin")], [lib("mirror"), lib("org")]])).toBe(true);
  });

  it("false when only read-only libs are listed", () => {
    expect(hasWritableLib([[lib("origin"), lib("mirror")], [lib(undefined)]])).toBe(false);
  });

  it("false on empty lists", () => {
    expect(hasWritableLib([[], []])).toBe(false);
    expect(hasWritableLib([])).toBe(false);
  });
});
