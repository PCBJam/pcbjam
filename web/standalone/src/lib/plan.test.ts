import { afterEach, describe, expect, it, vi } from "vitest";
import { daysLeft, resetPlanForTest, startProTrial } from "./plan";

afterEach(() => {
  vi.restoreAllMocks();
  resetPlanForTest();
});

describe("daysLeft", () => {
  const now = Date.parse("2026-11-19T12:00:00Z");

  it("counts a started day as a whole one", () => {
    expect(daysLeft("2026-12-03T12:00:00Z", now)).toBe(14);
    expect(daysLeft("2026-12-03T11:00:00Z", now)).toBe(14);
    expect(daysLeft("2026-11-20T18:00:00Z", now)).toBe(2);
  });

  it("is never less than one", () => {
    expect(daysLeft("2026-11-19T12:30:00Z", now)).toBe(1);
    expect(daysLeft("2026-11-18T12:00:00Z", now)).toBe(1);
  });
});

describe("startProTrial", () => {
  it("posts with the session cookie and answers null when the trial started", async () => {
    const f = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue({ ok: true, json: () => Promise.resolve({ endsAt: "x", days: 14 }) } as Response);
    expect(await startProTrial()).toBeNull();
    expect(f.mock.calls[0]![0]).toMatch(/\/api\/billing\/trial$/);
    expect(f.mock.calls[0]![1]).toMatchObject({ method: "POST", credentials: "include", body: "{}" });
  });

  it("answers the backend's reason when it refuses", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: false,
      json: () => Promise.resolve({ message: "You've already had a Pro trial.", code: "trial_used" }),
    } as Response);
    expect(await startProTrial()).toBe("You've already had a Pro trial.");
  });

  it("answers a reason of its own without one, and when the server is away", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce({ ok: false, json: () => Promise.reject(new Error("html")) } as Response);
    expect(await startProTrial()).toMatch(/didn't start/);
    vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(new Error("offline"));
    expect(await startProTrial()).toMatch(/didn't answer/);
  });
});
