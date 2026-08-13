import { describe, expect, it, vi } from "vitest";
import { classifyOwnerJobFailure, observeOwnerJob } from "./owner-job";

describe("classifyOwnerJobFailure", () => {
  it("separates retryable capacity, stale lifetime, and terminal module failures", () => {
    expect(
      classifyOwnerJobFailure(
        Object.assign(new Error("full"), {
          code: "WX_MUTATOR_BACKPRESSURE",
          reason: "jobs",
          estimatedBytes: 16,
          maxBytes: 1024,
        }),
      ),
    ).toBe("backpressure");
    expect(
      classifyOwnerJobFailure(
        Object.assign(new Error("stale"), { code: "WX_MUTATOR_STALE" }),
      ),
    ).toBe("stale");
    expect(
      classifyOwnerJobFailure(
        new Error("[wx-scheduler] shutdown: application is dead"),
      ),
    ).toBe("terminal");
    expect(classifyOwnerJobFailure(new WebAssembly.RuntimeError("unreachable"))).toBe(
      "terminal",
    );
  });

  it("does not retry a payload which cannot fit even an empty owner queue", () => {
    expect(
      classifyOwnerJobFailure(
        Object.assign(new Error("too large"), {
          code: "WX_MUTATOR_BACKPRESSURE",
          reason: "bytes",
          estimatedBytes: 2048,
          maxBytes: 1024,
        }),
      ),
    ).toBe("other");
    expect(classifyOwnerJobFailure(new Error("ordinary apply failure"))).toBe("other");
  });

  it("does not report expected stale-generation cancellation", async () => {
    const report = vi.fn();
    observeOwnerJob(
      "retired controller",
      () =>
        Promise.reject(
          Object.assign(new Error("stale"), { code: "WX_MUTATOR_STALE" }),
        ),
      report,
    );
    await Promise.resolve();
    await Promise.resolve();
    expect(report).not.toHaveBeenCalled();
  });
});
