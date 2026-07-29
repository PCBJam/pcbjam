import { afterEach, describe, expect, it, vi } from "vitest";
import {
  loadSessionIdentity,
  resetSessionIdentityForTest,
  sessionIdentity,
} from "./session-identity";

function mockMe(body: unknown, ok = true) {
  return vi.spyOn(globalThis, "fetch").mockResolvedValue({
    ok,
    json: () => Promise.resolve(body),
  } as Response);
}

afterEach(() => {
  vi.restoreAllMocks();
  resetSessionIdentityForTest();
});

describe("loadSessionIdentity", () => {
  it("resolves the session user (name preferred, slug as id)", async () => {
    const f = mockMe({ user: { slug: "alice", name: "Alice A", email: "a@x.y" } });
    expect(await loadSessionIdentity("http://api")).toEqual({
      slug: "alice",
      name: "Alice A",
      email: "a@x.y",
    });
    expect(sessionIdentity()).toEqual({
      slug: "alice",
      name: "Alice A",
      email: "a@x.y",
    });
    expect(f).toHaveBeenCalledWith("http://api/api/me", {
      credentials: "include",
    });
  });

  it("falls back to email, then slug, for the display name", async () => {
    mockMe({ user: { slug: "bob", name: "", email: "bob@x.y" } });
    expect(await loadSessionIdentity("http://api")).toEqual({
      slug: "bob",
      name: "bob@x.y",
      email: "bob@x.y",
    });
  });

  it("is null for anonymous sessions ({user: null})", async () => {
    mockMe({ user: null, authMode: "open" });
    expect(await loadSessionIdentity("http://api")).toBeNull();
    expect(sessionIdentity()).toBeNull();
  });

  it("is null when the endpoint is missing (example backend / demo)", async () => {
    mockMe({ error: "not found" }, false);
    expect(await loadSessionIdentity("http://api")).toBeNull();
  });

  it("is null on network failure and never throws", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("offline"));
    expect(await loadSessionIdentity("http://api")).toBeNull();
  });

  it("fetches once — concurrent and later callers share the flight", async () => {
    const f = mockMe({ user: { slug: "alice", name: "A", email: "" } });
    await Promise.all([
      loadSessionIdentity("http://api"),
      loadSessionIdentity("http://api"),
    ]);
    await loadSessionIdentity("http://api");
    expect(f).toHaveBeenCalledTimes(1);
  });
});
