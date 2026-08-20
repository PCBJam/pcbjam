import { describe, expect, it } from "vitest";
import { shortBuildTag } from "./VersionBadge";

describe("shortBuildTag (version badge display)", () => {
  it("shortens a staging tag's full sha to 7 chars", () => {
    expect(shortBuildTag("staging-75bb0d7e4f2a9c1b8d3e6f0a2b4c6d8e0f1a2b3c")).toBe(
      "staging-75bb0d7",
    );
  });

  it("shortens a bare full sha", () => {
    expect(shortBuildTag("75bb0d7e4f2a9c1b8d3e6f0a2b4c6d8e0f1a2b3c")).toBe("75bb0d7");
  });

  it("leaves release tags and dev untouched", () => {
    expect(shortBuildTag("2.7.7")).toBe("2.7.7");
    expect(shortBuildTag("dev")).toBe("dev");
    // Short hex-ish fragments (< 12 chars) are not treated as hashes.
    expect(shortBuildTag("demo-local")).toBe("demo-local");
    expect(shortBuildTag("beta-abc123")).toBe("beta-abc123");
  });
});
